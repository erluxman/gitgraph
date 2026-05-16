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
}

export function deactivate(): void {
  provider = null;
}
