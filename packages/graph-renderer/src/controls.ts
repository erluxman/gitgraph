import type { RendererHandle } from "./pixi/renderer.js";
import type { Scene } from "./types.js";

/**
 * Floating controls panel — Obsidian-style. Mounts into `host`, returns
 * a teardown function. Pure DOM (no PIXI), styled inline so it works
 * in any host that has the renderer.
 *
 * Includes a search box that focuses the camera on a matched file.
 *
 * The panel is collapsible (gear icon toggles visibility) so it stays
 * out of the way until needed.
 */
export interface ControlsPanelHandle {
  /** Update the search index after a setScene() — call from the host. */
  updateScene(scene: Scene): void;
  /** Remove the panel from the DOM. */
  destroy(): void;
}

export interface ControlsPanelOptions {
  /** Initial scene used to seed the search index. */
  readonly scene: Scene;
  /** Where the panel anchors. */
  readonly position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
}

export function mountControlsPanel(
  host: HTMLElement,
  handle: RendererHandle,
  opts: ControlsPanelOptions,
): ControlsPanelHandle {
  let scene = opts.scene;
  const root = document.createElement("div");
  root.className = "gg-controls";
  Object.assign(root.style, basePositionStyle(opts.position ?? "top-right"));
  Object.assign(root.style, {
    background: "rgba(15, 23, 42, 0.92)",
    border: "1px solid #1f2937",
    borderRadius: "8px",
    color: "#e5e7eb",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: "12px",
    boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
    zIndex: "10",
  } satisfies Partial<CSSStyleDeclaration>);

  root.innerHTML = `
    <div class="gg-controls__header" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #1e293b;cursor:pointer;user-select:none;background:linear-gradient(135deg, rgba(59,130,246,0.18), rgba(15,23,42,0.0) 60%);">
      <strong style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#cbd5e1;">Graph controls</strong>
      <span class="gg-controls__toggle" style="font-size:14px;line-height:1;color:#94a3b8;">−</span>
    </div>
    <div class="gg-controls__body" style="padding:10px 12px;width:240px;">
      <!-- Search -->
      <label style="display:block;color:#9ca3af;margin-bottom:4px;">Search files <span style="color:#6b7280;font-size:10px;margin-left:4px;">⌘K to open palette</span></label>
      <div class="gg-controls__chips" style="display:none;flex-wrap:wrap;gap:4px;margin-bottom:6px;"></div>
      <input class="gg-controls__search" type="text" placeholder="filename or path…" autocomplete="off"
        style="width:100%;padding:5px 7px;background:#111827;color:#e5e7eb;border:1px solid #1f2937;border-radius:4px;font-size:12px;box-sizing:border-box;" />
      <div class="gg-controls__results" style="margin-top:4px;max-height:140px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;"></div>

      <hr style="border:0;border-top:1px solid #1f2937;margin:12px 0;" />

      <!-- Labels -->
      <label style="display:block;color:#9ca3af;margin-bottom:4px;">Labels</label>
      <select class="gg-controls__label-mode" style="width:100%;padding:4px 6px;background:#111827;color:#e5e7eb;border:1px solid #1f2937;border-radius:4px;font-size:12px;">
        <option value="auto">Auto (fade by zoom)</option>
        <option value="always">Always show</option>
        <option value="never">Never show</option>
      </select>
      <div class="gg-controls__label-threshold-row" style="margin-top:6px;">
        <label style="display:flex;align-items:center;gap:8px;color:#6b7280;font-size:11px;">
          Show at zoom ≥
          <input class="gg-controls__label-threshold" type="range" min="0.3" max="2" step="0.1" value="0.8" style="flex:1;" />
          <span class="gg-controls__label-threshold-val" style="width:30px;text-align:right;">0.8</span>
        </label>
      </div>

      <hr style="border:0;border-top:1px solid #1f2937;margin:12px 0;" />

      <!-- Node size -->
      <label style="display:flex;align-items:center;gap:8px;color:#9ca3af;">
        Node size
        <input class="gg-controls__node-scale" type="range" min="0.5" max="2.5" step="0.1" value="1" style="flex:1;" />
        <span class="gg-controls__node-scale-val" style="width:30px;text-align:right;">1.0×</span>
      </label>

      <hr style="border:0;border-top:1px solid #1f2937;margin:12px 0;" />

      <!-- Forces -->
      <label style="display:block;color:#9ca3af;margin-bottom:6px;">Forces</label>
      ${forceSliderHtml("charge", "Charge (repulsion)", 0.2, 3, 1)}
      ${forceSliderHtml("link", "Link strength", 0.2, 3, 1)}
      ${forceSliderHtml("collision", "Collision", 0.5, 2, 1)}
    </div>
  `;
  host.appendChild(root);

  const body = root.querySelector<HTMLDivElement>(".gg-controls__body")!;
  const toggle = root.querySelector<HTMLSpanElement>(".gg-controls__toggle")!;
  const setCollapsed = (collapsed: boolean): void => {
    body.style.display = collapsed ? "none" : "";
    toggle.textContent = collapsed ? "+" : "−";
  };
  root.querySelector<HTMLDivElement>(".gg-controls__header")!
    .addEventListener("click", () => {
      setCollapsed(body.style.display !== "none");
    });

  // --- Search + focused-file chip ---
  const searchInput = root.querySelector<HTMLInputElement>(".gg-controls__search")!;
  const resultsBox = root.querySelector<HTMLDivElement>(".gg-controls__results")!;
  const chipsBox = root.querySelector<HTMLDivElement>(".gg-controls__chips")!;
  let focusedPath: string | null = null;

  const renderChips = (): void => {
    chipsBox.innerHTML = "";
    if (focusedPath === null) {
      chipsBox.style.display = "none";
      return;
    }
    chipsBox.style.display = "flex";
    const chip = document.createElement("span");
    chip.title = focusedPath;
    Object.assign(chip.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      background: "linear-gradient(180deg, #1e3a8a, #1e40af)",
      color: "#dbeafe",
      borderRadius: "12px",
      padding: "2px 4px 2px 8px",
      fontSize: "10px",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      maxWidth: "100%",
    } satisfies Partial<CSSStyleDeclaration>);
    const label = document.createElement("span");
    label.textContent = `focus: ${basenameOf(focusedPath)}`;
    Object.assign(label.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      maxWidth: "180px",
    } satisfies Partial<CSSStyleDeclaration>);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    Object.assign(x.style, {
      background: "transparent",
      border: "0",
      color: "#dbeafe",
      cursor: "pointer",
      padding: "0 4px",
      fontSize: "13px",
      lineHeight: "1",
    } satisfies Partial<CSSStyleDeclaration>);
    x.addEventListener("click", () => {
      focusedPath = null;
      handle.resetView();
      renderChips();
    });
    chip.appendChild(label);
    chip.appendChild(x);
    chipsBox.appendChild(chip);
  };

  const renderResults = (): void => {
    const q = searchInput.value.trim().toLowerCase();
    resultsBox.innerHTML = "";
    if (q.length === 0) return;
    const matches = scene.nodes
      .filter(
        (n) =>
          n.kind !== "child" &&
          (n.displayName.toLowerCase().includes(q) ||
            n.path.toLowerCase().includes(q)),
      )
      .slice(0, 8);
    for (const node of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.textContent = node.path;
      Object.assign(row.style, {
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "3px 6px",
        margin: "1px 0",
        background: "transparent",
        color: "#e5e7eb",
        border: "0",
        borderRadius: "3px",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: "11px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      } satisfies Partial<CSSStyleDeclaration>);
      row.addEventListener("mouseenter", () => {
        row.style.background = "#1f2937";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "transparent";
      });
      row.addEventListener("click", () => {
        handle.focusNode(node.id, { zoom: 1.6, pulse: true });
        focusedPath = node.path;
        renderChips();
      });
      resultsBox.appendChild(row);
    }
  };
  searchInput.addEventListener("input", renderResults);

  // --- Label mode ---
  const labelModeSel = root.querySelector<HTMLSelectElement>(".gg-controls__label-mode")!;
  const labelThresholdRow = root.querySelector<HTMLDivElement>(".gg-controls__label-threshold-row")!;
  const labelThreshold = root.querySelector<HTMLInputElement>(".gg-controls__label-threshold")!;
  const labelThresholdVal = root.querySelector<HTMLSpanElement>(".gg-controls__label-threshold-val")!;
  const syncThresholdVisibility = (): void => {
    labelThresholdRow.style.display = labelModeSel.value === "auto" ? "" : "none";
  };
  labelModeSel.addEventListener("change", () => {
    handle.setLabelMode(labelModeSel.value as "auto" | "always" | "never");
    syncThresholdVisibility();
  });
  labelThreshold.addEventListener("input", () => {
    const v = Number(labelThreshold.value);
    labelThresholdVal.textContent = v.toFixed(1);
    handle.setLabelZoomThreshold(v);
  });
  syncThresholdVisibility();

  // --- Node scale ---
  const nodeScale = root.querySelector<HTMLInputElement>(".gg-controls__node-scale")!;
  const nodeScaleVal = root.querySelector<HTMLSpanElement>(".gg-controls__node-scale-val")!;
  nodeScale.addEventListener("input", () => {
    const v = Number(nodeScale.value);
    nodeScaleVal.textContent = `${v.toFixed(1)}×`;
    handle.setNodeScale(v);
  });

  // --- Forces ---
  wireForce(root, "charge", (v) => handle.setForceStrengths({ charge: v }));
  wireForce(root, "link", (v) => handle.setForceStrengths({ link: v }));
  wireForce(root, "collision", (v) => handle.setForceStrengths({ collision: v }));

  // --- Cmd+L (or `[`) toggles panel visibility from anywhere ---
  const togglePanelKey = (e: KeyboardEvent): void => {
    if (isTypingInInput(e.target)) return;
    const isMetaL =
      (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l";
    const isBracket = e.key === "[" && !e.metaKey && !e.ctrlKey;
    if (!isMetaL && !isBracket) return;
    e.preventDefault();
    setCollapsed(body.style.display !== "none");
  };
  document.addEventListener("keydown", togglePanelKey);

  return {
    updateScene(next) {
      scene = next;
      renderResults();
    },
    destroy() {
      document.removeEventListener("keydown", togglePanelKey);
      root.remove();
    },
  };
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function isTypingInInput(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function basePositionStyle(
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left",
): Partial<CSSStyleDeclaration> {
  const off = "16px";
  if (position === "top-right") return { position: "absolute", top: off, right: off };
  if (position === "top-left") return { position: "absolute", top: off, left: off };
  if (position === "bottom-right") return { position: "absolute", bottom: off, right: off };
  return { position: "absolute", bottom: off, left: off };
}

function forceSliderHtml(
  key: string,
  label: string,
  min: number,
  max: number,
  initial: number,
): string {
  return `
    <label style="display:flex;align-items:center;gap:8px;color:#6b7280;font-size:11px;margin:4px 0;">
      ${label}
      <input class="gg-controls__force-${key}" type="range" min="${min}" max="${max}" step="0.1" value="${initial}" style="flex:1;" />
      <span class="gg-controls__force-${key}-val" style="width:30px;text-align:right;">${initial.toFixed(1)}×</span>
    </label>
  `;
}

function wireForce(
  root: HTMLElement,
  key: string,
  apply: (v: number) => void,
): void {
  const input = root.querySelector<HTMLInputElement>(`.gg-controls__force-${key}`)!;
  const val = root.querySelector<HTMLSpanElement>(`.gg-controls__force-${key}-val`)!;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = `${v.toFixed(1)}×`;
    apply(v);
  });
}
