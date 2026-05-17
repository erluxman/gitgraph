import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import { nodeStyle } from "./style.js";
import type { Scene, SceneEdge, SceneNode } from "./types.js";

export interface LayoutOptions {
  readonly width: number;
  readonly height: number;
  /** Multiplier on charge force; smaller = tighter clusters. */
  readonly chargeStrength?: number;
  /** Target distance for link force. */
  readonly linkDistance?: number;
  /** Folder gravity strength — files in the same folder attract each other. */
  readonly folderStrength?: number;
  /** Alpha-decay multiplier. Lower = simulation runs longer. */
  readonly alphaDecay?: number;
}

export interface LayoutHandle {
  readonly simulation: Simulation<SceneNode, SceneEdge>;
  /** Re-energise the simulation (e.g. after the user resizes). */
  reheat(alpha?: number): void;
  /** Pin a node at the given position (drag-start). */
  pin(node: SceneNode, x: number, y: number): void;
  /** Release a pinned node (drag-end). */
  unpin(node: SceneNode): void;
  /**
   * Live-tune force strengths. Values are multipliers on the defaults
   * (1 = no change, 2 = double, 0 = effectively off). Lets the controls
   * panel tweak the layout without restarting the simulation.
   */
  setStrengths(opts: {
    readonly charge?: number;
    readonly link?: number;
    readonly collision?: number;
  }): void;
  /** Stop ticking. Idempotent. */
  stop(): void;
}

/**
 * Wraps a d3-force simulation with the five forces SPEC.md calls out:
 *   charge  → many-body repulsion
 *   link    → attraction along import edges
 *   center  → gentle pull to viewport centre
 *   folder  → same-folder clustering (Obsidian-style)
 *   collide → hard boundary preventing node overlap
 *
 * The simulation runs in-place: each tick mutates `node.x`/`node.y`,
 * which the renderer reads on its next frame.
 */
export function createLayout(scene: Scene, opts: LayoutOptions): LayoutHandle {
  const { width, height } = opts;
  const chargeStrength = opts.chargeStrength ?? -300;
  const linkDistance = opts.linkDistance ?? 75;
  const folderStrength = opts.folderStrength ?? 0.04;
  const alphaDecay = opts.alphaDecay ?? 0.025;

  // Compute folder centroids ahead of time. The folder force pulls each
  // node toward the centroid of its folder; that centroid is recomputed
  // on every tick (cheap — O(n)) inside `applyFolderForce`.
  const folderCentres = new Map<string, { x: number; y: number; count: number }>();

  // Mutable copies of the scene nodes — d3 mutates them. The Scene
  // object's `nodes` are passed through by reference; callers should
  // treat them as the live, animated set.
  const sim = forceSimulation<SceneNode>(scene.nodes as SceneNode[])
    .force(
      "link",
      forceLink<SceneNode, SceneEdge>(scene.edges as SceneEdge[])
        .id((d) => d.id)
        .distance(linkDistance)
        .strength(0.4),
    )
    .force("charge", forceManyBody<SceneNode>().strength(chargeStrength))
    .force("center", forceCenter(width / 2, height / 2).strength(0.05))
    // Collision radius accounts for the label and file-type icon
    // rendered below each node — d3-force's collision is circular and
    // doesn't know about the label rectangle, so we just pad the
    // effective radius by ~14 px to leave room for it. Iterations 3
    // (default 1) makes the constraint actually resolved within a
    // single tick instead of slowly relaxing over many.
    .force(
      "collide",
      forceCollide<SceneNode>()
        .radius((n) => nodeStyle(n).radius + (n.kind === "child" ? 4 : 14))
        .strength(1)
        .iterations(3),
    )
    // Folder gravity: x/y attractors per node, pointing at the folder centroid.
    .force(
      "folderX",
      forceX<SceneNode>().strength(folderStrength).x((n) => {
        const c = folderCentres.get(n.folder);
        return c && c.count > 0 ? c.x / c.count : width / 2;
      }),
    )
    .force(
      "folderY",
      forceY<SceneNode>().strength(folderStrength).y((n) => {
        const c = folderCentres.get(n.folder);
        return c && c.count > 0 ? c.y / c.count : height / 2;
      }),
    )
    .alphaDecay(alphaDecay)
    .on("tick", recomputeFolderCentroids);

  function recomputeFolderCentroids(): void {
    folderCentres.clear();
    for (const n of scene.nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      const entry = folderCentres.get(n.folder) ?? { x: 0, y: 0, count: 0 };
      entry.x += n.x;
      entry.y += n.y;
      entry.count += 1;
      folderCentres.set(n.folder, entry);
    }
  }

  return {
    simulation: sim as unknown as Simulation<SceneNode, SceneEdge>,
    reheat(alpha = 0.7) {
      sim.alpha(alpha).restart();
    },
    pin(node, x, y) {
      node.fx = x;
      node.fy = y;
    },
    unpin(node) {
      node.fx = null;
      node.fy = null;
    },
    setStrengths(s) {
      if (s.charge !== undefined) {
        const force = sim.force("charge") as {
          strength?: (v: number) => unknown;
        } | null;
        force?.strength?.(chargeStrength * s.charge);
      }
      if (s.link !== undefined) {
        const force = sim.force("link") as {
          strength?: (v: number) => unknown;
        } | null;
        force?.strength?.(0.4 * s.link);
      }
      if (s.collision !== undefined) {
        const force = sim.force("collide") as {
          strength?: (v: number) => unknown;
        } | null;
        force?.strength?.(s.collision);
      }
      sim.alpha(0.3).restart();
    },
    stop() {
      sim.stop();
    },
  };
}
