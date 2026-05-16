import { describe, expect, it } from "vitest";
import { parseTypeScript } from "./typescript.js";

describe("parseTypeScript: TS files", () => {
  it("extracts exported functions, classes, and variables", () => {
    const src = `
      export function add(a: number, b: number) { return a + b; }
      export class Foo { hello() {} bye() {} }
      export const PI = 3.14;
      export let mutable = 1;
    `;
    const parsed = parseTypeScript("src/foo.ts", src);
    const names = parsed.exports.map((e) => `${e.kind}:${e.name}`).sort();
    expect(names).toEqual(["class:Foo", "function:add", "variable:PI", "variable:mutable"]);

    const fooClass = parsed.exports.find((e) => e.name === "Foo");
    expect(fooClass?.methods).toEqual(["hello", "bye"]);
  });

  it("returns no exports for a file with only locals", () => {
    const src = `
      function helper() {}
      const x = 1;
      class Internal {}
    `;
    const parsed = parseTypeScript("src/internal.ts", src);
    expect(parsed.exports).toHaveLength(0);
  });

  it("captures static imports", () => {
    const src = `
      import { foo } from "./foo";
      import bar from "../bar";
      import * as ns from "pkg";
      import "side-effect";
    `;
    const parsed = parseTypeScript("src/x.ts", src);
    const specs = parsed.imports.map((i) => i.specifier).sort();
    expect(specs).toEqual(["../bar", "./foo", "pkg", "side-effect"]);
    for (const imp of parsed.imports) {
      expect(imp.kind).toBe("static");
    }
  });

  it("captures dynamic import() with string literal", () => {
    const src = `const mod = await import("./lazy");`;
    const parsed = parseTypeScript("src/x.ts", src);
    expect(parsed.imports).toEqual([
      { kind: "dynamic", specifier: "./lazy", line: 1 },
    ]);
  });

  it("skips dynamic import() with computed argument", () => {
    const src = `
      const name = "./lazy";
      const mod = await import(name);
      const tmpl = await import(\`./\${name}\`);
    `;
    const parsed = parseTypeScript("src/x.ts", src);
    expect(parsed.imports).toEqual([]);
  });

  it("captures re-exports", () => {
    const src = `
      export { foo, bar } from "./src/things";
      export * from "./other";
      export { default as Baz } from "./baz";
    `;
    const parsed = parseTypeScript("src/x.ts", src);
    const specs = parsed.imports.map((i) => i.specifier).sort();
    expect(specs).toEqual(["./baz", "./other", "./src/things"]);
    for (const imp of parsed.imports) {
      expect(imp.kind).toBe("reexport");
    }
  });

  it("captures export { foo } as exported local names", () => {
    const src = `
      function privateFn() {}
      const helper = 1;
      export { privateFn, helper };
    `;
    const parsed = parseTypeScript("src/x.ts", src);
    const names = parsed.exports.map((e) => e.name).sort();
    expect(names).toEqual(["helper", "privateFn"]);
  });

  it("captures export default function", () => {
    const src = `export default function greet() {}`;
    const parsed = parseTypeScript("src/x.ts", src);
    expect(parsed.exports).toEqual([
      { kind: "function", name: "greet", line: 1 },
    ]);
  });

  it("captures export default unnamed function as 'default'", () => {
    const src = `export default function () {}`;
    const parsed = parseTypeScript("src/x.ts", src);
    expect(parsed.exports[0]?.name).toBe("default");
  });
});

describe("parseTypeScript: JS files", () => {
  it("captures require() calls with string literals", () => {
    const src = `
      const x = require("./x");
      const { y } = require("y");
      const dynamic = require(varName); // skipped
    `;
    const parsed = parseTypeScript("src/x.js", src, "javascript");
    const specs = parsed.imports.map((i) => i.specifier).sort();
    expect(specs).toEqual(["./x", "y"]);
  });

  it("captures module.exports.foo = ... as exported variable", () => {
    const src = `
      module.exports.greet = function () {};
      module.exports.NAME = "hello";
    `;
    const parsed = parseTypeScript("src/x.js", src, "javascript");
    const names = parsed.exports.map((e) => e.name).sort();
    expect(names).toEqual(["NAME", "greet"]);
  });

  it("captures module.exports = { a, b } object literal", () => {
    const src = `
      function a() {}
      const b = 1;
      module.exports = { a, b };
    `;
    const parsed = parseTypeScript("src/x.js", src, "javascript");
    const names = parsed.exports.map((e) => e.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("captures exports.foo = ... as exported variable", () => {
    const src = `exports.foo = 1; exports.bar = function () {};`;
    const parsed = parseTypeScript("src/x.js", src, "javascript");
    const names = parsed.exports.map((e) => e.name).sort();
    expect(names).toEqual(["bar", "foo"]);
  });

  it("handles a circular-self-import-ish file without infinite loop", () => {
    const src = `import x from "./x";`;
    const parsed = parseTypeScript("src/x.ts", src);
    expect(parsed.imports.map((i) => i.specifier)).toEqual(["./x"]);
  });

  it("captures correct line numbers", () => {
    const src = "\n\nimport foo from './foo';\n\nexport function bar() {}\n";
    const parsed = parseTypeScript("src/x.ts", src);
    expect(parsed.imports[0]?.line).toBe(3);
    expect(parsed.exports[0]?.line).toBe(5);
  });
});
