import {
  DEFAULT_CONFIG,
  analyseDiff,
  buildGraph,
  detectLanguage,
  parseConfig,
  parseFile,
  scoreRisk,
  type GitGraphConfig,
  type ParsedFile,
  type ParsedRepo,
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
  const reportEvery = Math.max(1, Math.floor(sourcePaths.length / 20));
  for (const rel of sourcePaths) {
    const lang = detectLanguage(rel);
    if (lang === null) continue;
    try {
      const source = await fs.readFile(path.join(opts.workspaceRoot, rel), "utf8");
      parsed.set(rel, parseFile(rel, source, lang));
    } catch {
      // Unreadable file — skip silently. Permissions, symlinks, etc.
    }
    done++;
    if (done % reportEvery === 0) {
      emit({
        text: `Parsed ${done}/${sourcePaths.length}…`,
        progress: 0.2 + 0.5 * (done / sourcePaths.length),
      });
    }
  }
  const repo: ParsedRepo = { files: parsed };

  emit({ text: `Comparing against ${baseRef}…`, progress: 0.75 });
  const changed = baseRef === gitInfo.currentBranch
    ? []
    : await diffFiles(opts.workspaceRoot, baseRef).catch(() => []);

  emit({ text: "Building graph…", progress: 0.85 });
  const graph = buildGraph({ repo });
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
