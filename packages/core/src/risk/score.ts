import type { GitGraphConfig } from "../config/index.js";
import type { Graph } from "../graph/builder.js";
import { pageRank, type PageRankOptions } from "./pagerank.js";

/**
 * Per-file risk score. SPEC.md → "Risk Scoring":
 *   combined = 0.7 * pagerank_norm + 0.3 * indegree_norm
 *   if file ∈ corePaths: combined *= 1.5
 *
 * Both inputs are normalised to [0, 1] before combining, and the final
 * score is clamped to [0, 1] (a core-boosted hub can exceed 1.0; we cap it).
 */
export interface RiskScore {
  readonly path: string;
  readonly pageRank: number;       // raw PR probability
  readonly inDegree: number;       // raw count
  readonly core: boolean;          // was a core-path multiplier applied
  readonly combined: number;       // [0, 1]
}

export interface ScoreOptions {
  readonly pageRank?: PageRankOptions;
  /** Weight for pageRank component. SPEC = 0.7. */
  readonly pageRankWeight?: number;
  /** Weight for in-degree component. SPEC = 0.3. */
  readonly inDegreeWeight?: number;
  /** Multiplier for files in `corePaths`. SPEC = 1.5. */
  readonly coreBoost?: number;
  /**
   * Files to treat as "core architecture" (usually pulled from `.gitgraph.json`).
   */
  readonly corePaths?: readonly string[];
}

export function scoreRisk(
  graph: Graph,
  opts: ScoreOptions = {},
): ReadonlyMap<string, RiskScore> {
  const prWeight = opts.pageRankWeight ?? 0.7;
  const idWeight = opts.inDegreeWeight ?? 0.3;
  const coreBoost = opts.coreBoost ?? 1.5;
  const corePaths = new Set(opts.corePaths ?? []);

  const pr = pageRank(graph, opts.pageRank);

  // In-degree per node.
  const inDeg = new Map<string, number>();
  for (const path of graph.nodes.keys()) {
    inDeg.set(path, graph.incoming.get(path)?.size ?? 0);
  }

  // Normalise both inputs to [0, 1] by their max value (so we don't
  // accidentally squash everything when no file imports anything).
  const maxPr = max(pr.values()) || 1;
  const maxId = max(inDeg.values()) || 1;

  const result = new Map<string, RiskScore>();
  for (const path of graph.nodes.keys()) {
    const prRaw = pr.get(path) ?? 0;
    const idRaw = inDeg.get(path) ?? 0;
    const prNorm = prRaw / maxPr;
    const idNorm = idRaw / maxId;
    let combined = prWeight * prNorm + idWeight * idNorm;
    const core = corePaths.has(path);
    if (core) combined *= coreBoost;
    if (combined > 1) combined = 1;
    if (combined < 0) combined = 0;
    result.set(path, {
      path,
      pageRank: prRaw,
      inDegree: idRaw,
      core,
      combined,
    });
  }
  return result;
}

export function scoreRiskFromConfig(
  graph: Graph,
  config: Pick<GitGraphConfig, "corePaths">,
  opts: Omit<ScoreOptions, "corePaths"> = {},
): ReadonlyMap<string, RiskScore> {
  return scoreRisk(graph, { ...opts, corePaths: config.corePaths });
}

function max(iter: Iterable<number>): number {
  let m = 0;
  for (const v of iter) {
    if (v > m) m = v;
  }
  return m;
}
