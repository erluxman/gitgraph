import type { Language } from "../types.js";

/**
 * User-editable config, lives at `.gitgraph.json` in repo root.
 * All fields are optional. See SPEC.md → "Config File".
 */
export interface GitGraphConfig {
  /** Glob patterns to exclude from indexing. */
  readonly excludePaths: readonly string[];
  /** Files to treat as "core" architecture (1.5x risk multiplier). */
  readonly corePaths: readonly string[];
  /** Explicit language overrides keyed by glob. */
  readonly languages: Readonly<Record<string, Language>>;
}

export const DEFAULT_EXCLUDES: readonly string[] = [
  "node_modules/**",
  "build/**",
  ".git/**",
  "dist/**",
  ".dart_tool/**",
  "coverage/**",
  ".next/**",
  ".nuxt/**",
  "**/*.lock",
  "**/*.lockb",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.g.dart",
  "**/*.freezed.dart",
  "**/*.generated.dart",
];

export const DEFAULT_CONFIG: GitGraphConfig = {
  excludePaths: DEFAULT_EXCLUDES,
  corePaths: [],
  languages: {},
};

/**
 * Parse a `.gitgraph.json` payload. Unknown fields are ignored;
 * malformed types throw. The result always merges with defaults so
 * callers get the full set of excludes.
 */
export function parseConfig(json: unknown): GitGraphConfig {
  if (json === null || typeof json !== "object") {
    throw new TypeError("gitgraph config must be a JSON object");
  }
  const raw = json as Record<string, unknown>;

  const excludePaths = readStringArray(raw, "excludePaths");
  const corePaths = readStringArray(raw, "corePaths");
  const languages = readLanguageMap(raw["languages"]);

  return {
    excludePaths: excludePaths
      ? [...DEFAULT_EXCLUDES, ...excludePaths]
      : DEFAULT_EXCLUDES,
    corePaths: corePaths ?? [],
    languages: languages ?? {},
  };
}

function readStringArray(
  obj: Record<string, unknown>,
  field: string,
): readonly string[] | null {
  const value = obj[field];
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new TypeError(`gitgraph config: '${field}' must be string[]`);
  }
  return value as readonly string[];
}

function readLanguageMap(value: unknown): Readonly<Record<string, Language>> | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("gitgraph config: 'languages' must be an object");
  }
  const out: Record<string, Language> = {};
  for (const [key, lang] of Object.entries(value)) {
    if (lang !== "typescript" && lang !== "javascript" && lang !== "dart") {
      throw new TypeError(
        `gitgraph config: languages['${key}'] must be one of typescript|javascript|dart`,
      );
    }
    out[key] = lang;
  }
  return out;
}
