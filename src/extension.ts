import * as vscode from "vscode";
import { registerChatParticipant } from "./chatParticipant";
import { registerApplyEditCommand } from "./applyEdit";
import {
  startServer,
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

  // Start the server — awaited so the status bar reflects loading state
  // before the user tries to use the chat panel
  await startServer(context);

  console.log("Fizziwig is active.");
}

export function deactivate() {
  // VS Code calls this when the extension host shuts down (window close,
  // reload, disable). Kills the child process so llama-server doesn't
  // linger as an orphan.
  stopServer();
}
