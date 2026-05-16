import { reverseClosure } from "../closure/index.js";
import type { Graph } from "../graph/builder.js";

/**
 * Per-file classification produced by the diff analyzer.
 *
 *  - "red"    — the file appears in the diff
 *  - "orange" — the file (transitively) imports a changed file
 *  - "green"  — the file is not affected
 */
export type ImpactKind = "red" | "orange" | "green";

export interface NodeImpact {
  readonly path: string;
  readonly kind: ImpactKind;
  /**
   * BFS distance from the nearest changed file along reverse edges.
   * For red nodes this is 0; for orange nodes 1+; for green nodes Infinity.
   * Used for the orange fade effect described in SPEC.md.
   */
  readonly distance: number;
  /**
   * Opacity hint for orange nodes, in [0.2, 1.0]. SPEC.md defines:
   *   distance 1 → 1.0, 2 → 0.8, 3 → 0.6, 4 → 0.4, 5+ → 0.2.
   * Red nodes always 1.0, green 1.0 too (caller picks colour).
   */
  readonly opacity: number;
}

export interface DiffResult {
  readonly impacts: ReadonlyMap<string, NodeImpact>;
  /** Files in the diff that exist in the graph. */
  readonly changedKnown: readonly string[];
  /** Files in the diff that aren't in the graph (added/deleted/moved). */
  readonly changedUnknown: readonly string[];
}

export interface AnalyseDiffInput {
  readonly graph: Graph;
  /** Repo-relative paths of files that appear in the diff. */
  readonly changedFiles: readonly string[];
}

/**
 * Run the BFS-from-changed-files classification described in SPEC.md
 * → "Diff Analysis".
 *
 * Unknown changed files are still included in the result so the UI can show
 * them as red, but they don't have downstream consumers we can compute.
 */
export function analyseDiff({ graph, changedFiles }: AnalyseDiffInput): DiffResult {
  const known = changedFiles.filter((p) => graph.nodes.has(p));
  const unknown = changedFiles.filter((p) => !graph.nodes.has(p));

  const distances = reverseClosure(graph, known);
  const impacts = new Map<string, NodeImpact>();

  for (const path of graph.nodes.keys()) {
    const distance = distances.get(path);
    if (distance === undefined) {
      impacts.set(path, { path, kind: "green", distance: Infinity, opacity: 1 });
    } else if (distance === 0) {
      impacts.set(path, { path, kind: "red", distance: 0, opacity: 1 });
    } else {
      impacts.set(path, {
        path,
        kind: "orange",
        distance,
        opacity: orangeOpacity(distance),
      });
    }
  }

  // Surface unknown changed files in the impact map too.
  for (const path of unknown) {
    impacts.set(path, { path, kind: "red", distance: 0, opacity: 1 });
  }

  return { impacts, changedKnown: known, changedUnknown: unknown };
}

/**
 * Map BFS distance → opacity per SPEC.md "Orange Fade Effect".
 * Caps at distance 5; minimum opacity 0.2.
 */
export function orangeOpacity(distance: number): number {
  if (distance <= 1) return 1.0;
  if (distance === 2) return 0.8;
  if (distance === 3) return 0.6;
  if (distance === 4) return 0.4;
  return 0.2;
}
