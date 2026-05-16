import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/builder.js";
import { parseFile } from "../parser/index.js";
import type { ParsedFile, ParsedRepo } from "../types.js";
import { forwardClosure, reverseClosure } from "./index.js";

function repo(files: Record<string, string>): ParsedRepo {
  const out = new Map<string, ParsedFile>();
  for (const [path, source] of Object.entries(files)) {
    out.set(path, parseFile(path, source, "typescript"));
  }
  return { files: out };
}

describe("reverseClosure", () => {
  it("returns 0 distance for seed files", () => {
    const graph = buildGraph({ repo: repo({ "a.ts": `` }) });
    const d = reverseClosure(graph, ["a.ts"]);
    expect(d.get("a.ts")).toBe(0);
  });

  it("computes BFS distances along reverse edges", () => {
    // a → b → c → d   (a imports b imports c imports d)
    // Reverse closure from d: d=0, c=1, b=2, a=3.
    const graph = buildGraph({
      repo: repo({
        "a.ts": `import "./b";`,
        "b.ts": `import "./c";`,
        "c.ts": `import "./d";`,
        "d.ts": ``,
      }),
    });
    const d = reverseClosure(graph, ["d.ts"]);
    expect(d.get("d.ts")).toBe(0);
    expect(d.get("c.ts")).toBe(1);
    expect(d.get("b.ts")).toBe(2);
    expect(d.get("a.ts")).toBe(3);
  });

  it("takes the minimum distance across multiple seeds", () => {
    //   b
    //   ↑
    //   a → c → d
    // From {a, c}: a=0, b=1, c=0, d=1.
    const graph = buildGraph({
      repo: repo({
        "a.ts": ``,
        "b.ts": `import "./a";`,
        "c.ts": `import "./a";`,
        "d.ts": `import "./c";`,
      }),
    });
    const d = reverseClosure(graph, ["a.ts", "c.ts"]);
    expect(d.get("a.ts")).toBe(0);
    expect(d.get("c.ts")).toBe(0);
    expect(d.get("b.ts")).toBe(1);
    expect(d.get("d.ts")).toBe(1);
  });
});

describe("forwardClosure", () => {
  it("computes BFS distances along outgoing edges", () => {
    const graph = buildGraph({
      repo: repo({
        "a.ts": `import "./b";`,
        "b.ts": `import "./c";`,
        "c.ts": ``,
      }),
    });
    const d = forwardClosure(graph, ["a.ts"]);
    expect(d.get("a.ts")).toBe(0);
    expect(d.get("b.ts")).toBe(1);
    expect(d.get("c.ts")).toBe(2);
  });

  it("is cycle-safe", () => {
    const graph = buildGraph({
      repo: repo({
        "a.ts": `import "./b";`,
        "b.ts": `import "./a";`,
      }),
    });
    const d = forwardClosure(graph, ["a.ts"]);
    expect(d.get("a.ts")).toBe(0);
    expect(d.get("b.ts")).toBe(1);
  });
});
