import type { RendererHandle } from "./pixi/renderer.js";
import type { Scene } from "./types.js";

/**
 * Cursor-style Cmd+K palette. Opens as a centred modal over `host` when
 * Cmd/Ctrl+K (or `/`) is pressed; types-to-filter; arrow keys to navigate;
 * Enter to focus the camera on the highlighted match; Escape to dismiss.
 *
 * The palette is keyboard-first: once open you never need the mouse.
 */
export interface CommandPaletteHandle {
  updateScene(scene: Scene): void;
  open(): void;
  close(): void;
  destroy(): void;
}

export interface CommandPaletteOptions {
  readonly scene: Scene;
  /** Override the open key. Default: Cmd/Ctrl+K and `/`. */
  readonly openKey?: (e: KeyboardEvent) => boolean;
}

const DEFAULT_OPEN = (e: KeyboardEvent): boolean => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return true;
  // Bare `/` opens the palette unless the user is already typing in
  // another input. The Esc handler in the palette closes it.
  if (e.key === "/" && !isTypingInInput(e.target)) return true;
  return false;
};

export function mountCommandPalette(
  host: HTMLElement,
  handle: RendererHandle,
  opts: CommandPaletteOptions,
): CommandPaletteHandle {
  let scene = opts.scene;
  const openKey = opts.openKey ?? DEFAULT_OPEN;
  let activeIndex = 0;
  let matches: { id: string; path: string; display: string }[] = [];

  // --- DOM scaffold ---
  const root = document.createElement("div");
  root.className = "gg-palette";
  Object.assign(root.style, {
    display: "none",
    position: "absolute",
    inset: "0",
    background: "rgba(2, 6, 23, 0.55)",
    backdropFilter: "blur(6px)",
    zIndex: "20",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "12vh",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  } satisfies Partial<CSSStyleDeclaration>);

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    width: "min(520px, 90vw)",
    background: "linear-gradient(180deg, #1f2937, #0f172a)",
    border: "1px solid #334155",
    borderRadius: "10px",
    boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
    overflow: "hidden",
    color: "#e5e7eb",
  } satisfies Partial<CSSStyleDeclaration>);
  root.appendChild(panel);

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a filename or path — ↑↓ to navigate, ↵ to focus";
  input.autocomplete = "off";
  Object.assign(input.style, {
    width: "100%",
    padding: "14px 16px",
    border: "0",
    borderBottom: "1px solid #334155",
    background: "transparent",
    color: "#f8fafc",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "inherit",
  } satisfies Partial<CSSStyleDeclaration>);
  panel.appendChild(input);

  const list = document.createElement("ul");
  Object.assign(list.style, {
    listStyle: "none",
    margin: "0",
    padding: "4px 0",
    maxHeight: "50vh",
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12px",
  } satisfies Partial<CSSStyleDeclaration>);
  panel.appendChild(list);

  const hint = document.createElement("div");
  hint.textContent = "↑ ↓ navigate · ↵ focus · esc close";
  Object.assign(hint.style, {
    padding: "6px 12px",
    fontSize: "10px",
    color: "#64748b",
    borderTop: "1px solid #1e293b",
    textAlign: "right",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  } satisfies Partial<CSSStyleDeclaration>);
  panel.appendChild(hint);

  host.appendChild(root);

  // --- behaviour ---
  function open(): void {
    if (root.style.display === "flex") return;
    root.style.display = "flex";
    input.value = "";
    activeIndex = 0;
    render();
    // Defer to next frame so the browser registers the input as visible
    // before we focus it — otherwise mobile keyboards don't always show.
    requestAnimationFrame(() => input.focus());
  }

  function close(): void {
    root.style.display = "none";
    input.blur();
  }

  function render(): void {
    const q = input.value.trim().toLowerCase();
    matches = q.length === 0
      ? scene.nodes
          .filter((n) => n.kind !== "child")
          .slice(0, 12)
          .map((n) => ({ id: n.id, path: n.path, display: n.displayName }))
      : scene.nodes
          .filter(
            (n) =>
              n.kind !== "child" &&
              (n.displayName.toLowerCase().includes(q) ||
                n.path.toLowerCase().includes(q)),
          )
          .slice(0, 12)
          .map((n) => ({ id: n.id, path: n.path, display: n.displayName }));
    if (activeIndex >= matches.length) activeIndex = Math.max(0, matches.length - 1);

    list.innerHTML = "";
    matches.forEach((m, i) => {
      const li = document.createElement("li");
      const isActive = i === activeIndex;
      Object.assign(li.style, {
        padding: "7px 16px",
        background: isActive ? "rgba(59, 130, 246, 0.18)" : "transparent",
        borderLeft: isActive ? "2px solid #3b82f6" : "2px solid transparent",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: "1px",
      } satisfies Partial<CSSStyleDeclaration>);
      const name = document.createElement("span");
      name.textContent = m.display;
      name.style.color = "#f1f5f9";
      const path = document.createElement("span");
      path.textContent = m.path;
      path.style.color = "#64748b";
      path.style.fontSize = "10.5px";
      li.appendChild(name);
      li.appendChild(path);
      li.addEventListener("mouseenter", () => {
        if (activeIndex !== i) {
          activeIndex = i;
          render();
        }
      });
      li.addEventListener("click", () => {
        commit(i);
      });
      list.appendChild(li);
    });
  }

  function commit(index: number): void {
    const match = matches[index];
    if (match === undefined) return;
    handle.focusNode(match.id, { zoom: 1.6, pulse: true });
    close();
  }

  input.addEventListener("input", () => {
    activeIndex = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (matches.length === 0) return;
      activeIndex = (activeIndex + 1) % matches.length;
      render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (matches.length === 0) return;
      activeIndex = (activeIndex - 1 + matches.length) % matches.length;
      render();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit(activeIndex);
    }
  });
  root.addEventListener("click", (e) => {
    if (e.target === root) close();
  });

  const globalKey = (e: KeyboardEvent): void => {
    if (root.style.display === "flex") return;
    if (openKey(e)) {
      e.preventDefault();
      open();
    }
  };
  document.addEventListener("keydown", globalKey);

  return {
    updateScene(next) {
      scene = next;
      if (root.style.display === "flex") render();
    },
    open,
    close,
    destroy() {
      document.removeEventListener("keydown", globalKey);
      root.remove();
    },
  };
}

function isTypingInInput(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}
