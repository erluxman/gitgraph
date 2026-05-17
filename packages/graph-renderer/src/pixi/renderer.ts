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

  // Track pointer position over the canvas so drawNodes can pick the
  // N nodes nearest the cursor for the "auto" label mode.
  app.canvas.addEventListener("pointermove", (e) => {
    const rect = app.canvas.getBoundingClientRect();
    pointerCanvasX = e.clientX - rect.left;
    pointerCanvasY = e.clientY - rect.top;
  });
  app.canvas.addEventListener("pointerleave", () => {
    pointerCanvasX = -1;
    pointerCanvasY = -1;
  });

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
    /** Small colored language badge (TS / JS / D) drawn next to the label. */
    readonly iconView?: Container;
    /** Width of the badge in pixels — used to position the label after it. */
    readonly iconWidth: number;
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
  // Pointer position in canvas-local pixel space. Drives the "auto"
  // label mode — only the N nodes closest to the pointer get labels.
  // Sentinel value (-1) means "no pointer over canvas", in which case
  // auto mode shows no labels.
  let pointerCanvasX = -1;
  let pointerCanvasY = -1;
  const MAX_NEARBY_LABELS = 5;
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
        view.iconView?.destroy({ children: true });
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

      // File-type badge + label-without-extension. File nodes get a
      // small colored badge (TS / JS / D) next to the label; child
      // nodes (symbols) inherit the parent's badge concept-wise and
      // skip the icon entirely to stay subordinate.
      const badge = node.kind === "child" ? null : fileTypeBadge(node.path);
      const labelText =
        node.kind === "child" ? node.displayName : stripExtension(node.displayName);

      const label = new Text({
        text: labelText,
        style: {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          // Tiny on purpose — labels are only shown for the 5 nodes
          // nearest the pointer, so they're a "lean in and read"
          // annotation rather than always-on text. The graph
          // topology + node colour carry the primary signal.
          fontSize: 6,
          fill: style.labelColour,
          align: "center",
        },
      });
      // We anchor at (0.5, 0) so we can position the label and the
      // optional badge as a horizontal group whose centre sits below
      // the node.
      label.anchor.set(0.5, 0);
      labelLayer.addChild(label);

      let iconView: Container | undefined;
      let iconWidth = 0;
      if (badge !== null) {
        iconView = buildBadgeView(badge);
        iconWidth = 10; // icon (~8px) + 2px trailing gap
        labelLayer.addChild(iconView);
      }

      nodeViews.push({
        node,
        graphic: g,
        label,
        ...(iconView !== undefined ? { iconView } : {}),
        iconWidth,
        bornAt: performance.now(),
      });
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
    const bounds = visibleSceneBounds();
    const highlightSet = hoverId !== null ? highlightNeighbours(hoverId) : null;
    for (const edge of currentScene.edges) {
      const a = sceneNode(edge.source);
      const b = sceneNode(edge.target);
      if (a === undefined || b === undefined) continue;
      if (a.x === undefined || a.y === undefined) continue;
      if (b.x === undefined || b.y === undefined) continue;

      // Viewport culling: skip edges where both endpoints lie outside
      // the visible bounds. An edge with one endpoint in view still
      // draws — it points into the off-screen direction so the user
      // sees a hint that there's more graph that way.
      const aIn = inBounds(a.x, a.y, bounds);
      const bIn = inBounds(b.x, b.y, bounds);
      if (!aIn && !bIn) continue;

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
    const now = performance.now();
    if (pulseFrames > 0) pulseFrames--;

    const bounds = visibleSceneBounds();
    // For "auto" label mode we show only the N file nodes whose
    // centres are nearest the pointer. Build that set up-front so we
    // can flag each view in the loop below.
    const nearbyLabelIds = computeNearbyLabelIds(bounds);

    for (const view of nodeViews) {
      const { node, graphic, label, iconView, iconWidth, bornAt } = view;
      if (node.x === undefined || node.y === undefined) continue;

      // Viewport culling: hide nodes whose centres are outside the
      // visible scene bounds (plus a small pad in visibleSceneBounds).
      const inView = inBounds(node.x, node.y, bounds);
      if (!inView) {
        graphic.visible = false;
        label.visible = false;
        if (iconView !== undefined) iconView.visible = false;
        continue;
      }
      graphic.visible = true;

      graphic.position.set(node.x, node.y);

      // Center the (badge + label) group horizontally below the node.
      const radius = nodeStyle(node).radius;
      const yOffset = radius + 6;
      const totalWidth = label.width + iconWidth;
      const groupLeft = node.x - totalWidth / 2;
      if (iconView !== undefined) {
        iconView.position.set(groupLeft, node.y + yOffset);
      }
      label.position.set(groupLeft + iconWidth + label.width / 2, node.y + yOffset);

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

      // Per-node label visibility:
      //   "always"  → every visible node shows its label
      //   "never"   → no labels at all
      //   "auto"    → only the N nodes nearest the pointer
      // Filter-dimmed nodes never show their labels either way.
      const showLabel =
        labelMode === "never"
          ? false
          : dim === FADED_ALPHA
            ? false
            : labelMode === "always"
              ? true
              : nearbyLabelIds.has(node.id);
      label.visible = showLabel;
      label.alpha = showLabel ? 0.85 * fadeIn : 0;
      if (iconView !== undefined) {
        iconView.visible = showLabel;
        iconView.alpha = showLabel ? 0.85 * fadeIn : 0;
      }

      // Brief pulse highlight after focusNode — scale + fade in/out.
      if (pulseId === node.id && pulseFrames > 0) {
        const t = pulseFrames / 60;
        const s = 1 + Math.sin((1 - t) * Math.PI) * 0.35;
        graphic.scale.set(s);
      } else if (graphic.scale.x !== 1) {
        graphic.scale.set(1);
      }
    }
  }

  /**
   * Pick up to MAX_NEARBY_LABELS file-node ids closest to the pointer,
   * in scene coordinates. Skips:
   *   - child satellites (they're noise; we want file names)
   *   - filter-dimmed nodes
   *   - nodes outside the viewport
   *   - nothing if the pointer isn't over the canvas
   */
  function computeNearbyLabelIds(bounds: SceneBounds): Set<string> {
    if (labelMode !== "auto") return new Set();
    if (pointerCanvasX < 0 || pointerCanvasY < 0) return new Set();
    const scale = camera.scale.x || 1;
    const px = (pointerCanvasX - camera.x) / scale;
    const py = (pointerCanvasY - camera.y) / scale;
    const candidates: { id: string; d2: number }[] = [];
    for (const view of nodeViews) {
      const n = view.node;
      if (n.kind === "child") continue;
      if (n.x === undefined || n.y === undefined) continue;
      if (filterMatched !== null && !filterMatched.has(n.id)) continue;
      if (!inBounds(n.x, n.y, bounds)) continue;
      const dx = n.x - px;
      const dy = n.y - py;
      candidates.push({ id: n.id, d2: dx * dx + dy * dy });
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    return new Set(candidates.slice(0, MAX_NEARBY_LABELS).map((c) => c.id));
  }

  /**
   * Current viewport in scene coordinates — the inverse of the camera
   * transform applied to the canvas rectangle. Includes a small pad so
   * nodes don't pop in and out right at the edge during pan.
   */
  function visibleSceneBounds(): SceneBounds {
    const w = app.renderer.width / (globalThis.devicePixelRatio ?? 1);
    const h = app.renderer.height / (globalThis.devicePixelRatio ?? 1);
    const scale = camera.scale.x || 1;
    const pad = 60;
    const x0 = -camera.x / scale - pad;
    const y0 = -camera.y / scale - pad;
    const x1 = x0 + w / scale + 2 * pad;
    const y1 = y0 + h / scale + 2 * pad;
    return { x0, y0, x1, y1 };
  }

  // (computeLabelAlpha removed — label visibility is now per-node
  // based on pointer proximity. See computeNearbyLabelIds + drawNodes.)
  //
  // We still accept labelZoomThreshold from the controls panel but
  // silently ignore it now; the panel's "Show at zoom ≥" slider has
  // become inert in auto mode. Leaving the setter on RendererHandle
  // for API compatibility; callers that don't tune it see no change.
  void labelZoomThreshold;

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
      // Label/icon positioning is computed each frame from radius, so
      // we just redraw the node shape here.
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
      view.iconView?.destroy({ children: true });
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

/** Scene-coordinate viewport bounds, used for culling. */
interface SceneBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function inBounds(x: number, y: number, b: SceneBounds): boolean {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

interface FileBadge {
  readonly color: number;
  /** Compact code language tag — useful when we fall back to text. */
  readonly tag: string;
}

/**
 * Pick a colored language tint for a given file path. Returns null for
 * files we don't render an icon for (anything outside the languages
 * the parser supports).
 *
 * The actual visual is a Material-style "file" glyph filled with this
 * colour — no background pill — so the icon reads as "a file in this
 * language" rather than a chunky pill.
 */
function fileTypeBadge(path: string): FileBadge | null {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return { color: 0x3178c6, tag: "TS" };
  }
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return { color: 0xeac90b, tag: "JS" };
  }
  if (lower.endsWith(".dart")) {
    return { color: 0x40c4ff, tag: "D" };
  }
  return null;
}

// Material Symbols "Description" icon (file with corner fold) — 24×24
// viewBox. Solid path so we can render it via PIXI's Graphics.svg().
// Source: material-symbols/symbols/web/description (Apache 2.0).
const FILE_ICON_PATH =
  "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z";

const BADGE_PX = 8; // rendered icon height, paired with 6px label

/**
 * Render a small file glyph tinted by language. We attempt to use
 * PIXI's `Graphics.svg()` (v8+) so the icon stays crisp at any zoom.
 * If that API isn't present at runtime (or the SVG path fails), we
 * fall back to a small text tag like "TS" — still better than nothing.
 *
 * The Container's local origin is at the top-left so the caller can
 * position it without anchor math.
 */
function buildBadgeView(badge: FileBadge): Container {
  const c = new Container();
  const g = new Graphics();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${FILE_ICON_PATH}" fill="#${badge.color.toString(16).padStart(6, "0")}"/></svg>`;
  const svgFn = (g as unknown as { svg?: (s: string) => Graphics }).svg;
  let drewSvg = false;
  if (typeof svgFn === "function") {
    try {
      svgFn.call(g, svg);
      // After Graphics.svg(), the artwork is in the source's 0..24
      // coordinate space. Scale it down to ~14px tall.
      g.scale.set(BADGE_PX / 24);
      drewSvg = true;
    } catch {
      drewSvg = false;
    }
  }
  if (!drewSvg) {
    // Fallback: tiny letter tag, same color, no pill background.
    const t = new Text({
      text: badge.tag,
      style: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 8,
        fontWeight: "700",
        fill: badge.color,
        align: "center",
      },
    });
    t.anchor.set(0, 0);
    c.addChild(t);
    return c;
  }
  c.addChild(g);
  return c;
}

/**
 * Drop the trailing extension from a filename so the label reads
 * "profile" instead of "profile.ts" — the colored badge already
 * communicates the language.
 */
function stripExtension(displayName: string): string {
  const dot = displayName.lastIndexOf(".");
  // Keep names with no extension as-is, and don't strip when the dot
  // is at position 0 (a dotfile like ".gitkeep").
  if (dot <= 0) return displayName;
  return displayName.slice(0, dot);
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
