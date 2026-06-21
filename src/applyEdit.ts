import * as vscode from "vscode";

export function registerApplyEditCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "fizziwig.applyLastEdit",
    async () => {
      const newCode = context.workspaceState.get<string>("lastSuggestedEdit");
      const editor = vscode.window.activeTextEditor;

      if (!newCode) {
        vscode.window.showWarningMessage("No suggested edit to apply yet.");
        return;
      }
      if (!editor) {
        vscode.window.showWarningMessage("No active editor to apply the edit to.");
        return;
      }

      const confirm = await vscode.window.showInformationMessage(
        "Replace the entire active file with the suggested edit?",
        { modal: true },
        "Apply",
        "Cancel"
      );
      if (confirm !== "Apply") return;

      const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
      );

      const edit = new vscode.WorkspaceEdit();
      edit.replace(editor.document.uri, fullRange, newCode);
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage("Edit applied.");
    }
  );

  context.subscriptions.push(disposable);
}
