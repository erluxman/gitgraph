/**
 * Renderer bundle entry point. NOT auto-loaded — the background service
 * worker injects this file on demand the first time the user clicks the
 * gitGraph button (or the popup posts an open-overlay message).
 *
 * Self-attaches to `window.__gitgraphRenderer` so the always-loaded
 * bootstrap can call into us without another round-trip.
 */
import type { ScanTarget } from "../orchestrator-types.js";
import { openOverlay } from "./overlay.js";

declare global {
  interface Window {
    __gitgraphRenderer?: {
      readonly openOverlay: (target: ScanTarget) => Promise<void>;
    };
  }
}

console.log("[gitGraph] renderer loaded");
window.__gitgraphRenderer = { openOverlay };
