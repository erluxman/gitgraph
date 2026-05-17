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
  // Yellow (Tailwind yellow-500) instead of pure orange: a notch
  // darker than the core accent (#facc15 = yellow-400) so the two
  // yellows don't collide, and clearly distinguishable from the red
  // so a changed file doesn't blur into its downstream cone.
  orange: 0xeab308,
  core: 0xfacc15, // glow accent for core paths
  // White ring used on red (changed) files so they pop visually over
  // the amber/green crowd even on a busy graph.
  redBorder: 0xffffff,
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

  // Changed (red) files are the most important thing on screen — give
  // them a doubled minimum radius AND a 3 px white ring so they read
  // as "the thing you came here to look at" no matter the surrounding
  // density. Orange is bumped a little so consumers don't get lost
  // when the changed file is huge. Plain green files keep the default
  // radius scale.
  const baseRadius = scaleRadius(node.exportCount, o);
  const minForImpact =
    node.impact === "red" ? 32 : node.impact === "orange" ? 9 : o.minRadius;
  const radius = Math.max(baseRadius, minForImpact);

  // Border priority: red gets the white ring even if it's also a core
  // path — the change-status signal takes precedence over the core tag
  // for files that are actually changing. Non-red core paths keep the
  // existing yellow glow.
  let borderColour: number | null = null;
  let borderWidth = 0;
  if (node.impact === "red") {
    borderColour = COLOURS.redBorder;
    borderWidth = 3;
  } else if (node.core) {
    borderColour = COLOURS.core;
    borderWidth = 2;
  }

  return {
    radius,
    fill: baseColourFor(node),
    alpha: 1,
    borderColour,
    borderWidth,
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
