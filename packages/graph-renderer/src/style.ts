import type { SceneNode } from "./types.js";

/**
 * SPEC.md → "Color Coding".
 * These are the *base* hues; the actual rendered colour is the base
 * blended with white toward `(1 - intensity)`.
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

  // Child satellite nodes use a fixed, small radius. They inherit the
  // parent's impact colour but stay visually subordinate.
  if (node.kind === "child") {
    const childColour = darken(baseColourFor(node), 0.55);
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
  // lost when the changed file is huge.
  const baseRadius = scaleRadius(node.exportCount, o);
  const minForImpact =
    node.impact === "red" ? 16 : node.impact === "orange" ? 9 : o.minRadius;
  const radius = Math.max(baseRadius, minForImpact);
  const baseColour = baseColourFor(node);
  // Intensity is 0..1. Red/orange darken with risk; green stays muted.
  // Orange additionally fades by BFS distance.
  const intensity =
    node.impact === "red"
      ? clamp01(0.5 + 0.5 * node.risk)
      : node.impact === "orange"
        ? clamp01(0.4 + 0.5 * node.risk) * orangeFade(node.distance)
        : 0.35;
  const fill = darken(baseColour, intensity);
  const alpha =
    node.impact === "orange" ? Math.max(0.4, orangeFade(node.distance)) : 1;

  return {
    radius,
    fill,
    alpha,
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

/** Multiply a hex colour by `intensity` (0..1). */
function darken(hex: number, intensity: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const k = clamp01(intensity);
  const newR = Math.round(r * k);
  const newG = Math.round(g * k);
  const newB = Math.round(b * k);
  return (newR << 16) | (newG << 8) | newB;
}

function orangeFade(distance: number): number {
  if (distance <= 1) return 1;
  if (distance === 2) return 0.8;
  if (distance === 3) return 0.6;
  if (distance === 4) return 0.4;
  return 0.2;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
