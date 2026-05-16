// Importing this shim BEFORE pixi.js itself disables PIXI's use of
// `new Function(...)` for shader/uniform sync, swapping in a polyfill.
// Required because Chrome extension content scripts (and GitHub pages)
// run under a CSP that forbids `unsafe-eval`.
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Text, FederatedPointerEvent } from "pixi.js";
import { createLayout, type LayoutHandle, type LayoutOptions } from "../layout.js";
import { nodeStyle } from "../style.js";
import type { Scene, SceneEdge, SceneNode } from "../types.js";

export interface RendererOptions {
  readonly container: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly layout?: Partial<LayoutOptions>;
  /** Optional callback: user clicked a node. */
  onNodeClick?(node: SceneNode, event: FederatedPointerEvent): void;
  /** Optional callback: user Cmd/Ctrl-clicked a node ("jump to definition"). */
  onNodeJump?(node: SceneNode, event: FederatedPointerEvent): void;
  /** Optional callback: user right-clicked a node. */
  onNodeContextMenu?(node: SceneNode, event: FederatedPointerEvent): void;
  /** Optional callback: hover (null when leaving). */
  onNodeHover?(node: SceneNode | null): void;
}

export interface RendererHandle {
  /** Re-render with a new scene (e.g. after the user clicks "deep scan"). */
  setScene(scene: Scene): Promise<void>;
  /** Dim non-matching nodes; null restores full brightness. */
  setFilter(matched: ReadonlySet<string> | null): void;
  /** Resize the canvas (responsive layout). */
  resize(width: number, height: number): void;
  /** Tear down everything. */
  destroy(): void;
}

const EDGE_COLOUR = 0x4b5563;
const EDGE_ALPHA = 0.45;
const EDGE_HIGHLIGHT_COLOUR = 0xfbbf24;
const FADED_ALPHA = 0.15;

/**
 * Mount a PIXI canvas in `container` and render `scene`. The returned
 * handle lets the host swap scenes, apply filters, resize, and tear down.
 *
 * The renderer keeps a long-running d3-force simulation; on each PIXI
 * frame we read node positions and redraw. This decouples physics
 * frequency from render frequency cleanly.
 */
export async function mountRenderer(
  scene: Scene,
  opts: RendererOptions,
): Promise<RendererHandle> {
  // Fall back to the container's measured size if the caller passed 0.
  // This catches the case where the host element hasn't been laid out
  // yet at the time the caller queried getBoundingClientRect().
  const measured = opts.container.getBoundingClientRect();
  const width = opts.width > 0 ? opts.width : Math.max(1, measured.width);
  const height = opts.height > 0 ? opts.height : Math.max(1, measured.height);

  const app = new Application();
  await app.init({
    width,
    height,
    background: 0x0f172a,
    antialias: true,
    resolution: globalThis.devicePixelRatio ?? 1,
    autoDensity: true,
  });
  // Pin canvas to fill its container regardless of pixel-level
  // resolution. PIXI sets width/height attributes (logical pixels) but
  // no CSS sizing, so the canvas can render correctly but appear at the
  // wrong size if the parent grows. Setting width/height: 100% makes
  // it follow the host element.
  app.canvas.style.width = "100%";
  app.canvas.style.height = "100%";
  app.canvas.style.display = "block";
  opts.container.appendChild(app.canvas);

  // Camera: outer container we translate/scale for zoom + pan.
  const camera = new Container();
  app.stage.addChild(camera);

  const edgeLayer = new Graphics();
  const nodeLayer = new Container();
  const labelLayer = new Container();
  camera.addChild(edgeLayer);
  camera.addChild(nodeLayer);
  camera.addChild(labelLayer);

  // Per-node sprite state — kept so we can update opacity/transform
  // without rebuilding the scene each tick.
  type NodeView = {
    readonly node: SceneNode;
    readonly graphic: Graphics;
    readonly label: Text;
  };
  let nodeViews: NodeView[] = [];
  let currentScene: Scene = scene;
  let layout: LayoutHandle = createLayout(scene, fullLayoutOpts(opts));
  let hoverId: string | null = null;
  let filterMatched: ReadonlySet<string> | null = null;

  // Camera controls.
  let panning = false;
  let panStart: { x: number; y: number; cx: number; cy: number } | null = null;

  setupCamera(app, camera, {
    onScale(next, cx, cy) {
      const before = camera.toLocal({ x: cx, y: cy });
      camera.scale.set(next);
      const after = camera.toLocal({ x: cx, y: cy });
      camera.x += (after.x - before.x) * next;
      camera.y += (after.y - before.y) * next;
    },
    onPanStart(x, y) {
      panning = true;
      panStart = { x, y, cx: camera.x, cy: camera.y };
    },
    onPanMove(x, y) {
      if (!panning || panStart === null) return;
      camera.x = panStart.cx + (x - panStart.x);
      camera.y = panStart.cy + (y - panStart.y);
    },
    onPanEnd() {
      panning = false;
      panStart = null;
    },
  });

  buildNodeViews();

  app.ticker.add(() => {
    drawEdges();
    drawNodes();
  });

  return {
    async setScene(next: Scene) {
      layout.stop();
      // Preserve positions of nodes that exist in both scenes so the
      // layout flows smoothly from skeleton → final rather than
      // teleporting every node back to the centre.
      const oldPositions = new Map<
        string,
        { x: number; y: number; vx: number; vy: number }
      >();
      for (const n of currentScene.nodes) {
        if (n.x !== undefined && n.y !== undefined) {
          oldPositions.set(n.id, {
            x: n.x,
            y: n.y,
            vx: n.vx ?? 0,
            vy: n.vy ?? 0,
          });
        }
      }
      for (const n of next.nodes) {
        const prev = oldPositions.get(n.id);
        if (prev !== undefined) {
          n.x = prev.x;
          n.y = prev.y;
          n.vx = prev.vx;
          n.vy = prev.vy;
        }
      }

      currentScene = next;
      // Drop old views.
      for (const view of nodeViews) {
        view.graphic.destroy();
        view.label.destroy();
      }
      nodeLayer.removeChildren();
      labelLayer.removeChildren();
      nodeViews = [];
      layout = createLayout(next, fullLayoutOpts(opts));
      buildNodeViews();
    },
    setFilter(matched) {
      filterMatched = matched;
    },
    resize(width: number, height: number) {
      app.renderer.resize(width, height);
    },
    destroy() {
      layout.stop();
      app.destroy(true, { children: true, texture: true });
    },
  };

  // --- builders ---

  function buildNodeViews(): void {
    const maxExports = currentScene.nodes.reduce(
      (m, n) => (n.exportCount > m ? n.exportCount : m),
      1,
    );

    for (const node of currentScene.nodes) {
      const style = nodeStyle(node, { maxExports });
      const g = new Graphics();
      drawNode(g, style);
      g.eventMode = "static";
      g.cursor = "pointer";
      g.on("pointerdown", (ev) => handlePointerDown(node, ev));
      g.on("pointerover", () => {
        hoverId = node.id;
        opts.onNodeHover?.(node);
      });
      g.on("pointerout", () => {
        if (hoverId === node.id) {
          hoverId = null;
          opts.onNodeHover?.(null);
        }
      });
      nodeLayer.addChild(g);

      const label = new Text({
        text: node.displayName,
        style: {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 11,
          fill: style.labelColour,
          align: "center",
        },
      });
      label.anchor.set(0.5, -0.4 - style.radius / 12);
      labelLayer.addChild(label);

      nodeViews.push({ node, graphic: g, label });
    }
  }

  function drawNode(g: Graphics, style: ReturnType<typeof nodeStyle>): void {
    g.clear();
    g.circle(0, 0, style.radius).fill({ color: style.fill, alpha: style.alpha });
    if (style.borderColour !== null) {
      g.circle(0, 0, style.radius)
        .stroke({ color: style.borderColour, width: style.borderWidth });
    }
  }

  function drawEdges(): void {
    edgeLayer.clear();
    const highlightSet = hoverId !== null ? highlightNeighbours(hoverId) : null;
    for (const edge of currentScene.edges) {
      const a = sceneNode(edge.source);
      const b = sceneNode(edge.target);
      if (a === undefined || b === undefined) continue;
      if (a.x === undefined || a.y === undefined) continue;
      if (b.x === undefined || b.y === undefined) continue;

      const baseAlpha = edgeAlpha(edge, highlightSet);
      const colour = highlightSet?.has(a.id) && highlightSet.has(b.id)
        ? EDGE_HIGHLIGHT_COLOUR
        : EDGE_COLOUR;
      edgeLayer
        .moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({ color: colour, alpha: baseAlpha, width: Math.max(0.5, edge.weight * 0.8) });
    }
  }

  function drawNodes(): void {
    for (const view of nodeViews) {
      const { node, graphic, label } = view;
      if (node.x === undefined || node.y === undefined) continue;
      graphic.position.set(node.x, node.y);
      label.position.set(node.x, node.y);

      const dim =
        filterMatched !== null && !filterMatched.has(node.id) ? FADED_ALPHA : null;
      const baseAlpha = nodeStyle(node).alpha;
      graphic.alpha = dim ?? baseAlpha;
      label.alpha = dim ?? 0.85;
    }
  }

  function sceneNode(ref: string | SceneNode): SceneNode | undefined {
    if (typeof ref === "string") {
      return currentScene.nodes.find((n) => n.id === ref);
    }
    return ref;
  }

  function highlightNeighbours(id: string): Set<string> {
    const out = new Set<string>([id]);
    for (const e of currentScene.edges) {
      const aid = typeof e.source === "string" ? e.source : e.source.id;
      const bid = typeof e.target === "string" ? e.target : e.target.id;
      if (aid === id) out.add(bid);
      if (bid === id) out.add(aid);
    }
    return out;
  }

  function edgeAlpha(edge: SceneEdge, highlight: Set<string> | null): number {
    if (highlight === null) return EDGE_ALPHA;
    const aid = typeof edge.source === "string" ? edge.source : edge.source.id;
    const bid = typeof edge.target === "string" ? edge.target : edge.target.id;
    if (highlight.has(aid) && highlight.has(bid)) return 0.95;
    return 0.08;
  }

  function handlePointerDown(node: SceneNode, ev: FederatedPointerEvent): void {
    if (ev.button === 2) {
      opts.onNodeContextMenu?.(node, ev);
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      opts.onNodeJump?.(node, ev);
      return;
    }
    opts.onNodeClick?.(node, ev);

    // Begin drag: pin node, follow pointer, release on up.
    const startLocal = camera.toLocal(ev.global);
    layout.pin(node, startLocal.x, startLocal.y);
    layout.reheat(0.3);

    const move = (mv: FederatedPointerEvent) => {
      const p = camera.toLocal(mv.global);
      layout.pin(node, p.x, p.y);
    };
    const up = () => {
      layout.unpin(node);
      app.stage.off("globalpointermove", move);
      app.stage.off("pointerup", up);
      app.stage.off("pointerupoutside", up);
    };
    app.stage.on("globalpointermove", move);
    app.stage.on("pointerup", up);
    app.stage.on("pointerupoutside", up);
  }

  function fullLayoutOpts(o: RendererOptions): LayoutOptions {
    return {
      width: o.width,
      height: o.height,
      ...(o.layout ?? {}),
    };
  }
}

interface CameraCallbacks {
  onScale(next: number, cx: number, cy: number): void;
  onPanStart(x: number, y: number): void;
  onPanMove(x: number, y: number): void;
  onPanEnd(): void;
}

function setupCamera(
  app: Application,
  _container: Container,
  cb: CameraCallbacks,
): void {
  app.stage.eventMode = "static";
  app.stage.hitArea = app.renderer.screen;

  // Scroll → zoom. Middle-click drag → pan.
  app.canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.001);
      const next = Math.min(8, Math.max(0.1, _container.scale.x * factor));
      const rect = app.canvas.getBoundingClientRect();
      cb.onScale(next, e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false },
  );

  let middleDown = false;
  app.canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 1) {
      middleDown = true;
      cb.onPanStart(e.clientX, e.clientY);
    }
  });
  app.canvas.addEventListener("pointermove", (e) => {
    if (middleDown) cb.onPanMove(e.clientX, e.clientY);
  });
  app.canvas.addEventListener("pointerup", (e) => {
    if (e.button === 1) {
      middleDown = false;
      cb.onPanEnd();
    }
  });
  app.canvas.addEventListener("pointerleave", () => {
    if (middleDown) {
      middleDown = false;
      cb.onPanEnd();
    }
  });
  app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}
