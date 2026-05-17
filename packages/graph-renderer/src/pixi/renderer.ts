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
  /** Center the camera on the named node, optionally zooming in. */
  focusNode(id: string, opts?: { zoom?: number; pulse?: boolean }): void;
  /** Reset the camera to identity (zoom=1, centred origin). */
  resetView(): void;
  /**
   * Global node-radius multiplier. 1.0 is default; 0.5 halves all
   * radii (useful for very dense graphs); 2.0 doubles them.
   */
  setNodeScale(multiplier: number): void;
  /** Show all labels (`always`), never (`never`), or fade by zoom (`auto`). */
  setLabelMode(mode: "always" | "never" | "auto"): void;
  /**
   * Auto-mode threshold: labels reach full opacity when zoom ≥ this
   * value. Default 0.8. Lower = labels appear sooner when zooming in.
   */
  setLabelZoomThreshold(threshold: number): void;
  /** Live-tune the simulation forces. Pass partial overrides. */
  setForceStrengths(opts: {
    readonly charge?: number;
    readonly link?: number;
    readonly collision?: number;
  }): void;
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
    /** performance.now() when this view was first rendered — drives the fade-in. */
    readonly bornAt: number;
  };
  let nodeViews: NodeView[] = [];
  const FADE_IN_MS = 320;
  let currentScene: Scene = scene;
  let layout: LayoutHandle = createLayout(scene, fullLayoutOpts(opts));
  let hoverId: string | null = null;
  let filterMatched: ReadonlySet<string> | null = null;
  // File nodes currently showing satellite children. Toggled via
  // single-click on a file node.
  const expanded = new Set<string>();
  // Controls-panel-driven state. None of these affect tests; they're
  // pure visual / interaction tweaks.
  let nodeScale = 1;
  let labelMode: "always" | "never" | "auto" = "auto";
  let labelZoomThreshold = 0.8;
  // Brief highlight after focusNode — counts down each tick.
  let pulseId: string | null = null;
  let pulseFrames = 0;

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
    onPanBy(dx, dy) {
      // Trackpad two-finger swipe: nudge the camera by raw screen
      // deltas. No start/end pairing — each scroll event is atomic.
      camera.x += dx;
      camera.y += dy;
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
    focusNode(id, opts2) {
      const node = currentScene.nodes.find((n) => n.id === id);
      if (node === undefined) return;
      if (node.x === undefined || node.y === undefined) return;
      // Set zoom first, then translate the camera so the node lands
      // at the canvas center. Camera transform is in screen coords.
      const zoom = opts2?.zoom ?? Math.max(camera.scale.x, 1.2);
      camera.scale.set(zoom);
      const w = app.renderer.width / (globalThis.devicePixelRatio ?? 1);
      const h = app.renderer.height / (globalThis.devicePixelRatio ?? 1);
      camera.x = w / 2 - node.x * zoom;
      camera.y = h / 2 - node.y * zoom;
      if (opts2?.pulse !== false) {
        pulseId = id;
        pulseFrames = 60; // ~1s at 60fps
      }
    },
    resetView() {
      camera.scale.set(1);
      camera.x = 0;
      camera.y = 0;
    },
    setNodeScale(multiplier) {
      nodeScale = Math.max(0.1, Math.min(5, multiplier));
      rebuildNodeShapes();
    },
    setLabelMode(mode) {
      labelMode = mode;
    },
    setLabelZoomThreshold(threshold) {
      labelZoomThreshold = Math.max(0.1, Math.min(5, threshold));
    },
    setForceStrengths(strengths) {
      layout.setStrengths(strengths);
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
      const style = scaledStyle(node, maxExports);
      const g = new Graphics();
      drawNode(g, style, node);
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

      nodeViews.push({ node, graphic: g, label, bornAt: performance.now() });
    }
  }

  function drawNode(
    g: Graphics,
    style: ReturnType<typeof nodeStyle>,
    node: SceneNode,
  ): void {
    g.clear();
    const r = style.radius;
    // Symbol-driven shape (child nodes only). File and unknown-kind
    // nodes stay as circles.
    if (node.kind === "child") {
      switch (node.symbol) {
        case "class":
          // Rounded rectangle, roughly square.
          g.roundRect(-r, -r * 0.8, r * 2, r * 1.6, 2)
            .fill({ color: style.fill, alpha: style.alpha });
          return;
        case "variable":
          // Diamond — rotated square.
          g.moveTo(0, -r)
            .lineTo(r, 0)
            .lineTo(0, r)
            .lineTo(-r, 0)
            .closePath()
            .fill({ color: style.fill, alpha: style.alpha });
          return;
        case "widget":
          // Hexagon, hints at "this is something special" (Flutter widget).
          drawPolygon(g, r, 6);
          g.fill({ color: style.fill, alpha: style.alpha });
          return;
        // function / undefined fall through to circle.
      }
    }
    g.circle(0, 0, r).fill({ color: style.fill, alpha: style.alpha });
    if (style.borderColour !== null) {
      g.circle(0, 0, r)
        .stroke({ color: style.borderColour, width: style.borderWidth });
    }
  }

  function drawPolygon(g: Graphics, r: number, sides: number): void {
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
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
    const labelAlpha = computeLabelAlpha();
    const now = performance.now();
    if (pulseFrames > 0) pulseFrames--;
    for (const view of nodeViews) {
      const { node, graphic, label, bornAt } = view;
      if (node.x === undefined || node.y === undefined) continue;
      graphic.position.set(node.x, node.y);
      label.position.set(node.x, node.y);

      const dim =
        filterMatched !== null && !filterMatched.has(node.id) ? FADED_ALPHA : null;
      const baseAlpha = nodeStyle(node).alpha;

      // Fade in newly-added nodes over FADE_IN_MS.
      const age = now - bornAt;
      const fadeIn = age < FADE_IN_MS ? age / FADE_IN_MS : 1;

      // Slow ambient pulse on red (changed) file nodes — 0.85..1.0
      // alpha multiplier on a 2.4s sin wave. Subtle but draws the
      // eye to "active" files without animation noise.
      const redPulse =
        node.impact === "red" && node.kind !== "child"
          ? 0.85 + 0.15 * (0.5 + 0.5 * Math.sin(now / 380))
          : 1;

      graphic.alpha = (dim ?? baseAlpha) * fadeIn * redPulse;
      // Labels are binary: either rendered at full opacity or not
      // rendered at all. Setting label.visible explicitly skips the
      // PIXI Text render pass so we don't get ghost text outlines.
      const showLabel = labelAlpha > 0 && dim !== FADED_ALPHA;
      label.visible = showLabel;
      label.alpha = showLabel ? labelAlpha * fadeIn : 0;

      // Brief pulse highlight after focusNode — scale + fade in/out.
      if (pulseId === node.id && pulseFrames > 0) {
        const t = pulseFrames / 60;
        const scale = 1 + Math.sin((1 - t) * Math.PI) * 0.35;
        graphic.scale.set(scale);
      } else if (graphic.scale.x !== 1) {
        graphic.scale.set(1);
      }
    }
  }

  /**
   * Auto / always / never label-alpha computation. Auto is BINARY —
   * either we're past the zoom threshold (full opacity) or we're not
   * (label hidden entirely). A linear fade looked like permanent ghost
   * text at low zoom and made the graph hard to read.
   */
  function computeLabelAlpha(): number {
    if (labelMode === "never") return 0;
    if (labelMode === "always") return 0.85;
    return camera.scale.x >= labelZoomThreshold ? 0.85 : 0;
  }

  /** Wrap nodeStyle with the global radius multiplier from setNodeScale. */
  function scaledStyle(
    node: SceneNode,
    maxExports: number,
  ): ReturnType<typeof nodeStyle> {
    const base = nodeStyle(node, { maxExports });
    if (nodeScale === 1) return base;
    return { ...base, radius: base.radius * nodeScale };
  }

  /**
   * Re-draw every node's graphics with the current `nodeScale`. Cheap
   * because we don't rebuild the simulation or recreate child views —
   * we just `g.clear()` + redraw at the new radius.
   */
  function rebuildNodeShapes(): void {
    const maxExports = currentScene.nodes.reduce(
      (m, n) => (n.exportCount > m ? n.exportCount : m),
      1,
    );
    for (const view of nodeViews) {
      const style = scaledStyle(view.node, maxExports);
      drawNode(view.graphic, style, view.node);
      view.label.anchor.set(0.5, -0.4 - style.radius / 12);
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

  /** Threshold (px in scene coords) before a pointerdown counts as a drag, not a click. */
  const DRAG_THRESHOLD = 4;

  function handlePointerDown(node: SceneNode, ev: FederatedPointerEvent): void {
    if (ev.button === 2) {
      opts.onNodeContextMenu?.(node, ev);
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      opts.onNodeJump?.(node, ev);
      return;
    }

    // Pin and begin tracking. We don't fire `onNodeClick` or toggle
    // expansion yet — those happen on pointerup if the pointer never
    // crossed DRAG_THRESHOLD. That way the user can drag without
    // accidentally expanding every file they touch.
    const startLocal = camera.toLocal(ev.global);
    layout.pin(node, startLocal.x, startLocal.y);
    layout.reheat(0.3);
    let dragged = false;

    const move = (mv: FederatedPointerEvent) => {
      const p = camera.toLocal(mv.global);
      if (
        !dragged &&
        Math.hypot(p.x - startLocal.x, p.y - startLocal.y) > DRAG_THRESHOLD
      ) {
        dragged = true;
      }
      layout.pin(node, p.x, p.y);
    };
    const up = () => {
      layout.unpin(node);
      app.stage.off("globalpointermove", move);
      app.stage.off("pointerup", up);
      app.stage.off("pointerupoutside", up);
      if (!dragged) {
        opts.onNodeClick?.(node, ev);
        // Toggle expand state only for file nodes with children. Child
        // nodes themselves are non-expandable.
        if (node.kind !== "child" && (node.children?.length ?? 0) > 0) {
          if (expanded.has(node.id)) collapseNode(node);
          else expandNode(node);
        }
      }
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

  // --- expand / collapse ---

  function expandNode(parent: SceneNode): void {
    if (parent.children === undefined || parent.children.length === 0) return;
    if (expanded.has(parent.id)) return;

    const px = parent.x ?? 0;
    const py = parent.y ?? 0;
    const orbitR = Math.max(34, parent.children.length * 5);
    const newNodes: SceneNode[] = parent.children.map((child, i) => {
      const angle = (i / parent.children!.length) * Math.PI * 2;
      return {
        id: `${parent.id}::${child.symbol}::${child.name}`,
        path: parent.path,
        folder: parent.folder,
        displayName: child.name,
        exportCount: 0,
        impact: parent.impact,
        distance: parent.distance,
        risk: parent.risk * 0.4,
        core: false,
        kind: "child",
        symbol: child.symbol,
        parentId: parent.id,
        x: px + Math.cos(angle) * orbitR,
        y: py + Math.sin(angle) * orbitR,
      };
    });
    const newEdges: SceneEdge[] = newNodes.map((c) => ({
      source: parent.id,
      target: c.id,
      weight: 0.4,
    }));

    expanded.add(parent.id);
    mutateSceneAndRefresh([...currentScene.nodes, ...newNodes], [
      ...currentScene.edges,
      ...newEdges,
    ]);
  }

  function collapseNode(parent: SceneNode): void {
    if (!expanded.has(parent.id)) return;
    const childIdPrefix = `${parent.id}::`;
    const newNodes = currentScene.nodes.filter(
      (n) => n.kind !== "child" || !n.id.startsWith(childIdPrefix),
    );
    const newEdges = currentScene.edges.filter((e) => {
      const aid = typeof e.source === "string" ? e.source : e.source.id;
      const bid = typeof e.target === "string" ? e.target : e.target.id;
      return !aid.startsWith(childIdPrefix) && !bid.startsWith(childIdPrefix);
    });
    expanded.delete(parent.id);
    mutateSceneAndRefresh(newNodes, newEdges);
  }

  /**
   * Swap the scene's node/edge lists in place, rebuild visual layers
   * for the new set, and re-bind the simulation's nodes/links. Unlike
   * `setScene`, this keeps the same simulation instance running — the
   * existing nodes stay at their current positions, only the delta
   * (added or removed nodes) is rearranged.
   */
  function mutateSceneAndRefresh(
    nodes: readonly SceneNode[],
    edges: readonly SceneEdge[],
  ): void {
    currentScene = { nodes, edges };
    for (const view of nodeViews) {
      view.graphic.destroy();
      view.label.destroy();
    }
    nodeLayer.removeChildren();
    labelLayer.removeChildren();
    nodeViews = [];
    buildNodeViews();
    // Rebind d3-force's working arrays. forceLink is keyed by `id`, so
    // passing the new edge list lets it re-resolve string→node refs.
    layout.simulation.nodes(nodes as SceneNode[]);
    const linkForce = layout.simulation.force("link") as unknown as
      | { links?: (l: SceneEdge[]) => void }
      | undefined;
    linkForce?.links?.(edges as SceneEdge[]);
    layout.reheat(0.5);
  }
}

interface CameraCallbacks {
  onScale(next: number, cx: number, cy: number): void;
  onPanStart(x: number, y: number): void;
  onPanMove(x: number, y: number): void;
  onPanEnd(): void;
  /** Direct delta pan for trackpad two-finger swipes (no start/move/end). */
  onPanBy(dx: number, dy: number): void;
}

function setupCamera(
  app: Application,
  _container: Container,
  cb: CameraCallbacks,
): void {
  app.stage.eventMode = "static";
  app.stage.hitArea = app.renderer.screen;

  // --- Wheel: pinch-zoom vs trackpad-swipe vs mouse-wheel ---
  //
  // Pinch on macOS sends `wheel` with ctrlKey=true. Two-finger trackpad
  // swipes send `wheel` with deltaMode=0 (pixels) and fractional or
  // small (<50) deltas. Mouse wheels typically send larger integer
  // deltas. We use these signals to pick zoom vs pan.
  app.canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const isPinch = e.ctrlKey;
      const isTrackpadSwipe =
        !isPinch &&
        e.deltaMode === 0 &&
        (e.deltaX !== 0 ||
          (Math.abs(e.deltaY) < 50 && !Number.isInteger(e.deltaY)) ||
          // Pure horizontal swipe → always pan.
          Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5);
      if (isPinch) {
        // Pinch step — smaller exponent so the zoom feels precise.
        const factor = Math.exp(-e.deltaY * 0.01);
        applyZoom(factor, e);
      } else if (isTrackpadSwipe) {
        cb.onPanBy(-e.deltaX, -e.deltaY);
      } else {
        // Mouse wheel → standard zoom.
        const factor = Math.exp(-e.deltaY * 0.001);
        applyZoom(factor, e);
      }
    },
    { passive: false },
  );

  function applyZoom(factor: number, e: WheelEvent): void {
    const next = Math.min(8, Math.max(0.1, _container.scale.x * factor));
    const rect = app.canvas.getBoundingClientRect();
    cb.onScale(next, e.clientX - rect.left, e.clientY - rect.top);
  }

  // --- Middle-click drag pan (existing behaviour) ---
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

  // --- Left-click drag on the empty background → pan ---
  //
  // Implemented with canvas-level DOM events plus a PIXI hit-test so
  // we never touch the stage's event flow. If the left-click landed on
  // a node, the renderer's node-pointerdown handler runs as normal and
  // we bail out of background-pan; otherwise we pan the camera.
  let bgDown = false;
  app.canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (hitNode(app, e.clientX, e.clientY)) return; // node will handle it
    bgDown = true;
    cb.onPanStart(e.clientX, e.clientY);
  });
  app.canvas.addEventListener("pointermove", (e) => {
    if (!bgDown) return;
    cb.onPanMove(e.clientX, e.clientY);
  });
  const endBgPan = (): void => {
    if (!bgDown) return;
    bgDown = false;
    cb.onPanEnd();
  };
  app.canvas.addEventListener("pointerup", (e) => {
    if (e.button === 0) endBgPan();
  });
  app.canvas.addEventListener("pointerleave", endBgPan);
}

/**
 * Use PIXI's federated-event hit-test to find out whether a screen-
 * coordinate point lands on an interactive node graphic. Used by the
 * background-pan handler to skip starting a pan when the user is
 * actually clicking a node.
 */
function hitNode(app: Application, clientX: number, clientY: number): boolean {
  const rect = app.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const boundary = (app.renderer.events as { rootBoundary?: unknown })
    .rootBoundary as { hitTest?: (x: number, y: number) => unknown } | undefined;
  if (boundary?.hitTest === undefined) return false;
  const target = boundary.hitTest(x, y);
  // Stage itself is the "no node" return; anything else is a node graphic.
  return target !== null && target !== undefined && target !== app.stage;
}
