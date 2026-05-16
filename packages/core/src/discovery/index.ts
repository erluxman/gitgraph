import { type GitGraphConfig, DEFAULT_CONFIG } from "../config/index.js";
import { detectLanguage } from "../parser/index.js";
import type { Language } from "../types.js";
import { globToRegex, matchesAny } from "./glob.js";

export { globToRegex, matchesAny } from "./glob.js";

export interface DiscoveredFile {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  readonly language: Language;
}

/**
 * Filter a list of repo-relative paths down to the source files we want
 * to index. Honours `excludePaths` from the config and language overrides.
 *
 * Paths must already be normalised (forward slashes, repo-relative).
 */
export function discoverFiles(
  paths: readonly string[],
  config: GitGraphConfig = DEFAULT_CONFIG,
): DiscoveredFile[] {
  const overrides = Object.entries(config.languages).map(
    ([pattern, lang]) => [globToRegex(pattern), lang] as const,
  );
  const out: DiscoveredFile[] = [];
  for (const path of paths) {
    if (matchesAny(path, config.excludePaths)) continue;

    const override = overrides.find(([re]) => re.test(path));
    const language = override?.[1] ?? detectLanguage(path);
    if (language === null) continue;

    out.push({ path, language });
  }
  return out;
}

/** Workspace layout for a monorepo. `roots` are repo-relative package directories. */
export interface MonorepoLayout {
  readonly kind: "npm" | "pnpm" | "lerna" | "melos" | "single";
  readonly roots: readonly string[];
}

/**
 * Detect whether the repo is a monorepo and which directories are
 * packages. Caller passes in the contents of any of:
 *   - package.json (root)
 *   - pnpm-workspace.yaml
 *   - lerna.json
 *   - melos.yaml
 *
 * Glob patterns in workspace configs are returned as-is — resolving
 * them to concrete paths needs the file tree, which we don't have here.
 * Caller is responsible for expansion (in browser context this is done
 * by walking the GitHub tree response).
 */
export function detectMonorepo(opts: {
  readonly packageJson?: string;
  readonly pnpmWorkspaceYaml?: string;
  readonly lernaJson?: string;
  readonly melosYaml?: string;
}): MonorepoLayout {
  if (opts.pnpmWorkspaceYaml !== undefined) {
    const roots = extractYamlPackages(opts.pnpmWorkspaceYaml);
    if (roots.length > 0) return { kind: "pnpm", roots };
  }
  if (opts.packageJson !== undefined) {
    try {
      const parsed = JSON.parse(opts.packageJson) as { workspaces?: unknown };
      const roots = readWorkspacePackages(parsed.workspaces);
      if (roots.length > 0) return { kind: "npm", roots };
    } catch {
      // Ignore malformed package.json; fall through.
    }
  }
  if (opts.lernaJson !== undefined) {
    try {
      const parsed = JSON.parse(opts.lernaJson) as { packages?: readonly string[] };
      const roots = parsed.packages ?? [];
      if (roots.length > 0) return { kind: "lerna", roots: [...roots] };
    } catch {
      // Ignore malformed lerna.json.
    }
  }
  if (opts.melosYaml !== undefined) {
    const roots = extractYamlPackages(opts.melosYaml);
    if (roots.length > 0) return { kind: "melos", roots };
  }
  return { kind: "single", roots: [""] };
}

function readWorkspacePackages(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (value !== null && typeof value === "object" && "packages" in value) {
    const inner = (value as { packages: unknown }).packages;
    if (Array.isArray(inner)) {
      return inner.filter((v): v is string => typeof v === "string");
    }
  }
  return [];
}

/**
 * Tiny YAML extractor for the `packages:` list — enough for
 * pnpm-workspace.yaml and melos.yaml. We avoid pulling in a YAML
 * library so this can run in any context.
 *
 * Recognises:
 *   packages:
 *     - "packages/*"
 *     - apps/web
 */
function extractYamlPackages(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  let inBlock = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^packages\s*:/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const match = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/);
      if (match) {
        out.push(match[1]!);
        continue;
      }
      // Block ends as soon as we see a non-indented, non-list line.
      if (line.length > 0 && !/^\s/.test(line)) {
        inBlock = false;
      }
    }
  }
  return out;
}
