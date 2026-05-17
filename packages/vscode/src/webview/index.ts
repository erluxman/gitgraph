import {
  mountCommandPalette,
  mountControlsPanel,
  mountRenderer,
  type CommandPaletteHandle,
  type ControlsPanelHandle,
  type RendererHandle,
  type Scene,
} from "@gitgraph/graph-renderer";
import type { HostToWebview, SerializedScene, WebviewToHost } from "../messages.js";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
};

const vscode = acquireVsCodeApi();
const status = document.getElementById("status") as HTMLSpanElement;
const host = document.getElementById("canvas-host") as HTMLDivElement;

let handle: RendererHandle | null = null;
let panel: ControlsPanelHandle | null = null;
let palette: CommandPaletteHandle | null = null;
let currentScene: Scene | null = null;
// Pending Apply call from the panel — we resolve it when the host
// pushes back a fresh scene snapshot. Lets the panel show its loading
// state for the right amount of time.
let pendingApply: { resolve: () => void; reject: (e: Error) => void } | null = null;

window.addEventListener("message", (event) => {
  const message = event.data as HostToWebview;
  switch (message.kind) {
    case "status":
      status.textContent = `${message.text} (${Math.round(message.progress * 100)}%)`;
      status.style.color = "";
      break;
    case "error":
      status.textContent = message.text;
      status.style.color = "#fca5a5";
      pendingApply?.reject(new Error(message.text));
      pendingApply = null;
      break;
    case "scene":
      void applyScene(message.scene, message.meta);
      break;
    case "branches":
      panel?.setBranchSelector({
        branches: message.branches,
        currentBase: message.currentBase,
        currentHead: message.currentHead,
        async onApply(base, _head) {
          return new Promise<void>((resolve, reject) => {
            pendingApply = { resolve, reject };
            vscode.postMessage({ kind: "setCompare", base, head: _head });
          });
        },
      });
      break;
  }
});

vscode.postMessage({ kind: "ready" });

async function applyScene(
  serialized: SerializedScene,
  meta: { changedCount: number; totalFiles: number; baseRef: string },
): Promise<void> {
  // Rehydrate into the renderer's Scene shape — adds the mutable
  // x/y/vx/vy fields and edge source/target objects.
  const scene: Scene = {
    nodes: serialized.nodes.map((n) => ({ ...n })),
    edges: serialized.edges.map((e) => ({
      source: e.from,
      target: e.to,
      weight: e.weight,
    })),
  };
  currentScene = scene;

  if (handle === null) {
    const rect = host.getBoundingClientRect();
    handle = await mountRenderer(scene, {
      container: host,
      width: rect.width,
      height: rect.height,
      onNodeJump(node) {
        vscode.postMessage({ kind: "jumpTo", path: node.path });
      },
      onNodeContextMenu(node) {
        vscode.postMessage({ kind: "toggleCorePath", path: node.path });
      },
    });
    new ResizeObserver((entries) => {
      for (const e of entries) {
        handle?.resize(e.contentRect.width, e.contentRect.height);
      }
    }).observe(host);
    // First-scene-only setup: mount the panel + palette, ask for branches.
    panel = mountControlsPanel(host, handle, { scene });
    palette = mountCommandPalette(host, handle, { scene });
    vscode.postMessage({ kind: "listBranches" });
  } else {
    await handle.setScene(scene);
    panel?.updateScene(scene);
    palette?.updateScene(scene);
  }

  // Resolve any in-flight Apply from the branch picker so it can
  // clear its loading state.
  pendingApply?.resolve();
  pendingApply = null;

  status.style.color = "";
  status.textContent = `${meta.totalFiles} files · ${meta.changedCount} changed · base ${meta.baseRef}`;
}

// Suppress unused warning — we keep `currentScene` for future use
// (e.g. re-mounting after a webview suspend).
void currentScene;
