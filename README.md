# gitGraph

Visual diff analysis for code reviewers. Builds a dependency graph of your
codebase and overlays a PR (or any branch comparison) on top of it:

- **Red** nodes — files in the diff
- **Orange** nodes — files that transitively import a changed file (your
  blast radius)
- **Green** nodes — unaffected files

Risk scoring via PageRank + in-degree tells you *how* dangerous a change is.
Core architecture files glow hotter than leaf components.

Ships as both a Chrome extension (for GitHub PR pages) and a VS Code
extension (for your local workspace, no GitHub API needed).

## Quickstart

### Chrome extension

```sh
bun install
bun run build --filter=@gitgraph/chrome
```

Then in Chrome:

1. Open `chrome://extensions/`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select `packages/chrome/dist/`
4. Click the gitGraph extension icon → paste a GitHub Personal Access Token
   (optional but lifts the public-repo rate limit from 60/hr to 5000/hr;
   required for private repos)
5. Open any PR — a floating **gitGraph** button appears bottom-right
6. Or, from the popup: pick a base branch + (optional) compare branch on any
   `github.com/<org>/<repo>` page → "Open graph in current tab"

### VS Code extension

```sh
bun install
bun run build --filter=gitgraph-vscode
```

To install:

```sh
# Package as .vsix
bun run --cwd packages/vscode pack

# Install the resulting file
code --install-extension packages/vscode/gitgraph-vscode-0.1.0.vsix
```

To iterate on the extension itself, open this repo in VS Code and press
**F5** — that launches an Extension Development Host with `--disable-extensions`
so you get a clean test environment.

Once installed: click the gitGraph icon in the activity bar. The graph
mounts and scans against the auto-detected base branch (`main` → `master`
→ `develop` → upstream tracking). Commands:

- `gitGraph: Reindex workspace`
- `gitGraph: Compare branches` (QuickPick of local branches)
- `gitGraph: Open graph in editor tab`

## What's in the box

| Package | Role |
|---|---|
| [`@gitgraph/core`](packages/core) | Pure TS. Parser (TS/JS via compiler API, Dart via regex), graph builder, BFS closure, PageRank + risk scorer, `.gitgraph.json` config |
| [`@gitgraph/graph-renderer`](packages/graph-renderer) | PIXI.js + D3-force. Scene mapping, layout, filter, interactive WebGL canvas |
| [`@gitgraph/chrome`](packages/chrome) | Manifest V3 extension. Content script + overlay + popup + GitHub API client |
| [`gitgraph-vscode`](packages/vscode) | Sidebar webview, local file scanner, git wrapper, command palette entries |
| [`@gitgraph/smoke`](packages/smoke) | Standalone test page that mounts the renderer with synthetic data — useful for visual verification without GitHub |

## Languages supported

- TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) — `ts.createSourceFile`
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`) — same, with `allowJs`
- Dart / Flutter (`.dart`) — regex-based parser, detects widget classes

Imports tracked: static `import`, dynamic `import()` with string-literal
arg, `require()`, `export … from`, Dart `import`/`export`/`part`/`part of`,
`package:` resolution via melos/pubspec.

## Config

Place `.gitgraph.json` at the repo root:

```json
{
  "excludePaths": ["scripts/**", "*.test.ts"],
  "corePaths": ["src/core/auth.ts", "src/core/database.ts"],
  "languages": { "src/**/*.mjs": "javascript" }
}
```

`corePaths` get a 1.5× risk score multiplier and a yellow glow border.

## Dev setup

Bun + Turborepo monorepo. Strict TypeScript everywhere.

```sh
bun install
bun run build       # turbo build across all packages
bun run test        # vitest across all packages (126 tests)
bun run typecheck
```

Per-package dev mode:

```sh
bun run --cwd packages/chrome dev     # watch + rebuild content.js
bun run --cwd packages/vscode dev     # watch + rebuild extension + webview
bun run --cwd packages/smoke dev      # serves the smoke fixture on :5173
```

### Smoke fixture

`packages/smoke` mounts the renderer with a synthetic 13-file project so
you can verify visual changes to the renderer without needing GitHub
access. Useful when iterating on layout, styling, or filter logic.

## Architecture in one paragraph

`core` is the only package with real domain logic. It walks parsed source
files into an adjacency-list graph, runs reverse-BFS from changed files for
the impact classification, and runs PageRank for the risk scores.
`graph-renderer` wraps that into a `Scene` and renders it with PIXI.js + 5
D3-force forces (charge, link, center, collide, folder gravity). Both
extensions (`chrome`, `vscode`) are thin: they fetch source by their
respective means (GitHub REST API vs `fs.readFile` + `git diff`), call
core, hand the result to the renderer, and forward UI events back.

## Phase status

| Phase | State |
|---|---|
| 0–5 (scaffold → VS Code ext) | Complete, working end-to-end |
| 6 (E2E tests, perf profiling, a11y) | Not started |

Open items tracked in [PROJECT_PLAN.md](PROJECT_PLAN.md).

## Spec

[SPEC.md](SPEC.md) is the source of truth for behaviour. [SPEC.json](SPEC.json)
is its machine-readable counterpart. [PROJECT_PLAN.md](PROJECT_PLAN.md)
breaks the spec into phases.
