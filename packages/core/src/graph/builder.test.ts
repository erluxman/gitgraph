import { describe, expect, it } from "vitest";
import { parseFile } from "../parser/index.js";
import type { ParsedFile, ParsedRepo } from "../types.js";
import { buildGraph } from "./builder.js";
import {
  getDependencies,
  getImporters,
  transitiveDependencies,
  transitiveImporters,
} from "./query.js";

/**
 * Helper: parse a synthetic repo from a map of path → source.
 * Language is inferred from extension.
 */
function repoFromSources(files: Record<string, string>): ParsedRepo {
  const out = new Map<string, ParsedFile>();
  for (const [path, source] of Object.entries(files)) {
    const lang = path.endsWith(".dart")
      ? "dart"
      : path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")
        ? "javascript"
        : "typescript";
    out.set(path, parseFile(path, source, lang));
  }
  return { files: out };
}

describe("buildGraph", () => {
  it("creates an edge for a simple A → B import", () => {
    const repo = repoFromSources({
      "src/a.ts": `import { x } from "./b";`,
      "src/b.ts": `export const x = 1;`,
    });
    const graph = buildGraph({ repo });

    expect(getDependencies(graph, "src/a.ts")).toEqual(["src/b.ts"]);
    expect(getImporters(graph, "src/b.ts")).toEqual(["src/a.ts"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.danglingImports).toEqual([]);
  });

  it("computes transitive dependencies for A → B → C", () => {
    const repo = repoFromSources({
      "src/a.ts": `import "./b";`,
      "src/b.ts": `import "./c";`,
      "src/c.ts": `export const c = 1;`,
    });
    const graph = buildGraph({ repo });

    const deps = transitiveDependencies(graph, "src/a.ts");
    expect([...deps].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

    const importers = transitiveImporters(graph, "src/c.ts");
    expect([...importers].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("handles circular imports without infinite loop", () => {
    const repo = repoFromSources({
      "src/a.ts": `import "./b";`,
      "src/b.ts": `import "./a";`,
    });
    const graph = buildGraph({ repo });

    const aDeps = transitiveDependencies(graph, "src/a.ts");
    expect([...aDeps].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("drops self-imports", () => {
    const repo = repoFromSources({
      "src/a.ts": `import "./a";`,
    });
    const graph = buildGraph({ repo });
    expect(graph.edges).toEqual([]);
  });

  it("records dangling imports for missing targets", () => {
    const repo = repoFromSources({
      "src/a.ts": `import "./missing";`,
    });
    const graph = buildGraph({ repo });
    expect(graph.danglingImports).toEqual([
      { from: "src/a.ts", specifier: "./missing" },
    ]);
  });

  it("deduplicates multiple imports of the same target", () => {
    const repo = repoFromSources({
      "src/a.ts": `import { x } from "./b"; import type { y } from "./b";`,
      "src/b.ts": `export const x = 1; export type y = number;`,
    });
    const graph = buildGraph({ repo });
    expect(graph.edges).toHaveLength(1);
  });

  it("supports cross-package monorepo imports", () => {
    const repo = repoFromSources({
      "packages/core/src/index.ts": `export const core = 1;`,
      "packages/chrome/src/x.ts": `import { core } from "@gitgraph/core";`,
    });
    const graph = buildGraph({
      repo,
      resolverContext: {
        files: new Set(repo.files.keys()),
        packages: new Map([["@gitgraph/core", "packages/core"]]),
        dartPackages: new Map(),
      },
    });
    expect(getDependencies(graph, "packages/chrome/src/x.ts")).toEqual([
      "packages/core/src/index.ts",
    ]);
  });

  it("inverts direction for Dart 'part of' directives", () => {
    const repo = repoFromSources({
      "lib/main.dart": `part 'helper.dart';\nclass Main {}`,
      "lib/helper.dart": `part of 'main.dart';\nclass Helper {}`,
    });
    const graph = buildGraph({ repo });
    // main.dart should have an edge to helper.dart from both directives.
    expect(getDependencies(graph, "lib/main.dart")).toEqual(["lib/helper.dart"]);
  });
});
