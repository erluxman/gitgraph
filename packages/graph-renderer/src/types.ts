import type { ImpactKind, ParsedFile, SymbolKind } from "@gitgraph/core";

/**
 * What kind of node this is.
 *
 *   file   — top-level node, one per source file. Always rendered.
 *   child  — function/class/variable/widget that orbits its parent
 *            file when the user has expanded that file. Created on
 *            demand by `expandNode()`, removed on collapse.
 */
export type SceneNodeKind = "file" | "child";

/**
 * Minimal node shape the renderer needs. The core packages produce
 * everything except `x`/`y`/`vx`/`vy`, which d3-force fills in.
 */
export interface SceneNode {
  readonly id: string;
  readonly path: string;
  readonly folder: string;
  readonly displayName: string;
  /** Number of public exports — drives node radius for file nodes. */
  readonly exportCount: number;
  readonly impact: ImpactKind;
  /** Reverse-BFS distance for the orange fade (0 for red, Infinity for green). */
  readonly distance: number;
  /** Combined risk score in [0, 1]. */
  readonly risk: number;
  /** Whether the file is tagged as a core path. */
  readonly core: boolean;
  /**
   * What this node represents. File nodes are the default; child nodes
   * are created when the user expands a file and inherit the parent's
   * impact/risk for visual continuity.
   */
  readonly kind?: SceneNodeKind;
  /**
   * For child nodes only: the symbol kind drives the shape (function =
   * small circle, class = rounded rect, variable = diamond, widget =
   * accent-coloured circle).
   */
  readonly symbol?: SymbolKind;
  /** For child nodes only: the parent file's id, used as the link target. */
  readonly parentId?: string;
  /**
   * For file nodes only: the exported symbols available for expansion.
   * The renderer uses this to spawn child satellites on click. Empty
   * array for files with no exports (those become non-expandable).
   */
  readonly children?: readonly {
    readonly name: string;
    readonly symbol: SymbolKind;
    readonly line: number;
  }[];
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
