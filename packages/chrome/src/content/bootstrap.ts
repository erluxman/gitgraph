import { parsePrUrl } from "../github/client.js";
import type { ScanTarget } from "../orchestrator-types.js";

/**
 * Tiny auto-loaded content script. Stays under ~10 KB so we don't
 * burn budget on every github.com page load. Responsibilities:
 *
 *   - Inject the gitGraph button on PR pages.
 *   - Listen for `open-overlay` messages from the popup (delivered via
 *     the background service worker so it can lazy-inject the renderer).
 *   - When the user clicks the button — or the renderer arrives via
 *     `open-overlay` — call into `window.__gitgraphRenderer`, asking
 *     the background to load the heavy bundle first if needed.
 *
 * The heavy bundle (`content-renderer.js`, ~4 MB with PIXI) attaches
 * itself to `window.__gitgraphRenderer = { openOverlay }` on load.
 */

const TABBAR_BUTTON_ID = "gitgraph-trigger-btn";
const FLOATING_BUTTON_ID = "gitgraph-floating-btn";

declare global {
  interface Window {
    __gitgraphRenderer?: {
      readonly openOverlay: (target: ScanTarget) => Promise<void>;
    };
  }
}

console.debug("[gitGraph] bootstrap loaded on", location.href);

const TABNAV_SELECTORS: readonly string[] = [
  'nav[aria-label="Pull request tabs"]',
  ".UnderlineNav-body",
  ".tabnav-tabs",
  'ul[role="tablist"]',
  '[data-pjax="#repo-content-pjax-container"] nav',
];

function findTabnav(): Element | null {
  for (const sel of TABNAV_SELECTORS) {
    const el = document.querySelector(sel);
    if (el !== null) return el;
  }
  return null;
}

async function trigger(target: ScanTarget): Promise<void> {
  if (window.__gitgraphRenderer === undefined) {
    await new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage(
        { kind: "background:load-renderer" },
        (response) => {
          const r = response as { ok?: boolean; error?: string };
          if (r?.ok === true) resolve();
          else reject(new Error(r?.error ?? "renderer load failed"));
        },
      );
    });
  }
  await window.__gitgraphRenderer?.openOverlay(target);
}

function injectTabnavButton(): boolean {
  if (document.getElementById(TABBAR_BUTTON_ID) !== null) return true;
  const prLocator = parsePrUrl(location.pathname);
  if (prLocator === null) return false;
  const tabnav = findTabnav();
  if (tabnav === null) return false;

  const button = document.createElement("button");
  button.id = TABBAR_BUTTON_ID;
  button.type = "button";
  button.textContent = "gitGraph";
  Object.assign(button.style, {
    marginLeft: "10px",
    padding: "5px 12px",
    background: "linear-gradient(180deg, #1f2937, #111827)",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: "600",
    cursor: "pointer",
  } satisfies Partial<CSSStyleDeclaration>);
  button.addEventListener("click", () => {
    void trigger({ kind: "pr", locator: prLocator });
  });
  tabnav.appendChild(button);
  return true;
}

function installFloatingButton(): void {
  if (document.getElementById(FLOATING_BUTTON_ID) !== null) return;
  const prLocator = parsePrUrl(location.pathname);
  if (prLocator === null) return;

  const button = document.createElement("button");
  button.id = FLOATING_BUTTON_ID;
  button.type = "button";
  button.title = "Open gitGraph";
  button.textContent = "gitGraph";
  Object.assign(button.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: "2147483646",
    padding: "10px 16px",
    background: "linear-gradient(180deg, #1e40af, #1e3a8a)",
    color: "#fff",
    border: "1px solid #1e3a8a",
    borderRadius: "999px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  } satisfies Partial<CSSStyleDeclaration>);
  button.addEventListener("click", () => {
    void trigger({ kind: "pr", locator: prLocator });
  });
  document.body.appendChild(button);
}

function uninstallAll(): void {
  document.getElementById(TABBAR_BUTTON_ID)?.remove();
  document.getElementById(FLOATING_BUTTON_ID)?.remove();
}

function refresh(): void {
  const prLocator = parsePrUrl(location.pathname);
  if (prLocator === null) {
    uninstallAll();
    return;
  }
  installFloatingButton();
  injectTabnavButton();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const m = msg as { kind?: string; target?: ScanTarget };
  if (m?.kind !== "open-overlay" || m.target === undefined) return false;
  console.log("[gitGraph] open-overlay → bootstrap", m.target);
  void trigger(m.target).then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: String(err) }),
  );
  return true;
});

refresh();

let pending = false;
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      uninstallAll();
    }
    refresh();
  });
});
observer.observe(document.body, { childList: true, subtree: true });
