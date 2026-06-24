import * as vscode from "vscode";

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  set(uri: vscode.Uri, content: string) {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
}

export const proposedContentProvider = new ProposedContentProvider();

export function registerApplyEditCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "fizziwig-proposed",
      proposedContentProvider
    )
  );

  // Command 1: open the diff so the user can review at their own pace
  context.subscriptions.push(
    vscode.commands.registerCommand("fizziwig.showDiff", async () => {
      const newCode = context.workspaceState.get<string>("lastSuggestedEdit");
      const editor = vscode.window.activeTextEditor;

      if (!newCode) {
        vscode.window.showWarningMessage("No suggested edit to apply yet.");
        return;
      }
      if (!editor) {
        vscode.window.showWarningMessage("No active editor open.");
        return;
      }

      const originalUri = editor.document.uri;
      const proposedUri = vscode.Uri.parse(
        `fizziwig-proposed:${originalUri.path}`
      );

      proposedContentProvider.set(proposedUri, newCode);

      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        proposedUri,
        "Current ↔ Fizziwig Suggestion",
        { preview: true }
      );

      vscode.window.showInformationMessage(
        "Review the diff, then run 'Fizziwig: Accept Suggestion' to apply."
      );
    })
  );

  // Command 2: apply whenever the user is ready
  context.subscriptions.push(
    vscode.commands.registerCommand("fizziwig.acceptSuggestion", async () => {
      const newCode = context.workspaceState.get<string>("lastSuggestedEdit");

      if (!newCode) {
        vscode.window.showWarningMessage("No suggestion to accept.");
        return;
      }

      // The diff editor is focused, so activeTextEditor points at the
      // proposed (virtual) side — reconstruct the real file URI from it
      const proposedUri = vscode.window.activeTextEditor?.document.uri;
      const isInDiff = proposedUri?.scheme === "fizziwig-proposed";

      const realUri = isInDiff
        ? vscode.Uri.file(proposedUri!.path)
        : vscode.window.activeTextEditor?.document.uri;

      if (!realUri) {
        vscode.window.showWarningMessage(
          "Could not determine which file to apply the edit to."
        );
        return;
      }

      const realDoc = await vscode.workspace.openTextDocument(realUri);
      const fullRange = new vscode.Range(
        realDoc.positionAt(0),
        realDoc.positionAt(realDoc.getText().length)
      );

      const edit = new vscode.WorkspaceEdit();
      edit.replace(realUri, fullRange, newCode);
      await vscode.workspace.applyEdit(edit);

      // Close diff tab and jump back to the real file
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await vscode.window.showTextDocument(realUri);

      // Clear so it can't be accidentally re-applied
      await context.workspaceState.update("lastSuggestedEdit", undefined);

      vscode.window.showInformationMessage("Suggestion applied.");
    })
  );
}