import * as vscode from "vscode";
import { SidebarProvider } from "./sidebar.js";

let provider: SidebarProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  provider = new SidebarProvider(context, vscode);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("gitgraph.graph", provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitgraph.reindex", async () => {
      if (provider === null) return;
      await provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitgraph.compareBranches", async () => {
      if (provider === null) return;
      const branches = await provider.listBranches();
      if (branches.length === 0) {
        await vscode.window.showWarningMessage(
          "gitGraph: no local branches found.",
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        branches.map((b) => ({ label: b })),
        { placeHolder: "Compare against which base branch?" },
      );
      if (pick === undefined) return;
      await provider.refresh(pick.label);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitgraph.openInEditor", async () => {
      // Phase-5 placeholder: opens the same view in an editor tab. For
      // now we just focus the sidebar view.
      await vscode.commands.executeCommand("gitgraph.graph.focus");
    }),
  );

  // Watch for source-file changes and re-index. Debounced so that a
  // formatter saving 10 files in a burst (e.g. eslint --fix) doesn't
  // trigger 10 scans — only one shortly after the last write.
  installFileWatcher(context);
}

const WATCHED_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,dart}";
const DEBOUNCE_MS = 800;

function installFileWatcher(context: vscode.ExtensionContext): void {
  const watcher = vscode.workspace.createFileSystemWatcher(WATCHED_GLOB);
  let pending: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      provider?.refresh().catch((err) => {
        console.error("[gitGraph] auto-refresh failed", err);
      });
    }, DEBOUNCE_MS);
  };
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  watcher.onDidDelete(schedule);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  provider = null;
}
