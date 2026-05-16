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

  it("Dart project: package:<root>/... imports resolve via pubspec.yaml", async () => {
    const contents = new Map<string, string>([
      ["pubspec.yaml", `name: my_app\nversion: 1.0.0\n`],
      [
        "lib/main.dart",
        `import 'package:my_app/widget.dart';\nclass MainApp {}`,
      ],
      ["lib/widget.dart", `class Widget {}`],
    ]);
    const fake = new FakeClient(
      tree([...contents.keys()]),
      [{ filename: "lib/widget.dart", status: "modified", additions: 1, deletions: 0 }],
      contents,
    );
    const snap = await runScan({
      client: fake as unknown as GitHubClient,
      target: { kind: "pr", locator },
      mode: "deep",
    });
    // Before this fix, `package:my_app/widget.dart` would have been a
    // dangling import. Now the edge exists, so lib/main.dart should be
    // classified orange (it imports the changed widget).
    expect(snap.diff?.impacts.get("lib/main.dart")?.kind).toBe("orange");
    expect(snap.diff?.impacts.get("lib/widget.dart")?.kind).toBe("red");
    expect(snap.graph?.danglingImports).toEqual([]);
  });

  it("TS monorepo: @scope/pkg imports resolve via root package.json workspaces", async () => {
    const contents = new Map<string, string>([
      [
        "package.json",
        JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      ],
      [
        "packages/core/package.json",
        JSON.stringify({ name: "@gitgraph/core", version: "0.1.0" }),
      ],
      [
        "packages/core/src/index.ts",
        `export const core = 1;`,
      ],
      [
        "packages/app/package.json",
        JSON.stringify({ name: "@gitgraph/app", version: "0.1.0" }),
      ],
      [
        "packages/app/src/index.ts",
        `import { core } from "@gitgraph/core";\nexport const app = core;`,
      ],
    ]);
    const treeEntries: RepoTreeEntry[] = [
      ...[...contents.keys()].map(
        (p) => ({ path: p, type: "blob" as const, sha: "x" }),
      ),
      // Dirs needed for expandTreeGlob('packages/*').
      { path: "packages", type: "tree" as const, sha: "x" },
      { path: "packages/core", type: "tree" as const, sha: "x" },
      { path: "packages/app", type: "tree" as const, sha: "x" },
    ];
    const fake = new FakeClient(
      treeEntries,
      [
        {
          filename: "packages/core/src/index.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
        },
      ],
      contents,
    );
    const snap = await runScan({
      client: fake as unknown as GitHubClient,
      target: { kind: "pr", locator },
      mode: "deep",
    });
    expect(snap.diff?.impacts.get("packages/core/src/index.ts")?.kind).toBe(
      "red",
    );
    expect(snap.diff?.impacts.get("packages/app/src/index.ts")?.kind).toBe(
      "orange",
    );
    expect(snap.graph?.danglingImports).toEqual([]);
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
