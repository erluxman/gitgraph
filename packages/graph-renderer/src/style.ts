import type { SceneNode } from "./types.js";

/**
 * Three flat colours for the file-impact palette. A file is either
 * safe (green), downstream-affected (orange), or changed (red), and
 * reads as that exact hue at full opacity — no risk-driven darkening
 * and no fade by BFS distance.
 */
export const COLOURS = {
  green: 0x4ade80,
  red: 0xef4444,
  orange: 0xf97316,
  core: 0xfacc15, // glow accent for core paths
} as const;

/** Node radius in pixels. */
export interface NodeStyle {
  readonly radius: number;
  readonly fill: number;
  readonly alpha: number;
  readonly borderColour: number | null;
  readonly borderWidth: number;
  readonly labelColour: number;
}

export interface NodeStyleOptions {
  /** Min radius for a node with zero exports. */
  readonly minRadius?: number;
  /** Max radius for the most-exported file. */
  readonly maxRadius?: number;
  /** Highest exportCount seen in the scene — used to scale. */
  readonly maxExports?: number;
}

const DEFAULT_OPTS: Required<NodeStyleOptions> = {
  minRadius: 6,
  maxRadius: 28,
  maxExports: 50,
};

export function nodeStyle(
  node: SceneNode,
  opts: NodeStyleOptions = {},
): NodeStyle {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Child satellite nodes use a fixed, small radius and a darkened
  // version of their parent's colour so they read as subordinate to
  // the file they orbit. File nodes themselves never darken.
  if (node.kind === "child") {
    const childColour = darkenChild(baseColourFor(node));
    return {
      radius: 4,
      fill: childColour,
      alpha: 0.85,
      borderColour: null,
      borderWidth: 0,
      labelColour: 0xcbd5e1,
    };
  }

  // Changed (red) files are the most important thing on screen — make
  // them prominent even when they have zero exports (e.g. test files,
  // config-like JS). Orange is bumped a little so consumers don't get
  // lost when the changed file is huge. Plain green files keep the
  // default radius scale.
  const baseRadius = scaleRadius(node.exportCount, o);
  const minForImpact =
    node.impact === "red" ? 16 : node.impact === "orange" ? 9 : o.minRadius;
  const radius = Math.max(baseRadius, minForImpact);

  return {
    radius,
    fill: baseColourFor(node),
    alpha: 1,
    borderColour: node.core ? COLOURS.core : null,
    borderWidth: node.core ? 2 : 0,
    labelColour: 0xe5e7eb,
  };
}

function scaleRadius(
  exportCount: number,
  opts: Required<NodeStyleOptions>,
): number {
  if (opts.maxExports <= 0) return opts.minRadius;
  const t = Math.min(1, exportCount / opts.maxExports);
  return opts.minRadius + (opts.maxRadius - opts.minRadius) * Math.sqrt(t);
}

function baseColourFor(node: SceneNode): number {
  if (node.impact === "red") return COLOURS.red;
  if (node.impact === "orange") return COLOURS.orange;
  return COLOURS.green;
}

/** Darken a hex colour to 55% intensity — used only for child satellites. */
function darkenChild(hex: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const k = 0.55;
  const newR = Math.round(r * k);
  const newG = Math.round(g * k);
  const newB = Math.round(b * k);
  return (newR << 16) | (newG << 8) | newB;
}
