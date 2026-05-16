import {
  DEFAULT_CONFIG,
  analyseDiff,
  buildGraph,
  detectLanguage,
  detectMonorepo,
  parseFile,
  readPackageJsonName,
  readPubspecName,
  scoreRisk,
  transitiveImporters,
  type DiffResult,
  type Graph,
  type GitGraphConfig,
  type Language,
  type ParsedFile,
  type ParsedRepo,
  type ResolverContext,
  type RiskScore,
} from "@gitgraph/core";
import type { GitHubClient } from "./github/client.js";
import type {
  PrLocator,
  RepoLocator,
  RepoTreeEntry,
} from "./github/types.js";

/**
 * What the scan is comparing. The orchestrator handles three cases
 * with the same downstream pipeline (fetch tree → parse → graph → diff
 * → score); only the "where do `changedFiles` and `headSha` come from?"
 * step varies.
 *
 *   pr        — fetch /pulls/N for refs + /pulls/N/files for changed list
 *   compare   — fetch /compare/{base}...{head} (no PR needed)
 *   snapshot  — single ref; no changed list (all nodes will be green)
 */
export type ScanTarget =
  | { readonly kind: "pr"; readonly locator: PrLocator }
  | {
      readonly kind: "compare";
      readonly locator: RepoLocator;
      readonly base: string;
      readonly head: string;
    }
  | {
      readonly kind: "snapshot";
      readonly locator: RepoLocator;
      readonly ref: string;
    };

/**
 * Snapshot the renderer consumes. Built progressively — the same shape is
 * emitted at every phase so the UI can re-render incrementally.
 */
export interface ScanSnapshot {
  readonly phase:
    | "loading-pr"
    | "loading-tree"
    | "parsing-changed"
    | "expanding"
    | "scoring"
    | "done";
  readonly progress: number; // 0..1
  readonly message: string;
  /** Source-only paths (post-filter). These are what the diff/graph operate on. */
  readonly changedFiles: readonly string[];
  /** Raw filename list from the PR diff, including non-source (.md, .json, .yml). */
  readonly allChangedFiles: readonly string[];
  /**
   * All source paths in the repo tree (post-exclude filter). Populated
   * after the `loading-tree` phase. Lets the overlay render a skeleton
   * scene with placeholder nodes before any content is parsed.
   */
  readonly sourcePaths: readonly string[];
  readonly repo: ParsedRepo;
  readonly graph: Graph | null;
  readonly diff: DiffResult | null;
  readonly risk: ReadonlyMap<string, RiskScore> | null;
}

export interface RunScanOptions {
  readonly client: GitHubClient;
  readonly target: ScanTarget;
  readonly mode: "light" | "deep";
  readonly config?: GitGraphConfig;
  readonly emit?: (snap: ScanSnapshot) => void;
  /**
   * Cap on concurrent file content fetches. GitHub allows up to 100 concurrent
   * requests on a single connection but it's polite (and faster, due to head-
   * of-line blocking on most networks) to keep this in the 8–16 range.
   */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

interface TargetResolution {
  readonly headSha: string;
  readonly changedFiles: readonly string[];
  readonly description: string;
}

/**
 * Resolve a `ScanTarget` to:
 *   - the SHA whose tree we'll walk
 *   - the list of changed file paths (empty for snapshot)
 *   - a short human-readable description used in progress text
 */
async function resolveTarget(
  client: GitHubClient,
  target: ScanTarget,
): Promise<TargetResolution> {
  switch (target.kind) {
    case "pr": {
      const meta = await client.getPr(target.locator);
      const files = await client.listPrFiles(target.locator);
      return {
        headSha: meta.head.sha,
        changedFiles: files.map((f) => f.filename),
        description: `PR #${target.locator.pull}`,
      };
    }
    case "compare": {
      const cmp = await client.compareCommits(
        target.locator,
        target.base,
        target.head,
      );
      return {
        headSha: cmp.headSha,
        changedFiles: cmp.files.map((f) => f.filename),
        description: `${target.base} → ${target.head}`,
      };
    }
    case "snapshot": {
      // Resolve the ref to a sha. /repos/.../branches/{ref} works for
      // branches; for tags or arbitrary commits, the ref itself is fine
      // as a tree-ish input to listTree.
      return {
        headSha: target.ref,
        changedFiles: [],
        description: target.ref,
      };
    }
  }
}

function targetLocator(target: ScanTarget): RepoLocator {
  return target.locator;
}

/**
 * SPEC.md → "Data Fetching Strategy".
 *
 * Light scan: fetch only changed files + their direct importers. Cheap on
 * GitHub API quota; gives partial-but-actionable blast-radius view.
 *
 * Deep scan: fetch every source file in the repo and build the full graph.
 */
export async function runScan(opts: RunScanOptions): Promise<ScanSnapshot> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const concurrency = opts.concurrency ?? 8;
  const repoLocator = targetLocator(opts.target);
  const repo: ParsedRepo = { files: new Map() };
  let snapshot: ScanSnapshot = {
    phase: "loading-pr",
    progress: 0,
    message: "Loading…",
    changedFiles: [],
    allChangedFiles: [],
    sourcePaths: [],
    repo,
    graph: null,
    diff: null,
    risk: null,
  };
  const emit = (s: ScanSnapshot) => {
    snapshot = s;
    opts.emit?.(s);
  };
  emit(snapshot);
  ensureNotAborted(opts.signal);

  const resolved = await resolveTarget(opts.client, opts.target);
  const allChangedPaths = resolved.changedFiles;
  const changedPaths = allChangedPaths.filter((p) => isSourcePath(p, config));
  emit({
    ...snapshot,
    phase: "loading-tree",
    progress: 0.1,
    message: `Loading tree for ${resolved.description}…`,
    changedFiles: changedPaths,
    allChangedFiles: allChangedPaths,
  });
  ensureNotAborted(opts.signal);

  const { entries: tree } = await opts.client.listTree(
    repoLocator,
    resolved.headSha,
  );
  const sourcePaths = tree
    .filter((e) => e.type === "blob")
    .map((e) => e.path)
    .filter((p) => isSourcePath(p, config));

  // For snapshot mode there's nothing to "parse changed" — skip straight
  // to the full-scan phase.
  const parsingPhaseMessage =
    changedPaths.length > 0
      ? `Parsing ${changedPaths.length} changed files…`
      : `Scanning ${resolved.description}…`;
  emit({
    ...snapshot,
    phase: "parsing-changed",
    progress: 0.25,
    message: parsingPhaseMessage,
    changedFiles: changedPaths,
    sourcePaths,
  });
  ensureNotAborted(opts.signal);

  // Seed: only changed files. We parse them so we know who they import,
  // which seeds the next wave.
  await parsePaths(
    opts,
    repoLocator,
    changedPaths,
    resolved.headSha,
    repo,
    concurrency,
  );
  ensureNotAborted(opts.signal);

  if (opts.mode === "deep" || opts.target.kind === "snapshot") {
    emit({
      ...snapshot,
      phase: "expanding",
      progress: 0.4,
      message: `Deep scan: parsing all ${sourcePaths.length} files…`,
      changedFiles: changedPaths,
      repo,
    });
    const remaining = sourcePaths.filter((p) => !repo.files.has(p));
    await parsePaths(
      opts,
      repoLocator,
      remaining,
      resolved.headSha,
      repo,
      concurrency,
    );
  } else {
    // Light scan: also fetch direct importers of changed files. Two-pass
    // because we need everyone's imports parsed to know who imports what.
    // We approximate by parsing every file, then computing real importers,
    // then trimming the repo back to {changed} ∪ {importers}. But that's
    // not much cheaper than deep, so we instead use a heuristic: parse the
    // changed files' likely-importing siblings (same folder + ancestors).
    const candidatePaths = candidateImportersByFolder(changedPaths, sourcePaths);
    emit({
      ...snapshot,
      phase: "expanding",
      progress: 0.4,
      message: `Light scan: ${candidatePaths.length} candidate importers…`,
      changedFiles: changedPaths,
      repo,
    });
    const remaining = candidatePaths.filter((p) => !repo.files.has(p));
    await parsePaths(
      opts,
      repoLocator,
      remaining,
      resolved.headSha,
      repo,
      concurrency,
    );
  }
  ensureNotAborted(opts.signal);

  emit({
    ...snapshot,
    phase: "scoring",
    progress: 0.85,
    message: "Building graph and scoring risk…",
    changedFiles: changedPaths,
    repo,
  });

  // Resolve workspace package names BEFORE the first graph build so the
  // interim closure-completion pass uses real edges, not broken ones.
  const resolverContext = await buildRepoResolverContext(
    opts.client,
    repoLocator,
    resolved.headSha,
    tree,
    repo,
  );

  // For light scan, we can do one more expansion pass: anything that
  // turned out to be in the orange set but wasn't parsed gets fetched.
  if (opts.mode === "light") {
    const interimGraph = buildGraph({ repo, resolverContext });
    const orangeMissing = new Set<string>();
    for (const path of changedPaths) {
      if (!interimGraph.nodes.has(path)) continue;
      for (const consumer of transitiveImporters(interimGraph, path)) {
        if (!repo.files.has(consumer)) orangeMissing.add(consumer);
      }
    }
    if (orangeMissing.size > 0) {
      await parsePaths(
        opts,
        repoLocator,
        [...orangeMissing],
        resolved.headSha,
        repo,
        concurrency,
      );
    }
  }

  const finalResolverContext: ResolverContext = {
    ...resolverContext,
    files: new Set(repo.files.keys()),
  };
  const finalGraph = buildGraph({ repo, resolverContext: finalResolverContext });
  const finalDiff = analyseDiff({ graph: finalGraph, changedFiles: changedPaths });
  const finalRisk = scoreRisk(finalGraph, { corePaths: config.corePaths });

  emit({
    phase: "done",
    progress: 1,
    message: "Done.",
    changedFiles: changedPaths,
    allChangedFiles: allChangedPaths,
    sourcePaths,
    repo,
    graph: finalGraph,
    diff: finalDiff,
    risk: finalRisk,
  });
  return snapshot;
}

/**
 * Build the `ResolverContext` so the graph resolver can map bare
 * specifiers (`@scope/pkg`, `package:my_app/...`) back to files in the
 * tree. Without this, the resolver returns null for every such import
 * and the graph misses every cross-package edge.
 *
 * Strategy: find manifest files (`package.json`, `pubspec.yaml`) in the
 * tree, fetch the small subset of them that name a package, and map
 * each name to its directory. Falls back gracefully on a 404 / parse
 * error — the import just stays unresolved.
 */
async function buildRepoResolverContext(
  client: GitHubClient,
  locator: RepoLocator,
  sha: string,
  tree: readonly RepoTreeEntry[],
  repo: ParsedRepo,
): Promise<ResolverContext> {
  // 1. Discover layout from root manifest files.
  const rootJson = treeContent(tree, "package.json");
  const rootPnpm = treeContent(tree, "pnpm-workspace.yaml");
  const rootLerna = treeContent(tree, "lerna.json");
  const rootMelos = treeContent(tree, "melos.yaml");

  const layoutInputs: Record<string, string> = {};
  await Promise.all([
    fetchOptional(client, locator, sha, rootJson, "packageJson", layoutInputs),
    fetchOptional(client, locator, sha, rootPnpm, "pnpmWorkspaceYaml", layoutInputs),
    fetchOptional(client, locator, sha, rootLerna, "lernaJson", layoutInputs),
    fetchOptional(client, locator, sha, rootMelos, "melosYaml", layoutInputs),
  ]);
  const layout = detectMonorepo(layoutInputs);

  // 2. Decide which directories are packages. For "single", that's just
  // the root. For monorepo modes, expand globs against the tree's blob
  // paths.
  const packageDirs = new Set<string>();
  if (layout.kind === "single") {
    packageDirs.add("");
  } else {
    for (const glob of layout.roots) {
      for (const dir of expandTreeGlob(tree, glob)) packageDirs.add(dir);
    }
    // Always also probe the root, in case a non-workspace package.json
    // names the umbrella project (rare but cheap to check).
    packageDirs.add("");
  }

  // 3. For each package dir, fetch its package.json and pubspec.yaml if
  // present, extract names, and store in the appropriate map.
  const packages = new Map<string, string>();
  const dartPackages = new Map<string, string>();

  const dirs = [...packageDirs];
  await Promise.all(
    dirs.map(async (dir) => {
      const pkgJsonPath = dir === "" ? "package.json" : `${dir}/package.json`;
      const pubspecPath = dir === "" ? "pubspec.yaml" : `${dir}/pubspec.yaml`;
      const [pkgBody, pubBody] = await Promise.all([
        treeHas(tree, pkgJsonPath)
          ? safeFetch(client, locator, sha, pkgJsonPath)
          : null,
        treeHas(tree, pubspecPath)
          ? safeFetch(client, locator, sha, pubspecPath)
          : null,
      ]);
      if (pkgBody !== null) {
        const name = readPackageJsonName(pkgBody);
        if (name !== null && !packages.has(name)) packages.set(name, dir);
      }
      if (pubBody !== null) {
        const name = readPubspecName(pubBody);
        if (name !== null && !dartPackages.has(name)) dartPackages.set(name, dir);
      }
    }),
  );

  return {
    files: new Set(repo.files.keys()),
    packages,
    dartPackages,
  };
}

function treeHas(tree: readonly RepoTreeEntry[], path: string): boolean {
  return tree.some((e) => e.type === "blob" && e.path === path);
}

function treeContent(tree: readonly RepoTreeEntry[], path: string): string | null {
  return treeHas(tree, path) ? path : null;
}

async function fetchOptional(
  client: GitHubClient,
  locator: RepoLocator,
  sha: string,
  path: string | null,
  key: string,
  out: Record<string, string>,
): Promise<void> {
  if (path === null) return;
  const body = await safeFetch(client, locator, sha, path);
  if (body !== null) out[key] = body;
}

async function safeFetch(
  client: GitHubClient,
  locator: RepoLocator,
  sha: string,
  path: string,
): Promise<string | null> {
  try {
    return await client.getFileContent(locator, sha, path);
  } catch {
    return null;
  }
}

/**
 * Tiny tree-aware glob expander for workspace patterns. Same shape
 * limits as the VS Code scanner (literal path or trailing `*`).
 */
function expandTreeGlob(
  tree: readonly RepoTreeEntry[],
  glob: string,
): readonly string[] {
  if (!glob.includes("*")) {
    return tree.some((e) => e.type === "tree" && e.path === glob) ? [glob] : [];
  }
  const slash = glob.lastIndexOf("/");
  const parent = slash === -1 ? "" : glob.slice(0, slash);
  const tail = slash === -1 ? glob : glob.slice(slash + 1);
  if (tail !== "*") return [];
  const out: string[] = [];
  for (const entry of tree) {
    if (entry.type !== "tree") continue;
    if (parent === "") {
      // Top-level: name must have no slash.
      if (!entry.path.includes("/")) out.push(entry.path);
    } else {
      // Direct child of `parent`.
      const prefix = parent + "/";
      if (
        entry.path.startsWith(prefix) &&
        !entry.path.slice(prefix.length).includes("/")
      ) {
        out.push(entry.path);
      }
    }
  }
  return out;
}

async function parsePaths(
  opts: RunScanOptions,
  locator: RepoLocator,
  paths: readonly string[],
  sha: string,
  repo: ParsedRepo,
  concurrency: number,
): Promise<void> {
  let idx = 0;
  const queue = [...paths];
  const target = repo.files as Map<string, ParsedFile>;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        for (;;) {
          ensureNotAborted(opts.signal);
          const i = idx++;
          if (i >= queue.length) return;
          const path = queue[i]!;
          const language = detectLanguage(path);
          if (language === null) continue;
          try {
            const body = await opts.client.getFileContent(locator, sha, path);
            target.set(path, parseFile(path, body, language));
          } catch (e) {
            // Missing files (404) are common for PRs that delete files —
            // record nothing and let the diff classifier flag them as
            // "changed but unknown" (which becomes red in the UI).
            if (!(e instanceof Error && e.message.includes("404"))) throw e;
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function isSourcePath(path: string, config: GitGraphConfig): boolean {
  if (matchesAnyGlob(path, config.excludePaths)) return false;
  const explicit: Language | null =
    Object.entries(config.languages).find(([pattern]) => matchesGlob(path, pattern))?.[1] ??
    null;
  if (explicit !== null) return true;
  return detectLanguage(path) !== null;
}

/**
 * Pick likely importers for the light scan: every file under any ancestor
 * folder of any changed file. This catches the common case where the
 * changed file is imported by siblings in the same package.
 */
function candidateImportersByFolder(
  changed: readonly string[],
  all: readonly string[],
): readonly string[] {
  const ancestors = new Set<string>();
  for (const path of changed) {
    let cur = parentOf(path);
    while (cur.length > 0) {
      ancestors.add(cur);
      cur = parentOf(cur);
    }
    ancestors.add(""); // repo root
  }
  return all.filter((p) => ancestors.has(parentOf(p)));
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

// --- glob helpers (duplicated tiny version to avoid importing into the
// chrome bundle just for this) ---

function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}

function matchesGlob(path: string, pattern: string): boolean {
  return globToRegex(pattern).test(path);
}

function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        re += escapeChar(ch);
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const alts = inner.split(",").map((p) => p.split("").map(escapeChar).join(""));
      re += "(?:" + alts.join("|") + ")";
      i = close + 1;
      continue;
    }
    re += escapeChar(ch);
    i++;
  }
  return new RegExp("^" + re + "$");
}

function escapeChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Scan aborted", "AbortError");
}
