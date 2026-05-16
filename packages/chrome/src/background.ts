/**
 * Service worker. Lives only to handle the two cross-context flows
 * the popup and content-bootstrap can't do on their own:
 *
 *   - LOAD_RENDERER: inject the heavy `content-renderer.js` bundle
 *     into a given tab. Idempotent — repeated calls do nothing once
 *     the renderer has attached itself to `window.__gitgraphRenderer`.
 *   - OPEN_OVERLAY: ensure the renderer is loaded, then forward an
 *     `open-overlay` message to the tab. Used by the popup.
 */
interface LoadRendererMsg {
  readonly kind: "background:load-renderer";
  readonly tabId: number;
}
interface OpenOverlayMsg {
  readonly kind: "background:open-overlay";
  readonly tabId: number;
  readonly target: unknown;
}
type IncomingMsg = LoadRendererMsg | OpenOverlayMsg;

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as IncomingMsg;
  if (msg === null || typeof msg !== "object") return false;

  if (msg.kind === "background:load-renderer") {
    void loadRenderer(msg.tabId).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }

  if (msg.kind === "background:open-overlay") {
    void loadRenderer(msg.tabId)
      .then(
        () =>
          new Promise<void>((resolve) => {
            chrome.tabs.sendMessage(
              msg.tabId,
              { kind: "open-overlay", target: msg.target },
              () => resolve(),
            );
          }),
      )
      .then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
    return true;
  }

  return false;
});

const injected = new Set<number>();

async function loadRenderer(tabId: number): Promise<void> {
  if (injected.has(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-renderer.js"],
  });
  injected.add(tabId);
}
