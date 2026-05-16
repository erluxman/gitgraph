/** A repository (owner + name). */
export interface RepoLocator {
  readonly owner: string;
  readonly repo: string;
}

/** Coordinates for a GitHub PR page. */
export interface PrLocator extends RepoLocator {
  readonly pull: number;
}

export interface BranchInfo {
  readonly name: string;
  readonly sha: string;
}

/** A single entry from `GET /repos/{owner}/{repo}/pulls/{n}/files`. */
export interface PrChangedFile {
  readonly filename: string;
  readonly status:
    | "added"
    | "modified"
    | "removed"
    | "renamed"
    | "copied"
    | "changed";
  readonly previousFilename?: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Tree entry from `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`. */
export interface RepoTreeEntry {
  readonly path: string;
  readonly type: "blob" | "tree";
  readonly sha: string;
  readonly size?: number;
}

export interface PrMeta {
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
}
