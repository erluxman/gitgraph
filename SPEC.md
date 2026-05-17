# gitGraph — Visual Diff Analysis with Dependency-Aware Risk Scoring

**Version:** 0.1.0 **Public name:** gitGraphing (internal codename: gitGraph)

## Problem

Traditional diffs show what changed — not what **will break**. A 3-line change to a core auth module looks trivial in a diff, but could affect 200+ files downstream. Conversely, a 500-line change to a new feature page is isolated. Reviewers need to understand **blast radius**, not just text delta.

## Solution

gitGraph builds a **dependency graph** of your codebase, then overlays PR/commit diffs onto it. You see instantly:

- **Red nodes** — files that changed
- **Orange nodes** — files that import changed files (transitively) and may break
- **Green nodes** — files unaffected by this change

Risk scoring via PageRank centrality tells you _how_ dangerous each change is. Core architecture files glow hotter than leaf components.

## Target Audience

Code reviewers — especially teams dealing with AI-generated PRs where changes look syntactically correct but impact is hard to gauge.

---

## Platforms

### Chrome Extension (MVP — build first)

Injects a button on GitHub PR pages. Click → full-screen overlay/modal with interactive dependency graph showing the PR's blast radius. Works on public repos without auth, private repos with token.

### VS Code Extension (Phase 2)

Sidebar panel (like Explorer) + option to pop into full editor tab. Auto-detects current branch's PR via GitHub CLI. Also supports branch-to-branch comparison.

---

## Graph Indexing

### Supported Languages

| Language | Parser | Node Detection | Import Tracking |
| --- | --- | --- | --- |
| TypeScript | TS compiler API (`ts.createSourceFile`) | `export` keyword only | static `import` + `import()` with string literal |
| JavaScript | TS compiler API (`allowJs: true`) | `export` / `module.exports` | static `import` + `require()` string literals + `import()` |
| Dart | Custom AST parser (regex-based for browser) | public symbols (no `_` prefix) | `import`/`export`/`part`/`part of` |

**Dart/Flutter extras:** Widget classes, `build()` methods, StatefulWidget lifecycle methods indexed.

### Indexed Entities

**Files** — primary nodes. Every source file is a node.

**Functions** — expandable sub-nodes. Only exported/public functions. Metadata: name, params, return type, line number.

**Classes** — expandable sub-nodes. Only exported/public classes. Metadata: name, methods, properties, line number.

**Variables** — expandable sub-nodes. Only exported/public const/let/var and static members.

### Edge Types

**Static imports** — `import ... from`, `import { } from`, `require()`. Always tracked.

**Dynamic imports** — `import()` and computed requires. Tracked only when path is a string literal. Template strings or variables = skipped.

**Re-exports** — `export { } from`, `export * from`. Traced through to original source.

### Monorepo Support

Cross-package edges supported. Detects monorepo structure via:

- `pnpm-workspace.yaml`
- `package.json` workspaces field
- `lerna.json`
- `melos.yaml` (Dart/Flutter)

### Excluded Paths

Defaults: `node_modules`, `build`, `.git`, `dist`, `.dart_tool`, lock files, `coverage`, `.next`, `.nuxt`, generated Dart files (`*.g.dart`, `*.freezed.dart`, `*.generated.dart`).

User-configurable via `.gitgraph.json` in repo root.

### Caching

| Platform | Cache Location | Lifetime |
| --- | --- | --- |
| Chrome extension | Session storage | Cleared on tab close |
| VS Code extension | Workspace storage | Persisted, invalidated on new commits |

---

## Graph Visualization

### Layout Engine

**Physics:** D3-force simulation

Forces applied:

- **Charge** — repulsion between all nodes (prevents overlap)
- **Link** — attraction along import edges (connected files stay close)
- **Folder gravity** — files in same folder attract each other (Obsidian-style clustering)
- **Center** — gentle pull toward viewport center
- **Collision** — hard boundary to prevent node overlap

**Rendering:** PIXI.js (WebGL). Fallback to Canvas 2D if WebGL unavailable. Target 60 FPS, max ~5000 nodes.

### Default View

All files visible from start. No folder-level clustering. User zooms/pans for large repos.

### Node Shapes

| Entity   | Shape             | Size                         | Label         |
| -------- | ----------------- | ---------------------------- | ------------- |
| File     | Circle            | Proportional to export count | Filename only |
| Function | Small circle      | Fixed small                  | Function name |
| Class    | Rounded rectangle | Proportional to method count | Class name    |
| Variable | Diamond           | Fixed small                  | Variable name |

### Node Expansion

Click a file node → child nodes (functions, classes, variables) **orbit around the parent** as satellite nodes connected by short edges. Click again to collapse.

### Edge Display

All import edges visible at all times. Curved bezier lines. Thickness proportional to number of imports between two files. Subtle arrow at target end. Highlighted on hover.

### Interactions

| Action | Result |
| --- | --- |
| Click | Expand/collapse file to show children |
| Ctrl/Cmd + Click | Jump to definition (VS Code: open file, Chrome: GitHub file view) |
| Right-click | Context menu: details, mark as core path, copy path |
| Hover | Highlight connected edges + tooltip with file info |
| Drag | Reposition node (physics pauses for that node) |
| Scroll | Zoom in/out |
| Middle-click drag | Pan viewport |

### Search & Filter

Search bar pinned to top of graph view:

- Search by filename
- Search by function/class name
- Filter: "show only files importing X"
- Filter: "show only files in folder Y"
- Filter: "show only files with risk above threshold"

Matching nodes highlight, non-matching nodes fade.

### Core Path Indicator

Manually tagged critical files get glowing border + star badge. Tagged via right-click context menu (VS Code only) or `.gitgraph.json` config. Core paths get 1.5x risk score multiplier.

---

## Diff Analysis

### Color Coding

| Color | Hex | Meaning |
| --- | --- | --- |
| Green | `#4ade80` | Unchanged — not affected by this change |
| Red | `#ef4444` | Directly affected — file appears in the diff |
| Orange | `#aa7316` | Indirectly affected — imports a changed file (transitively) |

### Impact Direction

**Downstream consumers only.** If `auth.ts` is changed, everything that imports `auth.ts`, and everything that imports _those_ files, etc. is marked orange.

Rationale: Answers "what might break because of this change."

Algorithm: BFS from each changed file, following reverse import edges (file → its consumers).

### Orange Fade Effect

Orange opacity fades based on BFS distance from nearest changed file:

- Distance 1: 100% opacity
- Distance 2: 80%
- Distance 3: 60%
- Distance 4: 40%
- Distance 5+: 20%

Deeper = less likely to actually break, so visually quieter.

### Diff Data Sources

**Chrome extension:**

1. GitHub REST API: `GET /repos/{owner}/{repo}/pulls/{pr}/files`
2. Fallback: GitHub GraphQL API
3. Last resort: DOM scraping of PR files tab

**VS Code extension:**

1. `git diff` via child_process
2. PR detection via `gh pr view --json` (GitHub CLI)
3. Manual: paste PR URL command

---

## Risk Scoring

### Algorithm

Combined score = `0.7 × PageRank centrality + 0.3 × normalized in-degree`

**PageRank centrality** — models "importance" of a file in the dependency graph. Files imported by many important files score highest.

**In-degree** — raw count of how many files import this file, normalized to 0-1.

### Display

Color intensity only (no numeric scores visible by default). Darker red = higher risk for changed files. Darker orange = higher risk for indirectly affected files. Hover tooltip shows risk context: "imported by N files, centrality rank #M."

### Core Path Boost

Files tagged as core paths get 1.5x multiplier on their risk score. Stored in `.gitgraph.json`.

---

## Chrome Extension (MVP) — Detailed Spec

### Manifest

Manifest V3. Chrome only (Chromium-based browsers likely compatible).

### Entry Point

Button injected next to "Files changed" tab on GitHub PR pages. Label: "gitGraph" with graph icon.

### Overlay

Full-screen modal with backdrop blur. Contains:

- Graph canvas (100% of modal)
- Top toolbar: search bar, legend (green/red/orange), settings gear, close button
- Close via X button or Escape key

### Data Fetching Strategy

**Light scan (default):**

1. Fetch PR changed files list via GitHub API
2. Fetch repo file tree via `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
3. Fetch file contents ONLY for changed files + their direct importers (on-demand)
4. Parse imports, build partial graph, expand transitively as needed

**Deep scan (toggle in settings):**

1. Fetch ALL file contents and parse everything
2. Full graph with full risk scoring
3. Slower but complete picture

Toggle in extension settings. Default: light scan.

### Authentication

| Repo Type      | Auth Required | Rate Limit  |
| -------------- | ------------- | ----------- |
| Public         | No            | 60 req/hr   |
| Public + token | Optional      | 5000 req/hr |
| Private        | Yes (PAT)     | 5000 req/hr |

Token stored in `chrome.storage.local`.

### Progressive Loading

1. Show modal with loading skeleton + progress text
2. Fetch diff file list → render red nodes immediately
3. Fetch file tree → render all file nodes (green)
4. Parse imports for changed files → render orange nodes
5. Expand transitive closure progressively (animate new orange nodes appearing)
6. Run risk scoring → apply color intensity

### Settings (extension popup)

- GitHub personal access token
- Excluded paths (override defaults)
- Deep scan vs light scan toggle
- Physics simulation speed
- Default expanded/collapsed state

---

## VS Code Extension — Detailed Spec

### Requirements

VS Code 1.80+

### Entry Points

**Sidebar panel** (default): Custom icon in activity bar → webview panel with graph.

**Editor tab**: Command `gitGraph.openInEditor` pops graph into full editor tab. Can split-view with code.

### PR Detection

1. Auto: reads current git branch → `gh pr view --json` to find linked PR
2. Manual: command `gitGraph.openPR` → paste GitHub PR URL
3. Branch diff: command `gitGraph.compareBranches` → pick two branches from dropdown

### Indexing

- Auto-indexes on workspace open (background task)
- File watcher for incremental re-index on saves
- Manual reindex: command `gitGraph.reindex`
- Stored in VS Code workspace storage API

### Features

Everything Chrome has, plus:

- Core path tagging via right-click context menu
- Jump to definition opens file in editor
- Persistent workspace storage
- File watcher for live graph updates

---

## Architecture

### Monorepo Structure

```
gitgraph/
├── packages/
│   ├── core/              # Shared TS core
│   │   ├── src/
│   │   │   ├── parser/    # AST parsing (JS/TS/Dart)
│   │   │   ├── graph/     # Graph builder, adjacency list
│   │   │   ├── diff/      # Diff analyzer, color classification
│   │   │   ├── risk/      # PageRank scorer
│   │   │   └── closure/   # Transitive closure (BFS)
│   │   └── package.json
│   ├── graph-renderer/    # Shared PIXI.js + D3-force renderer
│   │   ├── src/
│   │   │   ├── engine/    # D3-force physics setup
│   │   │   ├── render/    # PIXI.js node/edge rendering
│   │   │   ├── ui/        # Search bar, toolbar, tooltips
│   │   │   └── interaction/ # Click, hover, drag handlers
│   │   └── package.json
│   ├── chrome/            # Chrome extension (Manifest V3)
│   │   ├── src/
│   │   │   ├── content/   # Content script (inject button)
│   │   │   ├── overlay/   # Modal overlay + graph mount
│   │   │   ├── github/    # GitHub API client
│   │   │   └── popup/     # Settings popup
│   │   ├── manifest.json
│   │   └── package.json
│   └── vscode/            # VS Code extension
│       ├── src/
│       │   ├── extension.ts
│       │   ├── sidebar/   # Webview provider
│       │   ├── commands/  # VS Code commands
│       │   └── git/       # Git/GitHub CLI integration
│       └── package.json
├── turbo.json
├── bun.lockb
└── package.json
```

### Build Tools

- **Package manager:** Bun
- **Monorepo orchestration:** Turborepo
- **Bundler:** esbuild (fast, works for both Chrome ext and VS Code ext)
- **TypeScript:** strict mode throughout

### Core Package

Pure TypeScript, zero runtime dependencies (except TS compiler API for parsing). Modules:

| Module | Responsibility |
| --- | --- |
| `parser` | AST parse JS/TS/Dart files → extract nodes (files, functions, classes, variables) and edges (imports) |
| `graph` | Build adjacency list from parsed data. Expose graph query API |
| `diff` | Take list of changed file paths → classify all nodes as red/orange/green |
| `risk` | Run PageRank + in-degree on graph → assign risk scores |
| `closure` | BFS from changed files along reverse edges → find all downstream consumers |

### Graph Renderer Package

PIXI.js + D3-force. Receives graph data as JSON → renders interactive canvas. Shared by Chrome overlay and VS Code webview.

**No WASM needed.** Earlier spec mentioned WASM-compiled core for Chrome. Dropped — pure TS runs fine in Chrome extension context (content scripts, extension pages). Simpler build, no compile step.

---

## Config File: `.gitgraph.json`

```json
{
  "excludePaths": ["scripts/**", "docs/**", "*.test.ts"],
  "corePaths": [
    "src/core/auth.ts",
    "src/core/database.ts",
    "src/middleware/index.ts"
  ],
  "languages": {
    "src/**/*.mjs": "javascript"
  }
}
```

Placed in repo root. Committed to version control so whole team shares config.

---

## Test Plan

### Unit Tests (vitest)

**Parser tests:**

- TS file with exports → correct nodes extracted
- TS file with no exports → no nodes
- JS file with `module.exports` → correct nodes
- JS file with `require()` → correct edges
- Dart file with public/private → correct filtering
- Flutter widget file → widget classes detected
- Dynamic `import()` with string literal → edge created
- Dynamic `import()` with variable → edge skipped
- Re-exports → edges traced through to original
- Circular imports → handled without infinite loop

**Graph builder tests:**

- Simple A→B import → correct adjacency
- Transitive A→B→C → full closure computed
- Monorepo cross-package import → edge created
- Self-import → ignored
- Missing file import → graceful handling (dangling edge)

**Diff analyzer tests:**

- Single file changed → correct red/green/orange
- Core file changed → many orange nodes
- Leaf file changed → only that file red, rest green
- New file added → red, no orange (nothing imports it yet)
- File deleted → red, consumers marked orange

**Risk scorer tests:**

- Hub file (many importers) → high score
- Leaf file (no importers) → low score
- Core-tagged file → 1.5x boost applied
- Isolated file (no imports, no importers) → minimal score

### Integration Tests (vitest)

- Full pipeline: parse mini repo → build graph → apply diff → score risk → verify classifications
- Real-world fixtures: 5-10 file mini repos covering common patterns
- Monorepo fixture with cross-package imports
- Flutter project fixture with widgets

### E2E Tests

**Chrome extension (Playwright):**

- Button appears on GitHub PR page
- Click button → overlay opens with graph
- Graph renders correct number of nodes for test repo
- Changed files are red
- Indirect files are orange
- Search filters nodes correctly
- Escape closes overlay
- Settings popup saves/loads token

**VS Code extension (VS Code Extension Test Runner):**

- Sidebar panel renders graph
- Reindex command completes without error
- Jump to definition opens correct file at correct line
- Core path tagging persists across reloads

### Visual Regression (Playwright screenshots)

- Graph layout consistency (same data → visually similar layout)
- Color coding correct in diff mode
- Node expand/collapse renders correctly
- Search highlight renders correctly
- Progressive loading states render correctly
