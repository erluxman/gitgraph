import {
  DEFAULT_CONFIG,
  analyseDiff,
  buildGraph,
  detectLanguage,
  detectMonorepo,
  parseConfig,
  parseFile,
  readPackageJsonName,
  readPubspecName,
  scoreRisk,
  type GitGraphConfig,
  type ParsedFile,
  type ParsedRepo,
  type ResolverContext,
} from "@gitgraph/core";
import { buildSceneFromCore, type Scene } from "@gitgraph/graph-renderer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { diffFiles, getGitInfo } from "./git.js";

export interface ScanResult {
  readonly scene: Scene;
  readonly changedFiles: readonly string[];
  readonly totalFiles: number;
  readonly baseRef: string;
}

export interface ScanOptions {
  readonly workspaceRoot: string;
  readonly baseBranch?: string;
  readonly emit?: (msg: { text: string; progress: number }) => void;
}

/**
 * One-shot scan of a local workspace. Walks the file tree, parses every
 * source file, runs git diff against the chosen base (or auto-detected),
 * then runs the standard diff classifier + risk scorer.
 *
 * Unlike the Chrome orchestrator, this doesn't need to be progressive —
 * everything runs locally and fast (no network round-trips).
 */
export async function scanWorkspace(opts: ScanOptions): Promise<ScanResult> {
  const emit = opts.emit ?? (() => {});
  const config = await loadWorkspaceConfig(opts.workspaceRoot);

  emit({ text: "Resolving git refs…", progress: 0.05 });
  const gitInfo = await getGitInfo(opts.workspaceRoot).catch(() => ({
    currentBranch: "HEAD",
    defaultBase: "HEAD",
  }));
  const baseRef = opts.baseBranch ?? gitInfo.defaultBase;

  emit({ text: "Walking workspace…", progress: 0.1 });
  const sourcePaths = await walkSourceFiles(opts.workspaceRoot, config);

  emit({
    text: `Parsing ${sourcePaths.length} files…`,
    progress: 0.2,
  });
  const parsed = new Map<string, ParsedFile>();
  let done = 0;
  let skipped = 0;
  const reportEvery = Math.max(1, Math.floor(sourcePaths.length / 20));
  for (const rel of sourcePaths) {
    const lang = detectLanguage(rel);
    if (lang === null) continue;
    try {
      const source = await fs.readFile(path.join(opts.workspaceRoot, rel), "utf8");
      parsed.set(rel, parseFile(rel, source, lang));
    } catch (err) {
      // Skip but surface why — silent failures here would mask the kind
      // of resolver bug a real-world Dart/TS monorepo would expose.
      skipped++;
      console.warn(`[gitGraph] skipped ${rel}: ${(err as Error).message}`);
    }
    done++;
    if (done % reportEvery === 0) {
      emit({
        text: `Parsed ${done}/${sourcePaths.length}…`,
        progress: 0.2 + 0.5 * (done / sourcePaths.length),
      });
    }
  }
  if (skipped > 0) {
    console.warn(
      `[gitGraph] ${skipped} file(s) skipped during scan; see warnings above`,
    );
  }
  const repo: ParsedRepo = { files: parsed };

  emit({ text: `Comparing against ${baseRef}…`, progress: 0.75 });
  const changed = baseRef === gitInfo.currentBranch
    ? []
    : await diffFiles(opts.workspaceRoot, baseRef).catch(() => []);

  emit({ text: "Building graph…", progress: 0.85 });
  const resolverContext = await buildWorkspaceResolverContext(
    opts.workspaceRoot,
    repo,
  );
  const graph = buildGraph({ repo, resolverContext });
  const diff = analyseDiff({ graph, changedFiles: changed });
  const risk = scoreRisk(graph, { corePaths: config.corePaths });

  emit({ text: "Composing scene…", progress: 0.95 });
  const scene = buildSceneFromCore({
    graph,
    diff,
    risk,
    corePaths: new Set(config.corePaths),
  });

  emit({ text: "Done.", progress: 1 });
  return {
    scene,
    changedFiles: changed,
    totalFiles: parsed.size,
    baseRef,
  };
}

async function loadWorkspaceConfig(root: string): Promise<GitGraphConfig> {
  try {
    const raw = await fs.readFile(path.join(root, ".gitgraph.json"), "utf8");
    return parseConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Build the maps the resolver needs to turn `@scope/pkg` and
 * `package:my_app/...` specifiers into in-repo file paths.
 *
 * Discovery sources, in priority order:
 *   1. `pubspec.yaml` at workspace root → single-package Dart project,
 *      its name maps to the workspace root.
 *   2. `melos.yaml` packages: globs → each matched dir's pubspec.yaml
 *      gives a Dart package name.
 *   3. Root `package.json` workspaces / `pnpm-workspace.yaml` / `lerna.json`
 *      → each matched dir's package.json gives an npm name.
 *
 * If none of these exist, returns an empty context — the resolver will
 * still handle relative imports correctly; only cross-package edges
 * become invisible.
 */
async function buildWorkspaceResolverContext(
  root: string,
  repo: ParsedRepo,
): Promise<ResolverContext> {
  const dartPackages = new Map<string, string>();
  const packages = new Map<string, string>();

  // Single-package Dart at root.
  await tryReadName(path.join(root, "pubspec.yaml"), readPubspecName).then(
    (name) => {
      if (name !== null) dartPackages.set(name, "");
    },
  );

  // Single-package JS/TS at root (rare, but possible).
  await tryReadName(path.join(root, "package.json"), readPackageJsonName).then(
    (name) => {
      if (name !== null && !packages.has(name)) packages.set(name, "");
    },
  );

  // Monorepo: load the discovery inputs that exist, expand globs against
  // the directories actually present on disk, then read each child's
  // package.json / pubspec.yaml for its name.
  const [pkgJson, pnpm, lerna, melos] = await Promise.all([
    tryReadFile(path.join(root, "package.json")),
    tryReadFile(path.join(root, "pnpm-workspace.yaml")),
    tryReadFile(path.join(root, "lerna.json")),
    tryReadFile(path.join(root, "melos.yaml")),
  ]);
  const layout = detectMonorepo({
    ...(pkgJson !== null ? { packageJson: pkgJson } : {}),
    ...(pnpm !== null ? { pnpmWorkspaceYaml: pnpm } : {}),
    ...(lerna !== null ? { lernaJson: lerna } : {}),
    ...(melos !== null ? { melosYaml: melos } : {}),
  });
  if (layout.kind !== "single") {
    const matched = await expandWorkspaceGlobs(root, layout.roots);
    for (const rel of matched) {
      const abs = path.join(root, rel);
      const [npmName, dartName] = await Promise.all([
        tryReadName(path.join(abs, "package.json"), readPackageJsonName),
        tryReadName(path.join(abs, "pubspec.yaml"), readPubspecName),
      ]);
      if (npmName !== null && !packages.has(npmName)) packages.set(npmName, rel);
      if (dartName !== null && !dartPackages.has(dartName)) dartPackages.set(dartName, rel);
    }
  }

  return {
    files: new Set(repo.files.keys()),
    packages,
    dartPackages,
  };
}

async function tryReadFile(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

async function tryReadName(
  absPath: string,
  extract: (body: string) => string | null,
): Promise<string | null> {
  const body = await tryReadFile(absPath);
  return body !== null ? extract(body) : null;
}

/**
 * Expand workspace globs (e.g. `packages/*`, `apps/web`) against the
 * actual directory tree. Only matches directories — we don't care about
 * files at this layer.
 */
async function expandWorkspaceGlobs(
  root: string,
  globs: readonly string[],
): Promise<readonly string[]> {
  const out = new Set<string>();
  for (const glob of globs) {
    for (const rel of await matchDirGlob(root, glob)) {
      out.add(rel);
    }
  }
  return [...out];
}

async function matchDirGlob(
  root: string,
  pattern: string,
): Promise<readonly string[]> {
  // Only handle the common cases: literal path, or one trailing `*`.
  // Workspace globs almost always look like `packages/*` or `apps/web`.
  if (!pattern.includes("*")) {
    try {
      const stat = await fs.stat(path.join(root, pattern));
      return stat.isDirectory() ? [pattern] : [];
    } catch {
      return [];
    }
  }
  const slash = pattern.lastIndexOf("/");
  const parentRel = slash === -1 ? "" : pattern.slice(0, slash);
  const tail = slash === -1 ? pattern : pattern.slice(slash + 1);
  if (tail !== "*") {
    // Unsupported glob shape (e.g. `apps/*-web`) — skip rather than
    // pull in a glob library for the long tail.
    return [];
  }
  try {
    const entries = await fs.readdir(path.join(root, parentRel), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => (parentRel === "" ? e.name : `${parentRel}/${e.name}`));
  } catch {
    return [];
  }
}

/**
 * Recursively walk a directory tree and return repo-relative paths of
 * files whose language we can parse. Honours config excludes and skips
 * the usual heavy directories (`node_modules`, `.git`, etc.) early to
 * avoid wasting fs calls.
 */
async function walkSourceFiles(
  root: string,
  config: GitGraphConfig,
): Promise<readonly string[]> {
  const HARD_SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".dart_tool",
    "coverage",
  ]);
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    const abs = rel === "" ? root : path.join(root, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (HARD_SKIP.has(entry.name)) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchesAnyGlob(childRel, config.excludePaths)) continue;
      if (detectLanguage(childRel) === null) continue;
      out.push(childRel);
    }
  }
  return out;
}

function matchesAnyGlob(p: string, patterns: readonly string[]): boolean {
  return patterns.some((pat) => globToRegex(pat).test(p));
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
        re += escape(ch);
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const alts = inner.split(",").map((p) => p.split("").map(escape).join(""));
      re += "(?:" + alts.join("|") + ")";
      i = close + 1;
      continue;
    }
    re += escape(ch);
    i++;
  }
  return new RegExp("^" + re + "$");
}

function escape(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}
