import type { Graph } from "../graph/builder.js";

/**
 * Result of a BFS run: for every reached node, the minimum number of
 * edges between any seed and that node. Seeds themselves have distance 0.
 *
 * Cycle-safe — each node is visited at most once.
 */
export type DistanceMap = ReadonlyMap<string, number>;

/**
 * BFS along outgoing edges (from a file to its dependencies).
 */
export function forwardClosure(
  graph: Graph,
  seeds: Iterable<string>,
): DistanceMap {
  return bfsDistances(graph.outgoing, seeds);
}

/**
 * BFS along incoming edges (from a file to its consumers).
 * This is the blast-radius computation in SPEC.md → "Impact Direction".
 */
export function reverseClosure(
  graph: Graph,
  seeds: Iterable<string>,
): DistanceMap {
  return bfsDistances(graph.incoming, seeds);
}

function bfsDistances(
  adj: ReadonlyMap<string, ReadonlySet<string>>,
  seeds: Iterable<string>,
): DistanceMap {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (!dist.has(seed)) {
      dist.set(seed, 0);
      queue.push(seed);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const d = dist.get(current)!;
    const neighbours = adj.get(current);
    if (!neighbours) continue;
    for (const n of neighbours) {
      if (!dist.has(n)) {
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}
