import * as vscode from "vscode";
import { registerChatParticipant } from "./chatParticipant";
import { registerApplyEditCommand } from "./applyEdit";

export function activate(context: vscode.ExtensionContext) {
  console.log("Fizziwig is now active.");
  registerChatParticipant(context);
  registerApplyEditCommand(context);
}

export function deactivate() {}
