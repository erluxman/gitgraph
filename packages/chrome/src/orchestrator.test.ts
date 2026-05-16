import { describe, expect, it } from "vitest";
import { GitHubClient } from "./github/client.js";
import type {
  PrChangedFile,
  PrLocator,
  PrMeta,
  RepoTreeEntry,
} from "./github/types.js";
import { runScan } from "./orchestrator.js";

/**
 * Fake client: implements just the GitHubClient surface the orchestrator uses.
 */
class FakeClient {
  constructor(
    private readonly tree: readonly RepoTreeEntry[],
    private readonly changed: readonly PrChangedFile[],
    private readonly contents: ReadonlyMap<string, string>,
  ) {}
  async getPr(_loc: PrLocator): Promise<PrMeta> {
    return {
      head: { ref: "feature", sha: "headsha" },
      base: { ref: "main", sha: "basesha" },
    };
  }
  async listPrFiles(_loc: PrLocator): Promise<readonly PrChangedFile[]> {
    return this.changed;
  }
  async listTree(_loc: PrLocator, _sha: string) {
    return { entries: this.tree, truncated: false };
  }
  async getFileContent(_loc: PrLocator, _sha: string, path: string): Promise<string> {
    const v = this.contents.get(path);
    if (v === undefined) throw new Error("404 not found");
    return v;
  }
  async compareCommits(_loc: PrLocator, _base: string, head: string) {
    return {
      files: this.changed,
      mergeBaseSha: "mergebase",
      headSha: head,
    };
  }
}

const locator: PrLocator = { owner: "o", repo: "r", pull: 1 };

function tree(paths: readonly string[]): readonly RepoTreeEntry[] {
  return paths.map((p) => ({ path: p, type: "blob" as const, sha: "x" }));
}

describe("runScan", () => {
  it("light scan: red files come back classified with their orange consumers", async () => {
    const contents = new Map<string, string>([
      ["src/auth.ts", `export function login() {}`],
      ["src/api.ts", `import { login } from "./auth"; export const x = login();`],
      ["src/page.ts", `import { x } from "./api"; export const p = x;`],
      ["src/unrelated.ts", `export const z = 1;`],
    ]);
    const fake = new FakeClient(
      tree([...contents.keys()]),
      [{ filename: "src/auth.ts", status: "modified", additions: 1, deletions: 0 }],
      contents,
    );

    const snap = await runScan({
      client: fake as unknown as GitHubClient,
      target: { kind: "pr", locator },
      mode: "light",
    });

    expect(snap.phase).toBe("done");
    expect(snap.changedFiles).toEqual(["src/auth.ts"]);
    expect(snap.diff?.impacts.get("src/auth.ts")?.kind).toBe("red");
    expect(snap.diff?.impacts.get("src/api.ts")?.kind).toBe("orange");
    expect(snap.diff?.impacts.get("src/page.ts")?.kind).toBe("orange");
    expect(snap.diff?.impacts.get("src/unrelated.ts")?.kind).toBe("green");
  });

  it("deep scan: parses every source file in the tree", async () => {
    const contents = new Map<string, string>([
      ["src/a.ts", `import "./b";`],
      ["src/b.ts", `export const b = 1;`],
      ["src/c.ts", `export const c = 1;`],
    ]);
    const fake = new FakeClient(
      tree([...contents.keys()]),
      [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
      contents,
    );

    const snap = await runScan({
      client: fake as unknown as GitHubClient,
      target: { kind: "pr", locator },
      mode: "deep",
    });

    expect(snap.repo.files.size).toBe(3);
  });

  it("emits progress snapshots in order", async () => {
    const phases: string[] = [];
    const fake = new FakeClient(
      tree(["src/a.ts"]),
      [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
      new Map([["src/a.ts", `export const a = 1;`]]),
    );
    await runScan({
      client: fake as unknown as GitHubClient,
      target: { kind: "pr", locator },
      mode: "light",
      emit(snap) {
        if (phases[phases.length - 1] !== snap.phase) phases.push(snap.phase);
      },
    });
    expect(phases[0]).toBe("loading-pr");
    expect(phases[phases.length - 1]).toBe("done");
    // No duplicate or out-of-order transitions.
    expect(phases.includes("scoring")).toBe(true);
  });

  it("compare target: classifies files from compare endpoint as red", async () => {
    const contents = new Map<string, string>([
      ["src/x.ts", `export const x = 1;`],
      ["src/y.ts", `import "./x"; export const y = 1;`],
    ]);
    const fake = new FakeClient(
      tree([...contents.keys()]),
      [{ filename: "src/x.ts", status: "modified", additions: 1, deletions: 0 }],
      contents,
    );
    const snap = await runScan({
      client: fake as unknown as GitHubClient,
      target: { kind: "compare", locator, base: "main", head: "feature" },
      mode: "deep",
    });
    expect(snap.diff?.impacts.get("src/x.ts")?.kind).toBe("red");
    expect(snap.diff?.impacts.get("src/y.ts")?.kind).toBe("orange");
  });

  it("snapshot target: no changed files, all green", async () => {
    const contents = new Map<string, string>([
      ["src/a.ts", `export const a = 1;`],
      ["src/b.ts", `import "./a"; export const b = 1;`],
    ]);
    const fake = new FakeClient(tree([...contents.keys()]), [], contents);
    const snap = await runScan({
      client: fake as unknown as GitHubClient,
      target: { kind: "snapshot", locator, ref: "main" },
      mode: "deep",
    });
    expect(snap.changedFiles).toEqual([]);
    expect(snap.diff?.impacts.get("src/a.ts")?.kind).toBe("green");
    expect(snap.diff?.impacts.get("src/b.ts")?.kind).toBe("green");
    expect(snap.repo.files.size).toBe(2);
  });

  it("aborts mid-scan when the signal is triggered", async () => {
    const fake = new FakeClient(
      tree([]),
      [],
      new Map(),
    );
    const aborter = new AbortController();
    aborter.abort();
    await expect(
      runScan({
        client: fake as unknown as GitHubClient,
        target: { kind: "pr", locator },
        mode: "light",
        signal: aborter.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
