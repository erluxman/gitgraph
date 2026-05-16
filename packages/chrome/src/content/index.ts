import { parsePrUrl } from "../github/client.js";
import type { PopupToContent } from "../messages.js";
import { openOverlay } from "./overlay.js";

const TABBAR_BUTTON_ID = "gitgraph-trigger-btn";
const FLOATING_BUTTON_ID = "gitgraph-floating-btn";

/**
 * Content script entry. We want a "gitGraph" trigger on every PR page,
 * regardless of which GitHub UI variant is currently shipped, and we
 * also listen for popup-driven commands (e.g. "compare branches X..Y").
 *
 * Strategy for the on-page trigger:
 *   1. Try to inject inline into the PR tab bar (nicest placement).
 *   2. If we can't find the tab bar within a short window, fall back to
 *      a floating button pinned to the bottom-right corner.
 *   3. Re-run on every URL change (GitHub uses Turbo/PJAX).
 *
 * Popup-driven commands arrive via chrome.runtime.onMessage and open
 * the overlay directly with whatever ScanTarget the popup composed.
 */

const TABNAV_SELECTORS: readonly string[] = [
  'nav[aria-label="Pull request tabs"]',
  '.UnderlineNav-body',
  '.tabnav-tabs',
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
    void openOverlay({ kind: "pr", locator: prLocator });
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
    void openOverlay({ kind: "pr", locator: prLocator });
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
  // Always show the floating button so the user has a guaranteed entry
  // point even if GitHub's PR tab bar moves.
  installFloatingButton();
  injectTabnavButton();
}

console.debug("[gitGraph] content script loaded on", location.href);
refresh();

// Listen for popup-driven commands. The popup uses chrome.tabs.sendMessage
// to deliver these.
declare const chrome: {
  runtime?: {
    onMessage?: {
      addListener(
        cb: (
          msg: unknown,
          sender: unknown,
          sendResponse: (r: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  };
};
chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  const m = msg as PopupToContent;
  if (m === null || typeof m !== "object" || m.kind !== "open-overlay") {
    return false;
  }
  console.log("[gitGraph] received open-overlay from popup", m.target);
  void openOverlay(m.target);
  sendResponse({ ok: true });
  return true;
});

// SPA-style nav: re-check on URL changes (GitHub's tab clicks don't
// always reload). MutationObserver fires far more than we'd like, so we
// throttle the actual work to once per animation frame.
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
