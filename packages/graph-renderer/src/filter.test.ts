import {
  buildGraph,
  parseFile,
  type ParsedFile,
  type ParsedRepo,
} from "@gitgraph/core";
import { describe, expect, it } from "vitest";
import { applyFilter, parseFilter, type FilterContext } from "./filter.js";
import { buildSceneFromCore } from "./scene.js";
import type { SceneNode } from "./types.js";

function repo(files: Record<string, string>): ParsedRepo {
  const out = new Map<string, ParsedFile>();
  for (const [path, source] of Object.entries(files)) {
    out.set(path, parseFile(path, source, "typescript"));
  }
  return { files: out };
}

function makeCtx(): FilterContext {
  const r = repo({
    "src/auth/login.ts": `export function login() {}`,
    "src/auth/logout.ts": `export function logout() {}`,
    "src/pages/home.ts": `import { login } from "../auth/login"; export const home = login;`,
    "src/utils/format.ts": `export function format(s: string) { return s; }`,
  });
  const graph = buildGraph({ repo: r });
  const scene = buildSceneFromCore({
    graph,
    diff: {
      impacts: new Map(),
      changedKnown: [],
      changedUnknown: [],
    },
    risk: new Map(
      [...r.files.keys()].map((p) => [
        p,
        {
          path: p,
          pageRank: 0,
          inDegree: 0,
          core: false,
          combined: p.includes("login") ? 0.8 : 0.2,
        },
      ]),
    ),
    corePaths: new Set(["src/auth/login.ts"]),
  });
  return {
    nodes: scene.nodes,
    filesByPath: r.files,
    incoming: graph.incoming,
  };
}

describe("parseFilter", () => {
  it("parses plain text into a text filter", () => {
    expect(parseFilter("auth")).toEqual({ kind: "text", query: "auth" });
  });

  it("parses folder: prefix", () => {
    expect(parseFilter("folder:src/auth")).toEqual({
      kind: "folder",
      prefix: "src/auth",
    });
  });

  it("parses imports: target", () => {
    expect(parseFilter("imports:src/auth/login.ts")).toEqual({
      kind: "imports",
      target: "src/auth/login.ts",
    });
  });

  it("parses risk:>0.5", () => {
    expect(parseFilter("risk:>0.5")).toEqual({
      kind: "risk",
      op: ">",
      value: 0.5,
    });
  });

  it("parses core:true", () => {
    expect(parseFilter("core:true")).toEqual({ kind: "core", value: true });
  });

  it("returns null for empty input", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("   ")).toBeNull();
  });
});

describe("applyFilter", () => {
  it("text filter matches by filename", () => {
    const ctx = makeCtx();
    const res = applyFilter({ kind: "text", query: "login" }, ctx);
    expect(idsOf(ctx.nodes, res)).toContain("src/auth/login.ts");
  });

  it("text filter matches by export name", () => {
    const ctx = makeCtx();
    const res = applyFilter({ kind: "text", query: "format" }, ctx);
    expect(idsOf(ctx.nodes, res)).toContain("src/utils/format.ts");
  });

  it("folder filter matches files in subtree", () => {
    const ctx = makeCtx();
    const res = applyFilter({ kind: "folder", prefix: "src/auth" }, ctx);
    expect([...res].sort()).toEqual([
      "src/auth/login.ts",
      "src/auth/logout.ts",
    ]);
  });

  it("imports filter finds transitive consumers", () => {
    const ctx = makeCtx();
    const res = applyFilter(
      { kind: "imports", target: "src/auth/login.ts" },
      ctx,
    );
    expect([...res]).toContain("src/pages/home.ts");
  });

  it("risk filter respects threshold", () => {
    const ctx = makeCtx();
    const res = applyFilter({ kind: "risk", op: ">", value: 0.5 }, ctx);
    expect([...res]).toEqual(["src/auth/login.ts"]);
  });

  it("core filter matches core-tagged files", () => {
    const ctx = makeCtx();
    const res = applyFilter({ kind: "core", value: true }, ctx);
    expect([...res]).toEqual(["src/auth/login.ts"]);
  });
});

function idsOf(
  _nodes: readonly SceneNode[],
  res: ReadonlySet<string>,
): readonly string[] {
  return [...res];
}
