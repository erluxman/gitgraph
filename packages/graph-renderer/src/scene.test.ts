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

describe("scene blame-chain invariant", () => {
  // Mirror of the core-level check, run on the Scene the renderer
  // actually consumes. The blame-chain hover BFS uses each node's
  // `distance` to decide where to walk; if any orange scene node lacks
  // an outgoing edge to a node with distance − 1, the highlight will
  // dead-end and the user sees an unexplained yellow file.
  function assertSceneGradient(scene: ReturnType<typeof buildSceneFromCore>): void {
    const byId = new Map(scene.nodes.map((n) => [n.id, n]));
    const outgoing = new Map<string, Set<string>>();
    for (const e of scene.edges) {
      const s = typeof e.source === "string" ? e.source : e.source.id;
      const t = typeof e.target === "string" ? e.target : e.target.id;
      let set = outgoing.get(s);
      if (set === undefined) {
        set = new Set();
        outgoing.set(s, set);
      }
      set.add(t);
    }
    for (const node of scene.nodes) {
      if (node.impact !== "orange") continue;
      const outs = outgoing.get(node.id);
      if (outs === undefined || outs.size === 0) {
        throw new Error(
          `orange scene node ${node.id} (distance ${node.distance}) has no outgoing edges`,
        );
      }
      const downhill = [...outs].some((nbrId) => {
        const nbr = byId.get(nbrId);
        return nbr !== undefined && nbr.distance === node.distance - 1;
      });
      if (!downhill) {
        const debug = [...outs]
          .map((id) => `${id}=${byId.get(id)?.distance ?? "?"}`)
          .join(", ");
        throw new Error(
          `orange scene node ${node.id} (distance ${node.distance}) has no neighbour at distance ${node.distance - 1}. neighbours: ${debug}`,
        );
      }
    }
  }

  it("holds on a chain", () => {
    const r = repo({
      "a.ts": ``,
      "b.ts": `import "./a";`,
      "c.ts": `import "./b";`,
      "d.ts": `import "./c";`,
    });
    const graph = buildGraph({ repo: r });
    const diff = analyseDiff({ graph, changedFiles: ["a.ts"] });
    const risk = scoreRisk(graph);
    const scene = buildSceneFromCore({ graph, diff, risk });
    expect(() => assertSceneGradient(scene)).not.toThrow();
  });

  it("holds on a diamond", () => {
    const r = repo({
      "core.ts": ``,
      "left.ts": `import "./core";`,
      "right.ts": `import "./core";`,
      "top.ts": `import "./left"; import "./right";`,
    });
    const graph = buildGraph({ repo: r });
    const diff = analyseDiff({ graph, changedFiles: ["core.ts"] });
    const risk = scoreRisk(graph);
    const scene = buildSceneFromCore({ graph, diff, risk });
    expect(() => assertSceneGradient(scene)).not.toThrow();
  });

  it("holds when several files change at once", () => {
    const r = repo({
      "a.ts": ``,
      "b.ts": ``,
      "x.ts": `import "./a";`,
      "y.ts": `import "./b";`,
      "z.ts": `import "./x"; import "./y";`,
    });
    const graph = buildGraph({ repo: r });
    const diff = analyseDiff({ graph, changedFiles: ["a.ts", "b.ts"] });
    const risk = scoreRisk(graph);
    const scene = buildSceneFromCore({ graph, diff, risk });
    expect(() => assertSceneGradient(scene)).not.toThrow();
  });
});
