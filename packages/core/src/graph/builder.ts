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

  // Re-export chain inference. A barrel file (`b.dart` does
  // `export 'user_reference.dart'`) hides the real dependency: a file
  // that imports the barrel actually consumes the re-exported symbols,
  // but the only edges we have are barrel → source and importer →
  // barrel. The user's mental model is "I depend on user_reference.dart"
  // — so we synthesise a direct importer → ultimate-source edge.
  //
  // Strategy: for each file with re-export-only out-edges (a true
  // barrel), follow the export chain to its ultimate sources, and add
  // a direct edge from every importer of the barrel to each source.
  // Multi-hop barrels are handled because we iterate to a fixed point.
  inferReExportEdges(files, outgoing, incoming, edges);

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

/**
 * For every barrel file (a file whose out-edges are all `reexport`),
 * compute the transitive closure of re-exports and add inferred direct
 * edges from each importer to each ultimate source. Idempotent — running
 * twice on the same graph is a no-op.
 *
 * Examples this handles:
 *   barrel.ts:    export * from "./a"; export * from "./b";
 *   consumer.ts:  import {x} from "./barrel";
 *   → adds edges consumer→a and consumer→b (kept alongside consumer→barrel)
 *
 * And multi-hop:
 *   leaf.ts → inner-barrel.ts → outer-barrel.ts → consumer.ts
 *   → consumer gets an edge to leaf as well.
 */
function inferReExportEdges(
  files: ReadonlyMap<string, ParsedFile>,
  outgoing: Map<string, Set<string>>,
  incoming: Map<string, Set<string>>,
  edges: Edge[],
): void {
  // 1. Identify barrel files: a file whose out-imports are ALL reexports.
  //    A file with a mix of imports and reexports is not a barrel — its
  //    other imports may be load-bearing and we don't want to flatten.
  const barrels = new Set<string>();
  for (const file of files.values()) {
    if (file.imports.length === 0) continue;
    if (file.imports.every((i) => i.kind === "reexport")) {
      barrels.add(file.path);
    }
  }
  if (barrels.size === 0) return;

  // 2. For each barrel, compute the transitive closure of its re-export
  //    targets (chasing through other barrels too). Cycle-safe.
  const barrelTargets = new Map<string, Set<string>>();
  for (const barrel of barrels) {
    const targets = new Set<string>();
    const stack = [...(outgoing.get(barrel) ?? [])];
    const seen = new Set<string>([barrel]);
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (barrels.has(next)) {
        for (const inner of outgoing.get(next) ?? []) stack.push(inner);
      } else {
        targets.add(next);
      }
    }
    barrelTargets.set(barrel, targets);
  }

  // 3. For each barrel, every file that imports the barrel gains a
  //    synthetic edge to each ultimate target.
  for (const [barrel, targets] of barrelTargets) {
    const importers = incoming.get(barrel);
    if (importers === undefined) continue;
    for (const importer of importers) {
      if (barrels.has(importer)) continue; // barrel-to-barrel already handled
      const importerOut = outgoing.get(importer)!;
      for (const target of targets) {
        if (target === importer) continue;
        if (importerOut.has(target)) continue;
        importerOut.add(target);
        ensureAdj(incoming, target).add(importer);
        edges.push({ from: importer, to: target, kind: "reexport" });
      }
    }
  }
}
