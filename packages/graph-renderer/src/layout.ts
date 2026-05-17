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
  /**
   * Tune d3-force's velocityDecay directly. Lower = nodes keep their
   * velocity longer (more inertia / less viscous), higher = velocity
   * dies fast (settled, viscous). Useful for the "viscosity" control
   * which pairs this with the nudge() impulse so the graph can wobble
   * when the camera moves and slowly settle.
   */
  setVelocityDecay(decay: number): void;
  /**
   * Apply a random velocity impulse to every unpinned node, scaled by
   * `magnitude`. Each component is drawn from [-magnitude, magnitude]
   * and added to the node's vx/vy. Also bumps the simulation alpha so
   * the kick actually translates to motion. Used by the renderer to
   * wiggle the graph in response to camera pan/zoom.
   */
  nudge(magnitude: number): void;
  /**
   * Update the layout's target dimensions. The center force re-aims
   * at (w/2, h/2) and the folder forces' fallback target follows.
   * Without this, a container that grows after mount leaves the
   * simulation pulling nodes to the OLD (smaller) centre — which
   * ends up in the top-left quadrant of the new canvas.
   */
  setBounds(w: number, h: number): void;
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
  // Mutable so setBounds() can grow the layout's working dimensions
  // after the container resizes (initial mount measures may be stale).
  let width = opts.width;
  let height = opts.height;
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
    // Centroid pull — keeps the cluster's centre of mass at the canvas
    // centre. Bumped from 0.05 → 0.25 so this actually anchors the
    // cluster instead of getting overpowered by the stronger charge.
    .force("center", forceCenter(width / 2, height / 2).strength(0.25))
    // PER-NODE soft pull toward the centre, on top of the centroid
    // pull above. On large graphs, charge can shoot outlier nodes
    // hundreds of px off-screen, dragging the centroid with them.
    // forceCenter compensates by translating the whole cluster — but
    // that visibly shoves the cluster to one side. A weak per-node
    // X/Y pull keeps individual nodes near the canvas so no one ever
    // escapes far enough to break the layout.
    .force(
      "anchorX",
      forceX<SceneNode>().strength(0.03).x(() => width / 2),
    )
    .force(
      "anchorY",
      forceY<SceneNode>().strength(0.03).y(() => height / 2),
    )
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
    setVelocityDecay(decay) {
      const clamped = Math.max(0.05, Math.min(0.95, decay));
      sim.velocityDecay(clamped);
    },
    nudge(magnitude) {
      const m = Math.max(0, magnitude);
      if (m === 0) return;
      for (const n of scene.nodes) {
        // Skip pinned nodes — they're being dragged, no extra wobble.
        if (n.fx !== undefined && n.fx !== null) continue;
        if (n.fy !== undefined && n.fy !== null) continue;
        n.vx = (n.vx ?? 0) + (Math.random() - 0.5) * 2 * m;
        n.vy = (n.vy ?? 0) + (Math.random() - 0.5) * 2 * m;
      }
      // Wake the simulation so the kick actually translates to motion.
      // Use a small alpha (0.05) — enough to keep ticking for ~2s but
      // not so high that we reshuffle the whole layout.
      if (sim.alpha() < 0.05) sim.alpha(0.05).restart();
    },
    setBounds(w, h) {
      // Ignore obviously bad inputs.
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return;
      }
      // Only react to a real change — and only restart the sim if the
      // change is meaningful, so a 1-pixel browser-zoom event doesn't
      // re-shake the layout.
      const dw = Math.abs(w - width);
      const dh = Math.abs(h - height);
      width = w;
      height = h;
      // Update the centre force to aim at the new middle.
      const centre = sim.force("center") as {
        x?: (v: number) => unknown;
        y?: (v: number) => unknown;
      } | null;
      centre?.x?.(width / 2);
      centre?.y?.(height / 2);
      // Reheat only if it's a substantial size change so nodes don't
      // get nudged on minor resizes.
      if (dw > 50 || dh > 50) sim.alpha(0.3).restart();
    },
    stop() {
      sim.stop();
    },
  };
}
