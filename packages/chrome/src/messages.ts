import type { RepoLocator } from "./github/types.js";

/**
 * Messages sent from the extension popup to the content script (via
 * chrome.tabs.sendMessage). The content script registers a chrome.runtime
 * onMessage listener and dispatches based on `kind`.
 *
 * Keep this tiny and stable — both sides are bundled separately and a
 * mismatch only fails at runtime.
 */
export type PopupToContent =
  | {
      readonly kind: "open-overlay";
      readonly target:
        | { readonly kind: "pr"; readonly locator: RepoLocator & { readonly pull: number } }
        | {
            readonly kind: "compare";
            readonly locator: RepoLocator;
            readonly base: string;
            readonly head: string;
          }
        | {
            readonly kind: "snapshot";
            readonly locator: RepoLocator;
            readonly ref: string;
          };
    };
