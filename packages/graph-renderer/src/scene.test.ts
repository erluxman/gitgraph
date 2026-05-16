import {
  analyseDiff,
  buildGraph,
  parseFile,
  scoreRisk,
  type ParsedFile,
  type ParsedRepo,
} from "@gitgraph/core";
import { describe, expect, it } from "vitest";
import { buildSceneFromCore, buildSkeletonScene } from "./scene.js";

function repo(files: Record<string, string>): ParsedRepo {
  const out = new Map<string, ParsedFile>();
  for (const [path, source] of Object.entries(files)) {
    out.set(path, parseFile(path, source, "typescript"));
  }
  return { files: out };
}

describe("buildSceneFromCore", () => {
  it("produces one node per file and one edge per directed import", () => {
    const r = repo({
      "src/a.ts": `import "./b"; export const a = 1;`,
      "src/b.ts": `import "./c"; export const b = 1;`,
      "src/c.ts": `export const c = 1;`,
    });
    const graph = buildGraph({ repo: r });
    const diff = analyseDiff({ graph, changedFiles: ["src/a.ts"] });
    const risk = scoreRisk(graph);

    const scene = buildSceneFromCore({ graph, diff, risk });

    expect(scene.nodes).toHaveLength(3);
    expect(scene.edges).toHaveLength(2);
    expect(scene.nodes.find((n) => n.path === "src/a.ts")?.impact).toBe("red");
    expect(scene.nodes.find((n) => n.path === "src/b.ts")?.impact).toBe("green");
  });

  it("carries display metadata: folder, basename, export count", () => {
    const r = repo({
      "src/utils/format.ts": `export function a() {} export function b() {} export const C = 1;`,
    });
    const graph = buildGraph({ repo: r });
    const diff = analyseDiff({ graph, changedFiles: [] });
    const risk = scoreRisk(graph);

    const scene = buildSceneFromCore({ graph, diff, risk });
    const node = scene.nodes[0]!;
    expect(node.folder).toBe("src/utils");
    expect(node.displayName).toBe("format.ts");
    expect(node.exportCount).toBe(3);
  });

  it("marks corePaths via the corePaths set", () => {
    const r = repo({ "src/auth.ts": `export const a = 1;` });
    const graph = buildGraph({ repo: r });
    const diff = analyseDiff({ graph, changedFiles: [] });
    const risk = scoreRisk(graph);

    const scene = buildSceneFromCore({
      graph,
      diff,
      risk,
      corePaths: new Set(["src/auth.ts"]),
    });
    expect(scene.nodes[0]!.core).toBe(true);
  });
});

describe("buildSkeletonScene", () => {
  it("marks changed paths red and the rest green, with no edges", () => {
    const scene = buildSkeletonScene({
      sourcePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      changedPaths: ["src/a.ts"],
    });
    expect(scene.edges).toEqual([]);
    const byPath = new Map(scene.nodes.map((n) => [n.path, n]));
    expect(byPath.get("src/a.ts")?.impact).toBe("red");
    expect(byPath.get("src/b.ts")?.impact).toBe("green");
    expect(byPath.get("src/c.ts")?.impact).toBe("green");
  });

  it("includes changed paths even when they aren't in the tree (deleted files)", () => {
    const scene = buildSkeletonScene({
      sourcePaths: ["src/keep.ts"],
      changedPaths: ["src/keep.ts", "src/deleted.ts"],
    });
    const paths = scene.nodes.map((n) => n.path).sort();
    expect(paths).toEqual(["src/deleted.ts", "src/keep.ts"]);
    expect(scene.nodes.find((n) => n.path === "src/deleted.ts")?.impact).toBe("red");
  });

  it("respects core path tagging", () => {
    const scene = buildSkeletonScene({
      sourcePaths: ["src/auth.ts", "src/utils.ts"],
      changedPaths: [],
      corePaths: new Set(["src/auth.ts"]),
    });
    expect(scene.nodes.find((n) => n.path === "src/auth.ts")?.core).toBe(true);
    expect(scene.nodes.find((n) => n.path === "src/utils.ts")?.core).toBe(false);
  });
});
