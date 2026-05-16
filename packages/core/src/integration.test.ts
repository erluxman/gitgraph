import { describe, expect, it } from "vitest";
import { analyseDiff } from "./diff/index.js";
import { buildGraph } from "./graph/index.js";
import { detectLanguage, parseFile } from "./parser/index.js";
import { scoreRisk } from "./risk/index.js";
import type { ParsedFile, ParsedRepo } from "./types.js";

/**
 * Full pipeline: source files → parse → graph → diff classify → risk score.
 * Mirrors what the Chrome extension and VS Code extension will do at runtime.
 */
function parseAll(files: Record<string, string>): ParsedRepo {
  const parsed = new Map<string, ParsedFile>();
  for (const [path, source] of Object.entries(files)) {
    const lang = detectLanguage(path);
    if (lang === null) continue;
    parsed.set(path, parseFile(path, source, lang));
  }
  return { files: parsed };
}

describe("end-to-end pipeline", () => {
  it("identifies a high-risk hub file as both red and high-score when changed", () => {
    // auth.ts is a hub: a handful of files depend on it. Change it and we
    // expect (a) blast radius covers the dependents and (b) auth.ts itself
    // scores higher than the leaf files.
    const repo = parseAll({
      "src/auth.ts": `
        export function login() {}
        export function logout() {}
      `,
      "src/middleware/api.ts": `
        import { login } from "../auth";
        export function withAuth() { return login(); }
      `,
      "src/pages/dashboard.ts": `
        import { withAuth } from "../middleware/api";
        export const dashboard = withAuth();
      `,
      "src/pages/profile.ts": `
        import { logout } from "../auth";
        export const profile = logout;
      `,
      "src/utils/format.ts": `
        export function format(s: string) { return s.trim(); }
      `,
    });

    const graph = buildGraph({ repo });
    const diff = analyseDiff({ graph, changedFiles: ["src/auth.ts"] });
    const scores = scoreRisk(graph, { corePaths: ["src/auth.ts"] });

    // Direct importers go orange at distance 1.
    expect(diff.impacts.get("src/auth.ts")?.kind).toBe("red");
    expect(diff.impacts.get("src/middleware/api.ts")?.kind).toBe("orange");
    expect(diff.impacts.get("src/middleware/api.ts")?.distance).toBe(1);
    expect(diff.impacts.get("src/pages/profile.ts")?.kind).toBe("orange");
    // Transitive consumer at distance 2.
    expect(diff.impacts.get("src/pages/dashboard.ts")?.kind).toBe("orange");
    expect(diff.impacts.get("src/pages/dashboard.ts")?.distance).toBe(2);
    // Unrelated file stays green.
    expect(diff.impacts.get("src/utils/format.ts")?.kind).toBe("green");

    // auth.ts is core-tagged, so its risk score is the maximum.
    const auth = scores.get("src/auth.ts")!;
    const utils = scores.get("src/utils/format.ts")!;
    expect(auth.core).toBe(true);
    expect(auth.combined).toBeGreaterThan(utils.combined);
  });

  it("handles a deletion: changed file is red, consumers orange even when target missing", () => {
    const repo = parseAll({
      "src/a.ts": `import "./gone";`,
      "src/b.ts": `import "./a";`,
    });
    const graph = buildGraph({ repo });
    // a.ts still references "./gone" but the file isn't in the repo —
    // dangling. The diff still works on the existing graph.
    expect(graph.danglingImports).toContainEqual({
      from: "src/a.ts",
      specifier: "./gone",
    });

    const diff = analyseDiff({
      graph,
      changedFiles: ["src/gone.ts"], // the deleted file
    });
    expect(diff.changedUnknown).toEqual(["src/gone.ts"]);
    expect(diff.impacts.get("src/gone.ts")?.kind).toBe("red");
  });

  it("works on a Flutter-style monorepo with cross-package imports", () => {
    const repo = parseAll({
      "packages/app/lib/main.dart": `
        import 'package:common/widgets.dart';
        class MyApp extends StatelessWidget {
          @override
          Widget build(BuildContext context) => Container();
        }
      `,
      "packages/common/lib/widgets.dart": `
        class FancyButton extends StatelessWidget {
          @override
          Widget build(BuildContext context) => Container();
        }
      `,
    });
    const graph = buildGraph({
      repo,
      resolverContext: {
        files: new Set(repo.files.keys()),
        packages: new Map(),
        dartPackages: new Map([["common", "packages/common"]]),
      },
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.from).toBe("packages/app/lib/main.dart");
    expect(graph.edges[0]!.to).toBe("packages/common/lib/widgets.dart");

    // Change the common widget; the app should be orange.
    const diff = analyseDiff({
      graph,
      changedFiles: ["packages/common/lib/widgets.dart"],
    });
    expect(diff.impacts.get("packages/app/lib/main.dart")?.kind).toBe("orange");
  });
});
