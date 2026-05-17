import {
  analyseDiff,
  buildGraph,
  parseFile,
  scoreRisk,
  type ParsedFile,
  type ParsedRepo,
} from "@gitgraph/core";
import {
  applyFilter,
  buildSceneFromCore,
  mountControlsPanel,
  mountRenderer,
  parseFilter,
  type RendererHandle,
} from "@gitgraph/graph-renderer";

/**
 * Synthetic repo modelled to look like a small TS app:
 *   - core/auth.ts        (hub: imported by middleware + several pages)
 *   - core/db.ts          (hub: imported by middleware + a couple of pages)
 *   - middleware/api.ts   (imports both hubs)
 *   - pages/*.ts          (each imports api.ts or auth.ts)
 *   - utils/*.ts          (leaf files, mostly unrelated)
 *
 * The "changed" set is [core/auth.ts] so we get a strong blast radius.
 */
const SOURCES: Record<string, string> = {
  "src/core/auth.ts": `
    export function login() {}
    export function logout() {}
    export const SESSION_KEY = "x";
  `,
  "src/core/db.ts": `
    export class Database {
      connect() {}
      query() {}
      close() {}
    }
  `,
  "src/core/logger.ts": `
    export function log(msg: string) {}
    export function warn(msg: string) {}
  `,
  "src/middleware/api.ts": `
    import { login, logout } from "../core/auth";
    import { Database } from "../core/db";
    export function withAuth() { return login(); }
    export function withDb() { return new Database(); }
  `,
  "src/middleware/cache.ts": `
    import { log } from "../core/logger";
    export function cache() { log("hit"); }
  `,
  "src/pages/dashboard.ts": `
    import { withAuth, withDb } from "../middleware/api";
    export const dashboard = withAuth();
  `,
  "src/pages/profile.ts": `
    import { logout } from "../core/auth";
    export const profile = logout;
  `,
  "src/pages/settings.ts": `
    import { withAuth } from "../middleware/api";
    import { cache } from "../middleware/cache";
    export const settings = { withAuth, cache };
  `,
  "src/pages/billing.ts": `
    import { withDb } from "../middleware/api";
    export const billing = withDb;
  `,
  "src/pages/admin.ts": `
    import { withAuth } from "../middleware/api";
    import { Database } from "../core/db";
    export const admin = { withAuth, Database };
  `,
  "src/utils/format.ts": `
    export function format(s: string) { return s.trim(); }
  `,
  "src/utils/dates.ts": `
    export function today() { return new Date(); }
  `,
  "src/utils/colors.ts": `
    export const RED = "#ef4444";
    export const GREEN = "#4ade80";
  `,
};

const CHANGED = ["src/core/auth.ts"];
const CORE_PATHS = new Set(["src/core/auth.ts", "src/core/db.ts"]);

function parseAll(files: Record<string, string>): ParsedRepo {
  const out = new Map<string, ParsedFile>();
  for (const [path, src] of Object.entries(files)) {
    out.set(path, parseFile(path, src, "typescript"));
  }
  return { files: out };
}

async function main(): Promise<void> {
  const repo = parseAll(SOURCES);
  const graph = buildGraph({ repo });
  const diff = analyseDiff({ graph, changedFiles: CHANGED });
  const risk = scoreRisk(graph, { corePaths: [...CORE_PATHS] });
  const scene = buildSceneFromCore({ graph, diff, risk, corePaths: CORE_PATHS });

  const host = document.getElementById("canvas-host") as HTMLDivElement;
  const rect = host.getBoundingClientRect();
  const handle: RendererHandle = await mountRenderer(scene, {
    container: host,
    width: rect.width,
    height: rect.height,
    onNodeHover(node) {
      const status = document.getElementById("status")!;
      if (node === null) {
        status.textContent = `${scene.nodes.length} files · changed: ${CHANGED.length}`;
        return;
      }
      const consumers = graph.incoming.get(node.path)?.size ?? 0;
      const score = risk.get(node.path)?.combined ?? 0;
      status.textContent = `${node.path} — ${node.impact}${node.core ? " · core" : ""} · imported by ${consumers} · risk ${score.toFixed(3)}`;
    },
    onNodeClick(node) {
      console.log("click", node.path);
    },
  });

  // Floating controls panel (search, label fade, node size, forces).
  mountControlsPanel(host, handle, { scene });

  const filterInput = document.getElementById("filter") as HTMLInputElement;
  const resetButton = document.getElementById("reset") as HTMLButtonElement;
  const filterCtx = {
    nodes: scene.nodes,
    filesByPath: repo.files,
    incoming: graph.incoming,
  };
  filterInput.addEventListener("input", () => {
    const parsed = parseFilter(filterInput.value);
    if (parsed === null) {
      handle.setFilter(null);
      return;
    }
    handle.setFilter(applyFilter(parsed, filterCtx));
  });
  resetButton.addEventListener("click", () => {
    filterInput.value = "";
    handle.setFilter(null);
  });

  document.getElementById("status")!.textContent =
    `${scene.nodes.length} files · changed: ${CHANGED.length}`;

  // Resize support — keeps the canvas sized to its container.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      handle.resize(e.contentRect.width, e.contentRect.height);
    }
  });
  ro.observe(host);
}

void main();
