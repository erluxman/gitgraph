/**
 * Protocol exchanged between the extension host (Node) and the webview
 * (browser-like) over `postMessage`. Both sides import these types so
 * the shape is checked at compile time.
 *
 * The host side is authoritative: it owns the file system + git, and
 * pushes scene updates to the webview. The webview pushes user actions
 * (e.g. "jump to file:line") back to the host.
 */

export interface SerializedScene {
  readonly nodes: readonly {
    readonly id: string;
    readonly path: string;
    readonly folder: string;
    readonly displayName: string;
    readonly exportCount: number;
    readonly impact: "red" | "orange" | "green";
    readonly distance: number;
    readonly risk: number;
    readonly core: boolean;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly weight: number;
  }[];
}

/** Messages from the extension host → webview. */
export type HostToWebview =
  | { readonly kind: "status"; readonly text: string; readonly progress: number }
  | { readonly kind: "error"; readonly text: string }
  | {
      readonly kind: "scene";
      readonly scene: SerializedScene;
      readonly meta: {
        readonly changedCount: number;
        readonly totalFiles: number;
        readonly baseRef: string;
      };
    };

/** Messages from the webview → extension host. */
export type WebviewToHost =
  | { readonly kind: "ready" }
  | { readonly kind: "refresh" }
  | { readonly kind: "jumpTo"; readonly path: string; readonly line?: number }
  | { readonly kind: "toggleCorePath"; readonly path: string };
