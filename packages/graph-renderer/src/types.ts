import type { ImpactKind, ParsedFile } from "@gitgraph/core";

/**
 * Minimal node shape the renderer needs. The core packages produce
 * everything except `x`/`y`/`vx`/`vy`, which d3-force fills in.
 */
export interface SceneNode {
  readonly id: string;
  readonly path: string;
  readonly folder: string;
  readonly displayName: string;
  /** Number of public exports — drives node radius. */
  readonly exportCount: number;
  readonly impact: ImpactKind;
  /** Reverse-BFS distance for the orange fade (0 for red, Infinity for green). */
  readonly distance: number;
  /** Combined risk score in [0, 1]. */
  readonly risk: number;
  /** Whether the file is tagged as a core path. */
  readonly core: boolean;
  /** Mutable position fields managed by d3-force. */
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Set when the user is dragging — d3 honours fx/fy as pinned coords. */
  fx?: number | null;
  fy?: number | null;
}

export interface SceneEdge {
  readonly source: string | SceneNode;
  readonly target: string | SceneNode;
  /** Edge thickness multiplier — proportional to import count between files. */
  readonly weight: number;
}

export interface Scene {
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
}

/**
 * Inputs to the scene builder. The core gives us parsed files, impact
 * classification, and risk scores; we turn them into a Scene the renderer
 * can lay out and paint.
 */
export interface SceneInput {
  readonly files: ReadonlyMap<string, ParsedFile>;
  readonly impactByPath: ReadonlyMap<
    string,
    { readonly kind: ImpactKind; readonly distance: number }
  >;
  readonly riskByPath: ReadonlyMap<string, number>;
  readonly coreByPath: ReadonlySet<string>;
  /** Pre-computed: how many edges go between any two files (for weight). */
  readonly edgeWeights: ReadonlyMap<string, number>;
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}
