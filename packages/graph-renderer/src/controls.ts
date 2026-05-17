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
  /**
   * Replace the branch dropdowns' options (e.g. after a refresh fetched
   * a new branch list). No-op if the panel was mounted without a branch
   * selector.
   */
  setBranchSelector(opts: BranchSelectorOptions): void;
  /** Remove the panel from the DOM. */
  destroy(): void;
}

export interface ControlsPanelOptions {
  /** Initial scene used to seed the search index. */
  readonly scene: Scene;
  /** Where the panel anchors. */
  readonly position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /**
   * Optional in-panel branch selector. When provided, the panel renders
   * a "Compare branches" section with two dropdowns (base + head) and an
   * Apply button. The host owns branch discovery and re-scanning — the
   * panel just collects the user's pick and calls back.
   *
   * Pass `currentHead = ""` (or omit it) to default to a snapshot of
   * `currentBase`. The host can update the list later via
   * `handle.setBranchSelector(...)` after a successful re-scan.
   */
  readonly branchSelector?: BranchSelectorOptions;
}

export interface BranchSelectorOptions {
  readonly branches: readonly string[];
  readonly currentBase: string;
  readonly currentHead?: string;
  /**
   * Called when the user clicks Apply. `head` is empty string when the
   * user wants a snapshot view of `base`. Return a promise so the panel
   * can show a loading state.
   */
  readonly onApply: (base: string, head: string) => Promise<void>;
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
      <div style="display:flex;align-items:center;gap:6px;">
        <button type="button" class="gg-controls__fit" title="Fit graph to view"
          style="background:transparent;border:1px solid #334155;color:#94a3b8;border-radius:4px;font-size:10px;padding:1px 8px;cursor:pointer;letter-spacing:0.04em;">FIT</button>
        <span class="gg-controls__toggle" style="font-size:14px;line-height:1;color:#94a3b8;">−</span>
      </div>
    </div>
    <div class="gg-controls__body" style="padding:10px 12px;width:240px;max-height:calc(100vh - 80px);overflow-y:auto;overflow-x:hidden;">
      <!-- Compare branches (populated by setBranchSelector) -->
      <div class="gg-controls__branches" style="display:none;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #1f2937;"></div>

      <!-- Show only (clickable impact filter) -->
      <label style="display:block;color:#9ca3af;margin-bottom:6px;">Show only</label>
      <div class="gg-controls__impact-chips" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;">
        ${impactChipHtml("red", "Changed", "#ef4444", true)}
        ${impactChipHtml("orange", "Downstream", "#f59e0b", true)}
        ${impactChipHtml("green", "Unaffected", "#4ade80", true)}
        ${impactChipHtml("core", "Core", "#facc15", false)}
      </div>
      <hr style="border:0;border-top:1px solid #1f2937;margin:0 0 12px 0;" />

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

      <hr style="border:0;border-top:1px solid #1f2937;margin:12px 0;" />

      <!-- Viscosity: lower = more jiggle when zooming/panning -->
      <label style="display:flex;align-items:center;gap:8px;color:#6b7280;font-size:11px;margin:4px 0;" title="Lower = looser / more wobble on pan-zoom. Higher = stiffer / settles fast.">
        Viscosity
        <input class="gg-controls__viscosity" type="range" min="0" max="1" step="0.05" value="0.8" style="flex:1;" />
        <span class="gg-controls__viscosity-val" style="width:30px;text-align:right;">0.80</span>
      </label>
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
    .addEventListener("click", (e) => {
      // Don't toggle the panel when the user clicked the FIT chip.
      if ((e.target as HTMLElement).closest(".gg-controls__fit")) return;
      setCollapsed(body.style.display !== "none");
    });
  root.querySelector<HTMLButtonElement>(".gg-controls__fit")!
    .addEventListener("click", (e) => {
      e.stopPropagation();
      handle.fitView();
    });

  // --- Impact filter chips (clickable) ---
  const activeImpacts = new Set<string>(["red", "orange", "green"]);
  let coreOnly = false;
  const chipButtons = root.querySelectorAll<HTMLButtonElement>(".gg-controls__chip");

  function recomputeImpactFilter(): void {
    // No filter when the user has all three impact kinds selected AND
    // hasn't enabled core-only.
    const allKindsActive =
      activeImpacts.has("red") &&
      activeImpacts.has("orange") &&
      activeImpacts.has("green");
    if (allKindsActive && !coreOnly) {
      handle.setFilter(null);
      return;
    }
    const matched = new Set<string>();
    for (const node of scene.nodes) {
      if (node.kind === "child") continue;
      if (!activeImpacts.has(node.impact)) continue;
      if (coreOnly && !node.core) continue;
      matched.add(node.id);
    }
    handle.setFilter(matched);
  }

  function paintChip(btn: HTMLButtonElement, active: boolean): void {
    btn.dataset.active = active ? "1" : "";
    btn.style.background = active ? "#1e293b" : "#0f172a";
    btn.style.borderColor = active ? "#334155" : "#1f2937";
    btn.style.color = active ? "#e5e7eb" : "#6b7280";
  }

  for (const btn of chipButtons) {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.kind!;
      if (kind === "core") {
        coreOnly = !coreOnly;
        paintChip(btn, coreOnly);
      } else {
        if (activeImpacts.has(kind)) activeImpacts.delete(kind);
        else activeImpacts.add(kind);
        paintChip(btn, activeImpacts.has(kind));
      }
      recomputeImpactFilter();
    });
  }

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

  // --- Viscosity (jiggle on pan/zoom) ---
  const viscInput = root.querySelector<HTMLInputElement>(".gg-controls__viscosity")!;
  const viscVal = root.querySelector<HTMLSpanElement>(".gg-controls__viscosity-val")!;
  viscInput.addEventListener("input", () => {
    const v = Number(viscInput.value);
    viscVal.textContent = v.toFixed(2);
    handle.setViscosity(v);
  });

  // --- Branch selector (optional) ---
  const branchesBox = root.querySelector<HTMLDivElement>(".gg-controls__branches")!;
  let branchOpts: BranchSelectorOptions | null = null;

  function renderBranchSelector(): void {
    if (branchOpts === null) {
      branchesBox.style.display = "none";
      branchesBox.innerHTML = "";
      return;
    }
    branchesBox.style.display = "";
    const { branches, currentBase, currentHead = "" } = branchOpts;
    const baseOptions = optionsHtml(branches, currentBase);
    const headOptions = optionsHtml([""].concat([...branches]), currentHead);

    branchesBox.innerHTML = `
      <label style="display:block;color:#9ca3af;margin-bottom:4px;">Compare branches</label>
      <div style="margin-bottom:4px;">
        <label style="font-size:10px;color:#6b7280;">Base</label>
        <select class="gg-controls__base" style="width:100%;padding:4px 6px;background:#111827;color:#e5e7eb;border:1px solid #1f2937;border-radius:4px;font-size:12px;">${baseOptions}</select>
      </div>
      <div style="margin-bottom:6px;">
        <label style="font-size:10px;color:#6b7280;">Compare with <span style="color:#6b7280;">(optional)</span></label>
        <select class="gg-controls__head" style="width:100%;padding:4px 6px;background:#111827;color:#e5e7eb;border:1px solid #1f2937;border-radius:4px;font-size:12px;">${headOptions}</select>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="gg-controls__apply" type="button"
          style="flex:1;padding:4px 10px;background:linear-gradient(180deg,#1e40af,#1e3a8a);color:#fff;border:0;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">Apply</button>
        <span class="gg-controls__apply-status" style="font-size:10px;color:#9ca3af;flex:0 0 auto;"></span>
      </div>
    `;

    const baseSel = branchesBox.querySelector<HTMLSelectElement>(".gg-controls__base")!;
    const headSel = branchesBox.querySelector<HTMLSelectElement>(".gg-controls__head")!;
    const button = branchesBox.querySelector<HTMLButtonElement>(".gg-controls__apply")!;
    const status = branchesBox.querySelector<HTMLSpanElement>(".gg-controls__apply-status")!;
    button.addEventListener("click", async () => {
      if (branchOpts === null) return;
      const base = baseSel.value;
      const head = headSel.value;
      button.disabled = true;
      status.style.color = "#9ca3af";
      status.textContent = head === "" || head === base ? "Loading…" : `${base} → ${head}…`;
      try {
        await branchOpts.onApply(base, head);
        status.textContent = "";
      } catch (err) {
        status.style.color = "#fca5a5";
        status.textContent = (err as Error).message ?? "failed";
      } finally {
        button.disabled = false;
      }
    });
  }

  function optionsHtml(items: readonly string[], selected: string): string {
    return items
      .map((item) => {
        const safe = escapeAttr(item);
        const label = item === "" ? "(snapshot — no comparison)" : safe;
        const sel = item === selected ? " selected" : "";
        return `<option value="${safe}"${sel}>${label}</option>`;
      })
      .join("");
  }

  function escapeAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  if (opts.branchSelector !== undefined) {
    branchOpts = opts.branchSelector;
    renderBranchSelector();
  }

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
      recomputeImpactFilter();
    },
    setBranchSelector(next) {
      branchOpts = next;
      renderBranchSelector();
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

/**
 * Render markup for a single clickable impact chip. `kind` is "red" /
 * "orange" / "green" for impact kinds, or "core" for the core-tag
 * filter. `initiallyActive` controls the starting state — impact kinds
 * default to active (no filter); core defaults to inactive.
 */
function impactChipHtml(
  kind: string,
  label: string,
  colour: string,
  initiallyActive: boolean,
): string {
  const isSquare = kind === "core";
  const dot = isSquare
    ? `<span style="display:inline-block;width:8px;height:8px;background:${colour};margin-right:4px;vertical-align:middle;"></span>`
    : `<span style="display:inline-block;width:8px;height:8px;background:${colour};border-radius:50%;margin-right:4px;vertical-align:middle;"></span>`;
  const active = initiallyActive ? " data-active=\"1\"" : "";
  return `
    <button type="button" class="gg-controls__chip" data-kind="${kind}"${active}
      style="display:inline-flex;align-items:center;gap:2px;padding:3px 8px;border-radius:12px;font-size:11px;cursor:pointer;font-family:inherit;background:${initiallyActive ? "#1e293b" : "#0f172a"};border:1px solid ${initiallyActive ? "#334155" : "#1f2937"};color:${initiallyActive ? "#e5e7eb" : "#6b7280"};">
      ${dot}${label}
    </button>
  `;
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
