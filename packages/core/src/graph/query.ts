import type { Graph } from "./builder.js";

/** Files this file directly imports. */
export function getDependencies(graph: Graph, path: string): readonly string[] {
  const set = graph.outgoing.get(path);
  return set ? [...set] : [];
}

/** Files that directly import this file. */
export function getImporters(graph: Graph, path: string): readonly string[] {
  const set = graph.incoming.get(path);
  return set ? [...set] : [];
}

/**
 * All files reachable via outgoing edges from `path`. Used for "what does this
 * file depend on, transitively?". Cycle-safe.
 */
export function transitiveDependencies(
  graph: Graph,
  path: string,
): ReadonlySet<string> {
  return bfsReachable(graph.outgoing, [path]);
}

/**
 * All files reachable via incoming edges from `path`. Used for "what depends
 * on this file, transitively?" — the core of blast-radius analysis.
 */
export function transitiveImporters(
  graph: Graph,
  path: string,
): ReadonlySet<string> {
  return bfsReachable(graph.incoming, [path]);
}

function bfsReachable(
  adj: ReadonlyMap<string, ReadonlySet<string>>,
  seeds: readonly string[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (!seen.has(seed)) {
      seen.add(seed);
      queue.push(seed);
    }
  }
  // Skip the seed in the output? No — callers can filter if they want.
  while (queue.length > 0) {
    const next = queue.shift()!;
    const neighbours = adj.get(next);
    if (!neighbours) continue;
    for (const n of neighbours) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}
