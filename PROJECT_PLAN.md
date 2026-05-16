# gitGraph — Implementation Plan

## Phase 0: Scaffold (Day 1)

**Goal:** Monorepo structure, build tooling, CI basics.

- [ ] Init monorepo with Bun + Turborepo
- [ ] Create 4 packages: `core`, `graph-renderer`, `chrome`, `vscode`
- [ ] Configure TypeScript strict mode across all packages
- [ ] Configure esbuild for Chrome extension bundle
- [ ] Configure vitest for core + graph-renderer
- [ ] Add `.gitgraph.json` config loader to core
- [ ] Placeholder README

**Output:** `bun install` works, `turbo build` succeeds, `turbo test` runs (empty).

---

## Phase 1: Core Parser (Week 1)

**Goal:** Parse JS/TS/Dart files → extract nodes and edges.

### 1a: TypeScript/JavaScript Parser
- [ ] Parse TS files using `ts.createSourceFile`
- [ ] Extract exported functions, classes, variables as nodes
- [ ] Extract static `import` statements as edges
- [ ] Handle `require()` calls with string literals
- [ ] Handle dynamic `import()` with string literal paths
- [ ] Handle re-exports (`export { } from`, `export * from`)
- [ ] Handle `module.exports` (CommonJS)
- [ ] Unit tests for all above

### 1b: Dart Parser
- [ ] Regex-based parser for Dart files (no SDK in browser context)
- [ ] Extract public symbols (no `_` prefix)
- [ ] Extract `import`/`export`/`part`/`part of` directives
- [ ] Flutter extras: detect Widget classes, `build()` methods
- [ ] Unit tests for all above

### 1c: File Discovery
- [ ] Walk file tree, filter by language extensions
- [ ] Apply exclude patterns from defaults + `.gitgraph.json`
- [ ] Monorepo detection (workspace configs)
- [ ] Cross-package import resolution

**Output:** Given a file tree + file contents → returns `{ nodes: Node[], edges: Edge[] }`.

---

## Phase 2: Graph Engine (Week 2)

**Goal:** Build graph data structure, diff analysis, risk scoring.

### 2a: Graph Builder
- [ ] Build adjacency list from parser output
- [ ] Reverse adjacency list (for downstream consumer lookup)
- [ ] Handle circular imports gracefully
- [ ] Graph query API: get importers, get dependencies, get transitive closure

### 2b: Diff Analyzer
- [ ] Input: list of changed file paths
- [ ] BFS from each changed file via reverse edges
- [ ] Classify nodes: red (changed), orange (downstream), green (unaffected)
- [ ] Compute BFS distance for orange fade effect
- [ ] Integration tests with fixture repos

### 2c: Risk Scorer
- [ ] PageRank implementation on import graph
- [ ] In-degree counting + normalization
- [ ] Combined score: `0.7 * pagerank + 0.3 * indegree`
- [ ] Core path boost (1.5x multiplier)
- [ ] Unit tests

**Output:** Given parsed graph + diff file list → returns classified, scored nodes.

---

## Phase 3: Graph Renderer (Week 3-4)

**Goal:** Interactive PIXI.js + D3-force graph visualization.

### 3a: Physics Engine
- [ ] D3-force simulation setup
- [ ] Charge force (repulsion)
- [ ] Link force (import edge attraction)
- [ ] Folder gravity (same-folder attraction)
- [ ] Center force
- [ ] Collision force
- [ ] Configurable physics speed

### 3b: PIXI.js Rendering
- [ ] Render file nodes (circles, sized by export count)
- [ ] Render function nodes (small circles, orbit pattern)
- [ ] Render class nodes (rounded rectangles)
- [ ] Render variable nodes (diamonds)
- [ ] Render edges (curved bezier, thickness by import count, arrows)
- [ ] Color coding: green/red/orange with intensity based on risk score
- [ ] Orange fade based on BFS distance
- [ ] Labels on nodes
- [ ] WebGL fallback to Canvas 2D

### 3c: Interactions
- [ ] Click to expand/collapse file nodes
- [ ] Ctrl/Cmd+Click for jump-to-definition callback
- [ ] Right-click context menu
- [ ] Hover: highlight edges + tooltip
- [ ] Drag to reposition (pause physics for node)
- [ ] Scroll to zoom
- [ ] Middle-click drag to pan

### 3d: Search & UI
- [ ] Search bar component (filename, function name search)
- [ ] Filter by dependency chain
- [ ] Legend component (green/red/orange)
- [ ] Toolbar component
- [ ] Core path badge rendering (glow + star)

**Output:** Self-contained renderer. Input: graph JSON. Output: interactive WebGL canvas.

---

## Phase 4: Chrome Extension (Week 5-6) — MVP

**Goal:** Working Chrome extension on GitHub PR pages.

### 4a: Content Script
- [ ] Detect GitHub PR pages (URL pattern matching)
- [ ] Inject "gitGraph" button next to "Files changed" tab
- [ ] Button click → open overlay modal

### 4b: GitHub API Client
- [ ] Fetch PR changed files (`GET /repos/.../pulls/.../files`)
- [ ] Fetch repo file tree (`GET /repos/.../git/trees/...?recursive=1`)
- [ ] Fetch individual file contents (on-demand)
- [ ] Rate limit handling (retry with backoff)
- [ ] Auth: optional PAT from chrome.storage.local
- [ ] DOM scraping fallback for diff data

### 4c: Overlay Modal
- [ ] Full-screen modal with backdrop blur
- [ ] Mount graph-renderer inside modal
- [ ] Toolbar: search, legend, settings, close
- [ ] Close on X button + Escape
- [ ] Responsive sizing

### 4d: Progressive Loading
- [ ] Phase 1: skeleton + progress text
- [ ] Phase 2: red nodes from diff files
- [ ] Phase 3: all file nodes (green) from tree
- [ ] Phase 4: parse imports → orange nodes appear progressively
- [ ] Phase 5: risk scoring → color intensity applied

### 4e: Settings Popup
- [ ] GitHub token input + save
- [ ] Excluded paths editor
- [ ] Deep scan / light scan toggle
- [ ] Physics speed slider

### 4f: Build & Package
- [ ] esbuild bundle for content script
- [ ] esbuild bundle for popup
- [ ] Manifest V3 configuration
- [ ] Chrome Web Store packaging

**Output:** Installable Chrome extension. Open any GitHub PR → see dependency impact graph.

---

## Phase 5: VS Code Extension (Week 7-8)

**Goal:** VS Code extension with sidebar + editor tab graph.

### 5a: Extension Scaffolding
- [ ] VS Code extension boilerplate
- [ ] Activity bar icon registration
- [ ] Webview provider for sidebar panel
- [ ] Command registration

### 5b: Local Indexing
- [ ] Read workspace files directly (fs)
- [ ] Parse with core parser
- [ ] Store in VS Code workspace storage
- [ ] Auto-index on workspace open
- [ ] File watcher for incremental updates
- [ ] Reindex command

### 5c: PR Detection
- [ ] Git branch detection
- [ ] GitHub CLI integration (`gh pr view --json`)
- [ ] Manual PR URL command
- [ ] Branch comparison command

### 5d: Webview Integration
- [ ] Mount graph-renderer in webview
- [ ] Message passing: extension ↔ webview
- [ ] Jump to definition: open file in editor at line
- [ ] Core path tagging: right-click → mark/unmark
- [ ] Pop to editor tab command

**Output:** VS Code extension with full graph in sidebar/editor tab.

---

## Phase 6: Polish & Testing (Week 9)

- [ ] E2E tests: Chrome (Playwright)
- [ ] E2E tests: VS Code (extension test runner)
- [ ] Visual regression tests (Playwright screenshots)
- [ ] Performance profiling: repos with 500+, 1000+, 5000+ files
- [ ] Accessibility: keyboard navigation, screen reader labels
- [ ] Error handling: API failures, parse errors, malformed files
- [ ] Loading states for all async operations
- [ ] Documentation: README, usage guide

---

## Build Commands (Target)

```bash
# Install
bun install

# Build all packages
turbo build

# Build specific package
turbo build --filter=@gitgraph/core
turbo build --filter=@gitgraph/chrome

# Test
turbo test

# Dev mode (Chrome extension)
turbo dev --filter=@gitgraph/chrome

# Package Chrome extension
turbo package --filter=@gitgraph/chrome
```

---

## Tech Stack Summary

| Concern | Choice |
|---------|--------|
| Package manager | Bun |
| Monorepo | Turborepo |
| Language | TypeScript (strict) |
| Bundler | esbuild |
| Testing | vitest + Playwright |
| Graph physics | D3-force |
| Graph rendering | PIXI.js (WebGL) |
| Chrome ext | Manifest V3 |
| VS Code ext | VS Code Extension API 1.80+ |
| Parser (JS/TS) | TypeScript compiler API |
| Parser (Dart) | Custom regex-based |
