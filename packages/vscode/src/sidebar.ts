import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { listBranches } from "./git.js";
import type { HostToWebview, WebviewToHost } from "./messages.js";
import { scanWorkspace } from "./scanner.js";

/**
 * Provides the sidebar webview view registered under the gitGraph
 * activity-bar container. Bridges between VS Code (Node, no DOM) and
 * the webview (DOM, no Node) via postMessage using the typed protocol
 * in `./messages.ts`.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private currentView: vscode.WebviewView | null = null;
  private currentBaseBranch: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly vscodeApi: typeof vscode,
  ) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.currentView = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = await this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage((message: WebviewToHost) =>
      this.handleMessage(message).catch((err) =>
        this.post({ kind: "error", text: stringifyError(err) }),
      ),
    );

    view.onDidDispose(() => {
      if (this.currentView === view) this.currentView = null;
    });
  }

  /** Force a re-scan even if the webview already showed a result. */
  async refresh(baseBranch?: string): Promise<void> {
    if (baseBranch !== undefined) this.currentBaseBranch = baseBranch;
    await this.runScan();
  }

  // --- internals ---

  private async handleMessage(message: WebviewToHost): Promise<void> {
    switch (message.kind) {
      case "ready":
        await this.runScan();
        await this.pushBranches();
        return;
      case "refresh":
        await this.runScan();
        return;
      case "jumpTo":
        await this.jumpTo(message.path, message.line);
        return;
      case "toggleCorePath":
        // Placeholder: persist to `.gitgraph.json`. Out of scope for the
        // first slice — we surface the action but no-op for now.
        return;
      case "listBranches":
        await this.pushBranches();
        return;
      case "setCompare":
        // The scanner's `baseBranch` field controls the diff target —
        // we just point it at the user's pick. `head` is the working
        // tree (HEAD) by convention, so passing `head` here doesn't do
        // anything different yet. In a later round we could honour it
        // to support "compare branch X to branch Y" without checking
        // them out.
        await this.refresh(message.base);
        return;
    }
  }

  /** Push the local branch list to the webview's controls panel. */
  private async pushBranches(): Promise<void> {
    const root = this.firstWorkspaceFolder();
    if (root === null) return;
    try {
      const [{ getGitInfo }, { listBranches }] = await Promise.all([
        import("./git.js"),
        import("./git.js"),
      ]);
      const [branches, info] = await Promise.all([
        listBranches(root),
        getGitInfo(root),
      ]);
      this.post({
        kind: "branches",
        branches,
        currentBase: this.currentBaseBranch ?? info.defaultBase,
        currentHead: info.currentBranch,
      });
    } catch (err) {
      console.warn("[gitGraph] couldn't push branches", err);
    }
  }

  private async runScan(): Promise<void> {
    const root = this.firstWorkspaceFolder();
    if (root === null) {
      this.post({
        kind: "error",
        text: "Open a folder before running gitGraph.",
      });
      return;
    }
    try {
      const result = await scanWorkspace({
        workspaceRoot: root,
        ...(this.currentBaseBranch !== null
          ? { baseBranch: this.currentBaseBranch }
          : {}),
        emit: ({ text, progress }) => this.post({ kind: "status", text, progress }),
      });
      this.post({
        kind: "scene",
        scene: {
          nodes: result.scene.nodes.map((n) => ({
            id: n.id,
            path: n.path,
            folder: n.folder,
            displayName: n.displayName,
            exportCount: n.exportCount,
            impact: n.impact,
            distance: n.distance,
            risk: n.risk,
            core: n.core,
          })),
          edges: result.scene.edges.map((e) => ({
            from: typeof e.source === "string" ? e.source : e.source.id,
            to: typeof e.target === "string" ? e.target : e.target.id,
            weight: e.weight,
          })),
        },
        meta: {
          changedCount: result.changedFiles.length,
          totalFiles: result.totalFiles,
          baseRef: result.baseRef,
        },
      });
    } catch (err) {
      this.post({ kind: "error", text: stringifyError(err) });
    }
  }

  private async jumpTo(relPath: string, line?: number): Promise<void> {
    const root = this.firstWorkspaceFolder();
    if (root === null) return;
    const abs = path.join(root, relPath);
    const uri = this.vscodeApi.Uri.file(abs);
    const doc = await this.vscodeApi.workspace.openTextDocument(uri);
    const pos = new this.vscodeApi.Position(Math.max(0, (line ?? 1) - 1), 0);
    await this.vscodeApi.window.showTextDocument(doc, {
      selection: new this.vscodeApi.Range(pos, pos),
      preview: false,
    });
  }

  private firstWorkspaceFolder(): string | null {
    const folders = this.vscodeApi.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0]!.uri.fsPath : null;
  }

  private post(message: HostToWebview): void {
    this.currentView?.webview.postMessage(message);
  }

  /**
   * Compose the webview HTML by loading the bundled `index.html` and
   * substituting the right resource URIs (the bundled JS + a nonce for
   * the CSP, so VS Code's webview accepts the inline script tag).
   */
  private async renderHtml(webview: vscode.Webview): Promise<string> {
    const htmlPath = this.vscodeApi.Uri.joinPath(
      this.context.extensionUri,
      "dist",
      "webview",
      "index.html",
    );
    const template = await fs.readFile(htmlPath.fsPath, "utf8");
    const scriptUri = webview.asWebviewUri(
      this.vscodeApi.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "webview",
        "index.js",
      ),
    );
    const nonce = randomNonce();
    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
  }

  /** Public: list local branches for the "compare branches" picker. */
  async listBranches(): Promise<readonly string[]> {
    const root = this.firstWorkspaceFolder();
    if (root === null) return [];
    return listBranches(root);
  }
}

function randomNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
