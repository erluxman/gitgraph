import type {
  BranchInfo,
  PrChangedFile,
  PrLocator,
  PrMeta,
  RepoLocator,
  RepoTreeEntry,
} from "./types.js";

/**
 * Minimal GitHub REST client tailored to gitGraph's needs.
 *
 * - Public repos work without a token (60 req/hr).
 * - A token (Personal Access Token) lifts the limit to 5000 req/hr.
 * - Retries once on 5xx; surfaces 403 rate-limit hits as a typed error
 *   so the UI can prompt the user to add a token.
 */
export interface GitHubClientOptions {
  readonly token?: string | undefined;
  /** Override for tests. Defaults to the real API. */
  readonly baseUrl?: string;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export class GitHubRateLimitError extends Error {
  constructor(public readonly resetAt: number | null) {
    super(
      resetAt
        ? `GitHub API rate limit hit; resets at ${new Date(resetAt).toISOString()}`
        : "GitHub API rate limit hit",
    );
    this.name = "GitHubRateLimitError";
  }
}

export class GitHubHttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, body: string) {
    super(`GitHub ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = "GitHubHttpError";
  }
}

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | undefined;

  constructor(opts: GitHubClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.token = opts.token;
  }

  async getPr(loc: PrLocator): Promise<PrMeta> {
    const data = await this.getJson<{
      head: { ref: string; sha: string };
      base: { ref: string; sha: string };
    }>(`/repos/${loc.owner}/${loc.repo}/pulls/${loc.pull}`);
    return {
      head: { ref: data.head.ref, sha: data.head.sha },
      base: { ref: data.base.ref, sha: data.base.sha },
    };
  }

  /**
   * Page through `/pulls/{n}/files`. GitHub paginates at 100 files per page;
   * we follow `Link: rel="next"` headers until exhausted.
   */
  async listPrFiles(loc: PrLocator): Promise<readonly PrChangedFile[]> {
    const out: PrChangedFile[] = [];
    let url:
      | string
      | null = `/repos/${loc.owner}/${loc.repo}/pulls/${loc.pull}/files?per_page=100`;
    type RawFile = {
      filename: string;
      status: PrChangedFile["status"];
      previous_filename?: string;
      additions: number;
      deletions: number;
    };
    while (url !== null) {
      const page: { data: RawFile[]; next: string | null } =
        await this.getJsonWithLink<RawFile[]>(url);
      const { data, next } = page;
      for (const f of data) {
        out.push({
          filename: f.filename,
          status: f.status,
          ...(f.previous_filename !== undefined
            ? { previousFilename: f.previous_filename }
            : {}),
          additions: f.additions,
          deletions: f.deletions,
        });
      }
      url = next;
    }
    return out;
  }

  /**
   * `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`.
   * Returns the full file tree at the given commit (or branch tip).
   * `truncated` flag in the response is preserved as a return field so
   * callers can fall back to per-folder requests for huge repos.
   */
  async listTree(
    loc: RepoLocator,
    sha: string,
  ): Promise<{ readonly entries: readonly RepoTreeEntry[]; readonly truncated: boolean }> {
    const data = await this.getJson<{
      tree: {
        path: string;
        type: "blob" | "tree";
        sha: string;
        size?: number;
      }[];
      truncated: boolean;
    }>(`/repos/${loc.owner}/${loc.repo}/git/trees/${sha}?recursive=1`);
    return {
      entries: data.tree.map((t) => ({
        path: t.path,
        type: t.type,
        sha: t.sha,
        ...(t.size !== undefined ? { size: t.size } : {}),
      })),
      truncated: data.truncated,
    };
  }

  /**
   * Fetch raw file contents at a specific commit. Uses the raw media type
   * so we get the file body verbatim — no base64 decode needed.
   */
  async getFileContent(loc: RepoLocator, sha: string, path: string): Promise<string> {
    const url = `${this.baseUrl}/repos/${loc.owner}/${loc.repo}/contents/${encodeURIPath(path)}?ref=${encodeURIComponent(sha)}`;
    const res = await this.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "gitGraph-chrome",
        ...(this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (res.status === 403) throw rateLimitFromHeaders(res.headers);
    if (!res.ok) throw new GitHubHttpError(res.status, url, await res.text());
    return await res.text();
  }

  /** `GET /repos/{owner}/{repo}` — used to discover the default branch. */
  async getRepo(
    loc: RepoLocator,
  ): Promise<{ readonly defaultBranch: string }> {
    const data = await this.getJson<{ default_branch: string }>(
      `/repos/${loc.owner}/${loc.repo}`,
    );
    return { defaultBranch: data.default_branch };
  }

  /**
   * List all branches in a repo. Paginates at 100 per page.
   */
  async listBranches(loc: RepoLocator): Promise<readonly BranchInfo[]> {
    const out: BranchInfo[] = [];
    let url:
      | string
      | null = `/repos/${loc.owner}/${loc.repo}/branches?per_page=100`;
    type RawBranch = { name: string; commit: { sha: string } };
    while (url !== null) {
      const page: { data: RawBranch[]; next: string | null } =
        await this.getJsonWithLink<RawBranch[]>(url);
      for (const b of page.data) {
        out.push({ name: b.name, sha: b.commit.sha });
      }
      url = page.next;
    }
    return out;
  }

  /**
   * `GET /repos/{owner}/{repo}/compare/{base}...{head}` — list files
   * changed between two refs. Same shape as PR's `/files` endpoint.
   *
   * GitHub returns up to 300 files per call. For larger diffs we
   * silently truncate; callers that care can warn the user.
   */
  async compareCommits(
    loc: RepoLocator,
    base: string,
    head: string,
  ): Promise<{
    readonly files: readonly PrChangedFile[];
    readonly mergeBaseSha: string;
    readonly headSha: string;
  }> {
    const data = await this.getJson<{
      merge_base_commit: { sha: string };
      files?: {
        filename: string;
        status: PrChangedFile["status"];
        previous_filename?: string;
        additions: number;
        deletions: number;
      }[];
      commits: { sha: string }[];
    }>(
      `/repos/${loc.owner}/${loc.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    const lastCommit = data.commits.at(-1);
    const files = (data.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status,
      ...(f.previous_filename !== undefined
        ? { previousFilename: f.previous_filename }
        : {}),
      additions: f.additions,
      deletions: f.deletions,
    }));
    return {
      files,
      mergeBaseSha: data.merge_base_commit.sha,
      headSha: lastCommit?.sha ?? head,
    };
  }

  // --- internals ---

  private async getJson<T>(path: string): Promise<T> {
    const { data } = await this.getJsonWithLink<T>(path);
    return data;
  }

  private async getJsonWithLink<T>(
    path: string,
  ): Promise<{ data: T; next: string | null }> {
    const url = path.startsWith("http") ? path : this.baseUrl + path;
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < 2) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gitGraph-chrome",
            ...(this.token !== undefined
              ? { Authorization: `Bearer ${this.token}` }
              : {}),
          },
        });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status === 403) throw rateLimitFromHeaders(res.headers);
      if (res.status >= 500 && attempt < 2) continue;
      if (!res.ok) throw new GitHubHttpError(res.status, url, await res.text());
      const data = (await res.json()) as T;
      const link = res.headers.get("Link");
      return { data, next: parseLinkHeader(link, "next") };
    }
    throw lastErr ?? new Error(`Failed after ${attempt} attempts: ${url}`);
  }
}

function rateLimitFromHeaders(headers: Headers): GitHubRateLimitError {
  const remaining = Number(headers.get("X-RateLimit-Remaining"));
  if (Number.isFinite(remaining) && remaining > 0) {
    // Not a rate-limit 403; could be auth required.
    return new GitHubRateLimitError(null);
  }
  const reset = Number(headers.get("X-RateLimit-Reset"));
  return new GitHubRateLimitError(Number.isFinite(reset) ? reset * 1000 : null);
}

/**
 * Parse RFC 5988 Link header, returning the URL for the requested rel
 * (e.g. "next"), or null if absent.
 */
export function parseLinkHeader(value: string | null, rel: string): string | null {
  if (value === null || value.length === 0) return null;
  for (const part of value.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*(.+)$/);
    if (!match) continue;
    const params = match[2]!.split(";").map((s) => s.trim());
    if (params.some((p) => p === `rel="${rel}"`)) {
      return match[1]!;
    }
  }
  return null;
}

function encodeURIPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Parse a GitHub PR URL into its locator components. */
export function parsePrUrl(url: string): PrLocator | null {
  // Accepts:
  //   https://github.com/<owner>/<repo>/pull/<number>
  //   /<owner>/<repo>/pull/<number>          (location.pathname)
  //   <owner>/<repo>#<number>
  const m1 = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m1) {
    return { owner: m1[1]!, repo: m1[2]!, pull: Number(m1[3]) };
  }
  const m2 = url.match(/^\/?([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i);
  if (m2) {
    return { owner: m2[1]!, repo: m2[2]!, pull: Number(m2[3]) };
  }
  return null;
}

/**
 * Parse any GitHub repo URL (PR, tree view, blame, blob, plain repo
 * landing page) into a `RepoLocator`. Returns null when the URL doesn't
 * look like a github.com/owner/repo path.
 *
 * Used by the popup to auto-fill the compare form from the active tab.
 */
export function parseRepoUrl(url: string): RepoLocator | null {
  // Skip the reserved paths github uses for non-repo pages.
  const RESERVED = new Set([
    "settings",
    "organizations",
    "notifications",
    "pulls",
    "issues",
    "marketplace",
    "explore",
    "topics",
    "trending",
    "collections",
    "events",
    "new",
    "search",
    "login",
    "join",
    "about",
    "features",
    "team",
    "enterprise",
    "customer-stories",
    "security",
  ]);
  const match = url.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/, "");
  if (RESERVED.has(owner.toLowerCase())) return null;
  return { owner, repo };
}
