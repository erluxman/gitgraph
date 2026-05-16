import type { Edge, ParsedFile, ParsedRepo } from "../types.js";
import { resolveImport, type ResolverContext } from "./resolver.js";

/**
 * Adjacency-list representation of the import graph.
 *
 * - `outgoing[file]` = files this file imports
 * - `incoming[file]` = files that import this file (reverse index)
 * - `edges` is the deduped edge list
 *
 * Self-imports are dropped. Missing import targets ("dangling edges") are
 * collected separately so the caller can surface them in the UI.
 */
export interface Graph {
  readonly nodes: ReadonlyMap<string, ParsedFile>;
  readonly outgoing: ReadonlyMap<string, ReadonlySet<string>>;
  readonly incoming: ReadonlyMap<string, ReadonlySet<string>>;
  readonly edges: readonly Edge[];
  readonly danglingImports: readonly {
    readonly from: string;
    readonly specifier: string;
  }[];
}

export interface BuildGraphOptions {
  readonly repo: ParsedRepo;
  readonly resolverContext?: ResolverContext;
}

export function buildGraph({ repo, resolverContext }: BuildGraphOptions): Graph {
  const files = repo.files;

  const ctx: ResolverContext = resolverContext ?? {
    files: new Set(files.keys()),
    packages: new Map(),
    dartPackages: new Map(),
  };

  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const edges: Edge[] = [];
  const dangling: { from: string; specifier: string }[] = [];

  for (const path of files.keys()) {
    outgoing.set(path, new Set());
    incoming.set(path, new Set());
  }

  for (const file of files.values()) {
    for (const raw of file.imports) {
      // `part of "x"` flips direction: this file is part of `x`, so `x` imports `this`.
      // We model it as an edge from `x` → `this`, same kind.
      if (raw.kind === "dart-part-of") {
        const target = resolveImport(file.path, raw, file.language, ctx);
        if (target === null) {
          dangling.push({ from: file.path, specifier: raw.specifier });
          continue;
        }
        if (target === file.path) continue;
        const added = ensureAdj(outgoing, target).add(file.path);
        ensureAdj(incoming, file.path).add(target);
        if (added.size > 0) {
          edges.push({ from: target, to: file.path, kind: raw.kind });
        }
        continue;
      }

      const target = resolveImport(file.path, raw, file.language, ctx);
      if (target === null) {
        dangling.push({ from: file.path, specifier: raw.specifier });
        continue;
      }
      if (target === file.path) continue;
      const out = ensureAdj(outgoing, file.path);
      if (out.has(target)) continue; // already counted
      out.add(target);
      ensureAdj(incoming, target).add(file.path);
      edges.push({ from: file.path, to: target, kind: raw.kind });
    }
  }

  return {
    nodes: files,
    outgoing: freezeMap(outgoing),
    incoming: freezeMap(incoming),
    edges,
    danglingImports: dangling,
  };
}

function ensureAdj<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let s = map.get(key);
  if (s === undefined) {
    s = new Set();
    map.set(key, s);
  }
  return s;
}

function freezeMap<K, V>(map: Map<K, Set<V>>): ReadonlyMap<K, ReadonlySet<V>> {
  return map as ReadonlyMap<K, ReadonlySet<V>>;
}
