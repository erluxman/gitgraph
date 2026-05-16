import type { Graph } from "../graph/builder.js";

export interface PageRankOptions {
  /** Probability of teleport. Standard value 0.85 → damping 0.15. */
  readonly damping?: number;
  /** Convergence tolerance — L1 delta below this stops iteration. */
  readonly tolerance?: number;
  /** Safety cap on iterations. */
  readonly maxIterations?: number;
}

/**
 * Standard PageRank on the import graph. Edges are followed in the
 * "importer → imported" direction, so a file imported by many important
 * files scores high. Result is a normalised probability distribution
 * (sums to 1.0).
 *
 * Dangling nodes (no outgoing edges) redistribute their rank uniformly
 * across the graph — the classic "teleport on dead ends" trick.
 */
export function pageRank(
  graph: Graph,
  opts: PageRankOptions = {},
): ReadonlyMap<string, number> {
  const damping = opts.damping ?? 0.85;
  const tolerance = opts.tolerance ?? 1e-6;
  const maxIterations = opts.maxIterations ?? 200;

  const nodes = [...graph.nodes.keys()];
  const n = nodes.length;
  if (n === 0) return new Map();

  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    indexOf.set(nodes[i]!, i);
  }

  // Out-edges from each node. For pure PageRank an edge "u→v" means
  // u confers rank to v. Our `graph.outgoing` already has that semantic.
  const outNeighbours: number[][] = [];
  for (const path of nodes) {
    const set = graph.outgoing.get(path);
    const idxs: number[] = [];
    if (set) {
      for (const n2 of set) {
        const i = indexOf.get(n2);
        if (i !== undefined) idxs.push(i);
      }
    }
    outNeighbours.push(idxs);
  }

  let ranks = new Array<number>(n).fill(1 / n);
  const teleport = (1 - damping) / n;

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Array<number>(n).fill(teleport);

    // Rank from dangling nodes (those with no out-edges) is redistributed
    // uniformly. Accumulate the total dangling rank for this iteration.
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      const out = outNeighbours[i]!;
      if (out.length === 0) {
        danglingMass += ranks[i]!;
      } else {
        const share = (damping * ranks[i]!) / out.length;
        for (const j of out) {
          next[j] = next[j]! + share;
        }
      }
    }
    const danglingShare = (damping * danglingMass) / n;
    for (let i = 0; i < n; i++) {
      next[i] = next[i]! + danglingShare;
    }

    let delta = 0;
    for (let i = 0; i < n; i++) {
      delta += Math.abs(next[i]! - ranks[i]!);
    }
    ranks = next;
    if (delta < tolerance) break;
  }

  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    out.set(nodes[i]!, ranks[i]!);
  }
  return out;
}
