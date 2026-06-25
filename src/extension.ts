import * as vscode from "vscode";
import { registerChatParticipant } from "./chatParticipant";
import { registerApplyEditCommand } from "./applyEdit";
import {
  initializeServer,
  stopServer,
  createStatusBar,
  registerRestartCommand,
} from "./server/llamaServer";

export async function activate(context: vscode.ExtensionContext) {
  console.log("Fizziwig activating...");

  // Status bar item lives for the whole session
  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  // Register commands
  registerChatParticipant(context);
  registerApplyEditCommand(context);
  registerRestartCommand(context);

  // Initialize the UI and defer server startup until the user actually needs it.
  initializeServer(context);

  console.log("Fizziwig is active.");
}

export function deactivate() {
  // VS Code calls this when the extension host shuts down (window close,
  // reload, disable). Kills the child process so llama-server doesn't
  // linger as an orphan.
  stopServer();
}
