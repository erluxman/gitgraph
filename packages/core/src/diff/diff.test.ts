import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/builder.js";
import { parseFile } from "../parser/index.js";
import type { ParsedFile, ParsedRepo } from "../types.js";
import { analyseDiff, orangeOpacity } from "./index.js";

function repo(files: Record<string, string>): ParsedRepo {
  const out = new Map<string, ParsedFile>();
  for (const [path, source] of Object.entries(files)) {
    out.set(path, parseFile(path, source, "typescript"));
  }
  return { files: out };
}

describe("analyseDiff", () => {
  it("marks changed files red and unaffected files green", () => {
    const graph = buildGraph({
      repo: repo({
        "src/a.ts": ``,
        "src/b.ts": ``,
        "src/c.ts": ``,
      }),
    });
    const result = analyseDiff({ graph, changedFiles: ["src/a.ts"] });
    expect(result.impacts.get("src/a.ts")?.kind).toBe("red");
    expect(result.impacts.get("src/b.ts")?.kind).toBe("green");
    expect(result.impacts.get("src/c.ts")?.kind).toBe("green");
  });

  it("marks transitive consumers orange", () => {
    // d depends on c depends on b depends on a.
    // Change a → b/c/d are all orange.
    const graph = buildGraph({
      repo: repo({
        "a.ts": ``,
        "b.ts": `import "./a";`,
        "c.ts": `import "./b";`,
        "d.ts": `import "./c";`,
      }),
    });
    const result = analyseDiff({ graph, changedFiles: ["a.ts"] });
    expect(result.impacts.get("a.ts")?.kind).toBe("red");
    expect(result.impacts.get("b.ts")?.kind).toBe("orange");
    expect(result.impacts.get("c.ts")?.kind).toBe("orange");
    expect(result.impacts.get("d.ts")?.kind).toBe("orange");
  });

  it("assigns distance and opacity per SPEC", () => {
    const graph = buildGraph({
      repo: repo({
        "a.ts": ``,
        "b.ts": `import "./a";`,
        "c.ts": `import "./b";`,
        "d.ts": `import "./c";`,
        "e.ts": `import "./d";`,
        "f.ts": `import "./e";`,
      }),
    });
    const result = analyseDiff({ graph, changedFiles: ["a.ts"] });
    expect(result.impacts.get("b.ts")?.distance).toBe(1);
    expect(result.impacts.get("b.ts")?.opacity).toBeCloseTo(1.0);
    expect(result.impacts.get("c.ts")?.distance).toBe(2);
    expect(result.impacts.get("c.ts")?.opacity).toBeCloseTo(0.8);
    expect(result.impacts.get("e.ts")?.distance).toBe(4);
    expect(result.impacts.get("e.ts")?.opacity).toBeCloseTo(0.4);
    expect(result.impacts.get("f.ts")?.distance).toBe(5);
    expect(result.impacts.get("f.ts")?.opacity).toBeCloseTo(0.2);
  });

  it("treats a changed leaf file as red-only (no orange)", () => {
    const graph = buildGraph({
      repo: repo({
        "leaf.ts": ``,
        "other.ts": ``,
      }),
    });
    const result = analyseDiff({ graph, changedFiles: ["leaf.ts"] });
    expect(result.impacts.get("leaf.ts")?.kind).toBe("red");
    expect(result.impacts.get("other.ts")?.kind).toBe("green");
  });

  it("a changed core file makes everything orange", () => {
    const graph = buildGraph({
      repo: repo({
        "core.ts": ``,
        "a.ts": `import "./core";`,
        "b.ts": `import "./core";`,
        "c.ts": `import "./a";`,
      }),
    });
    const result = analyseDiff({ graph, changedFiles: ["core.ts"] });
    expect(result.impacts.get("a.ts")?.kind).toBe("orange");
    expect(result.impacts.get("b.ts")?.kind).toBe("orange");
    expect(result.impacts.get("c.ts")?.kind).toBe("orange");
  });

  it("includes unknown changed files as red", () => {
    const graph = buildGraph({ repo: repo({ "a.ts": `` }) });
    const result = analyseDiff({
      graph,
      changedFiles: ["a.ts", "deleted.ts"],
    });
    expect(result.changedUnknown).toEqual(["deleted.ts"]);
    expect(result.impacts.get("deleted.ts")?.kind).toBe("red");
  });
});

describe("orangeOpacity", () => {
  it("matches SPEC fade table", () => {
    expect(orangeOpacity(1)).toBe(1.0);
    expect(orangeOpacity(2)).toBe(0.8);
    expect(orangeOpacity(3)).toBe(0.6);
    expect(orangeOpacity(4)).toBe(0.4);
    expect(orangeOpacity(5)).toBe(0.2);
    expect(orangeOpacity(99)).toBe(0.2);
  });
});
