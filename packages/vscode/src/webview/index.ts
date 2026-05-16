import {
  mountRenderer,
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
      break;
    case "scene":
      void applyScene(message.scene, message.meta);
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
  } else {
    await handle.setScene(scene);
  }

  status.style.color = "";
  status.textContent = `${meta.totalFiles} files · ${meta.changedCount} changed · base ${meta.baseRef}`;
}
