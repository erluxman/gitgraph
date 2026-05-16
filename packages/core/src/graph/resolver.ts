import type { ImportKind, Language, RawImport } from "../types.js";

/**
 * Resolve a raw import specifier (e.g. "./foo", "../bar", "package:foo/x.dart",
 * "@scope/pkg") into a concrete repo-relative file path.
 *
 * The repo's full file set is needed both for extension/index probing and
 * for cross-package resolution.
 *
 * Returns `null` for:
 *   - external packages not present in this repo (e.g. "react", "flutter/material.dart")
 *   - relative imports that don't map to any file (broken or missing)
 *   - re-exports that are themselves external
 */
export interface ResolverContext {
  /** All known repo-relative file paths. Used for extension probing. */
  readonly files: ReadonlySet<string>;
  /**
   * Bare-specifier → root directory map for monorepo packages.
   * E.g. `{ "@gitgraph/core": "packages/core" }`.
   * The resolver appends `src/index.ts` or whatever the importer asked for
   * within the package and tries to find a match.
   */
  readonly packages: ReadonlyMap<string, string>;
  /**
   * Dart `package:` → root directory map.
   * E.g. `{ "my_app": "packages/my_app" }`. Per Dart convention,
   * "package:my_app/foo.dart" maps to `packages/my_app/lib/foo.dart`.
   */
  readonly dartPackages: ReadonlyMap<string, string>;
}

export function emptyResolverContext(): ResolverContext {
  return {
    files: new Set(),
    packages: new Map(),
    dartPackages: new Map(),
  };
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const DART_EXTENSIONS = [".dart"];

export function resolveImport(
  fromPath: string,
  raw: RawImport,
  language: Language,
  ctx: ResolverContext,
): string | null {
  // Dart "part of 'file'" inverts the direction — caller must handle.
  // For "part 'file'" we resolve as a relative path.
  if (language === "dart") {
    return resolveDart(fromPath, raw.specifier, ctx);
  }
  return resolveTypeScript(fromPath, raw.specifier, raw.kind, ctx);
}

function resolveTypeScript(
  fromPath: string,
  specifier: string,
  _kind: ImportKind,
  ctx: ResolverContext,
): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
    const base = joinRelative(parentOf(fromPath), specifier);
    return probeWithExtensions(base, TS_EXTENSIONS, ctx.files);
  }
  // Absolute paths in spec form: rare in TS but allowed.
  if (specifier.startsWith("/")) {
    return probeWithExtensions(specifier.replace(/^\/+/, ""), TS_EXTENSIONS, ctx.files);
  }
  // Bare specifier → workspace package?
  const pkg = matchPackagePrefix(specifier, ctx.packages);
  if (pkg !== null) {
    const [pkgName, pkgRoot] = pkg;
    const subpath = specifier.slice(pkgName.length).replace(/^\//, "");
    if (subpath === "") {
      // Probe common entry points.
      const candidates = ["src/index", "index", "src/main", "main"];
      for (const c of candidates) {
        const hit = probeWithExtensions(
          joinPath(pkgRoot, c),
          TS_EXTENSIONS,
          ctx.files,
        );
        if (hit !== null) return hit;
      }
      return null;
    }
    return probeWithExtensions(
      joinPath(pkgRoot, "src", subpath),
      TS_EXTENSIONS,
      ctx.files,
    ) ?? probeWithExtensions(joinPath(pkgRoot, subpath), TS_EXTENSIONS, ctx.files);
  }
  return null;
}

function resolveDart(
  fromPath: string,
  specifier: string,
  ctx: ResolverContext,
): string | null {
  if (specifier.startsWith("package:")) {
    const rest = specifier.slice("package:".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    const pkgName = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    const pkgRoot = ctx.dartPackages.get(pkgName);
    if (pkgRoot === undefined) return null;
    return probeExact(joinPath(pkgRoot, "lib", inner), ctx.files);
  }
  if (specifier.startsWith("dart:")) {
    return null; // dart:core, dart:async, etc.
  }
  // Relative.
  const base = joinRelative(parentOf(fromPath), specifier);
  return probeExact(base, ctx.files) ?? probeWithExtensions(stripExt(base), DART_EXTENSIONS, ctx.files);
}

// --- path helpers ---

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function joinRelative(from: string, rel: string): string {
  // Normalise "./", "../" segments. Paths use forward slashes.
  const fromParts = from.split("/").filter((p) => p.length > 0);
  const relParts = rel.split("/");
  for (const seg of relParts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") fromParts.pop();
    else fromParts.push(seg);
  }
  return fromParts.join("/");
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

function stripExt(path: string): string {
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  if (lastDot > lastSlash) return path.slice(0, lastDot);
  return path;
}

function probeExact(path: string, files: ReadonlySet<string>): string | null {
  return files.has(path) ? path : null;
}

function probeWithExtensions(
  base: string,
  extensions: readonly string[],
  files: ReadonlySet<string>,
): string | null {
  // If already has a known extension, try exact first.
  if (files.has(base)) return base;
  for (const ext of extensions) {
    if (files.has(base + ext)) return base + ext;
  }
  for (const ext of extensions) {
    if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return null;
}

function matchPackagePrefix(
  specifier: string,
  packages: ReadonlyMap<string, string>,
): readonly [string, string] | null {
  // Longest-match wins so "@scope/pkg-extra" doesn't shadow "@scope/pkg".
  let best: readonly [string, string] | null = null;
  for (const [name, root] of packages) {
    if (specifier === name || specifier.startsWith(name + "/")) {
      if (best === null || name.length > best[0].length) {
        best = [name, root];
      }
    }
  }
  return best;
}
