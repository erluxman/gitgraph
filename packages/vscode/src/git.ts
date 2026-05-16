import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface GitInfo {
  readonly currentBranch: string;
  readonly defaultBase: string;
}

/**
 * Resolve the workspace's current branch and a sensible base branch
 * (main, master, or whatever HEAD is tracking). Used as the default
 * comparison target when the user hasn't picked one.
 */
export async function getGitInfo(cwd: string): Promise<GitInfo> {
  const current = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  // Try common defaults in order. The first that exists is our base.
  for (const candidate of ["main", "master", "develop"]) {
    if (candidate === current) continue;
    try {
      await runGit(cwd, ["rev-parse", "--verify", candidate]);
      return { currentBranch: current, defaultBase: candidate };
    } catch {
      continue;
    }
  }
  // Fall back to the upstream tracking branch.
  try {
    const upstream = (
      await runGit(cwd, ["rev-parse", "--abbrev-ref", "@{u}"])
    ).trim();
    return { currentBranch: current, defaultBase: upstream };
  } catch {
    // No good base — return current as a placeholder; diff will be empty.
    return { currentBranch: current, defaultBase: current };
  }
}

/**
 * List repo-relative paths that differ between `base` and `head`.
 * Includes added/modified/renamed/deleted files.
 */
export async function diffFiles(
  cwd: string,
  base: string,
  head: string = "HEAD",
): Promise<readonly string[]> {
  if (base === head) return [];
  const output = await runGit(cwd, [
    "diff",
    "--name-only",
    `${base}...${head}`,
  ]);
  return output
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * List all locally available branch names (refs/heads/*).
 */
export async function listBranches(cwd: string): Promise<readonly string[]> {
  const output = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  return output
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  // Quote args defensively — they come from VS Code workspace state, not
  // user input, but we still want to avoid shell interpretation.
  const cmd = ["git", ...args.map(quoteArg)].join(" ");
  return execAsync(cmd, { cwd, maxBuffer: 32 * 1024 * 1024 }).then(
    (r) => r.stdout,
  );
}

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_./@:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
