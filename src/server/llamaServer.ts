import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";

let serverProcess: cp.ChildProcess | undefined;
let startupPromise: Promise<void> | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_SERVER_URL = "http://localhost:8080/v1/chat/completions";

// ─── Status Bar ──────────────────────────────────────────────────────────────

export function createStatusBar(): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "fizziwig.showServerOutput";
  setStatus("stopped");
  statusBarItem.show();
  return statusBarItem;
}

type ServerStatus = "loading" | "ready" | "error" | "stopped";

function setStatus(status: ServerStatus, detail?: string) {
  const labels: Record<ServerStatus, string> = {
    loading: "$(sync~spin) Fizziwig: loading...",
    ready:   "$(check) Fizziwig: ready",
    error:   "$(error) Fizziwig: error",
    stopped: "$(circle-slash) Fizziwig: stopped",
  };
  const tooltips: Record<ServerStatus, string> = {
    loading: "Fizziwig is loading the model, please wait...",
    ready:   "Fizziwig server is running. Click to view logs.",
    error:   detail ?? "Server failed to start. Click to view logs.",
    stopped: "Fizziwig server is not running.",
  };
  statusBarItem.text = labels[status];
  statusBarItem.tooltip = tooltips[status];
  statusBarItem.backgroundColor =
    status === "error"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;
}

// ─── Binary resolution ───────────────────────────────────────────────────────

function getBinaryPath(extensionPath: string): string {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch;         // 'arm64' | 'x64'
  const binaryName =
    platform === "win32" ? "llama-server.exe" : "llama-server";
  return path.join(extensionPath, "bin", `${platform}-${arch}`, binaryName);
}

function binaryExists(extensionPath: string): boolean {
  return fs.existsSync(getBinaryPath(extensionPath));
}

// ─── Model picker ────────────────────────────────────────────────────────────

async function promptForModel(): Promise<string | undefined> {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    filters: { "GGUF Model": ["gguf"] },
    title: "Select your GGUF model file to use with Fizziwig",
  });

  if (!result?.[0]) return undefined;

  const modelPath = result[0].fsPath;
  await vscode.workspace
    .getConfiguration("fizziwig")
    .update("modelPath", modelPath, vscode.ConfigurationTarget.Global);

  return modelPath;
}

// ─── Initialization ──────────────────────────────────────────────────────────

export function initializeServer(
  context: vscode.ExtensionContext
): void {
  outputChannel = vscode.window.createOutputChannel("Fizziwig");
  context.subscriptions.push(outputChannel);

  // Register a command to open the output channel from the status bar
  context.subscriptions.push(
    vscode.commands.registerCommand("fizziwig.showServerOutput", () => {
      outputChannel.show();
    })
  );
  setStatus("stopped");
}

export async function ensureServerStarted(
  context: vscode.ExtensionContext
): Promise<void> {
  const config = vscode.workspace.getConfiguration("fizziwig");
  const serverUrl = config.get<string>("serverUrl") ?? DEFAULT_SERVER_URL;

  if (!shouldManageLocalServer(serverUrl)) {
    if (serverProcess) {
      stopServer();
    }
    setStatus("ready");
    return;
  }

  if (serverProcess?.exitCode === null) {
    return;
  }

  if (startupPromise) {
    return startupPromise;
  }

  startupPromise = launchServer(context.extensionPath).finally(() => {
    startupPromise = undefined;
  });

  return startupPromise;
}

async function launchServer(
  extensionPath: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("fizziwig");
  const port = config.get<number>("serverPort") ?? 8080;
  const contextSize = config.get<number>("contextSize") ?? 8192;
  let modelPath = config.get<string>("modelPath");
  const configuredBinary = config.get<string>("binaryPath");
  const configuredBinaryExists =
    !!configuredBinary && fs.existsSync(configuredBinary);
  const hasBundled = binaryExists(extensionPath);
  const binaryPath = configuredBinary ?? getBinaryPath(extensionPath);

  setStatus("loading");
  
  // Ensure we have an output channel when launching
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Fizziwig");
  }
  
  outputChannel.appendLine(`[fizziwig] Starting llama-server...`);
  outputChannel.appendLine(`  binary:  ${binaryPath}`);
  outputChannel.appendLine(`  port:    ${port}`);
  outputChannel.appendLine(`  context: ${contextSize}`);

  try {
    if (!configuredBinaryExists && !hasBundled) {
      setStatus("error", "No llama-server binary found for this platform.");
      const choice = await vscode.window.showErrorMessage(
        `Fizziwig: no bundled llama-server binary found for ${process.platform}-${process.arch}.`,
        "Use External Server",
        "Select Binary",
        "View Logs"
      );

      if (choice === "Use External Server") {
        setStatus("ready");
        return;
      }

      if (choice === "Select Binary") {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          title: "Select your llama-server binary",
        });
        if (result?.[0]) {
          const picked = result[0].fsPath;
          await vscode.workspace
            .getConfiguration("fizziwig")
            .update("binaryPath", picked, vscode.ConfigurationTarget.Global);

          if (!modelPath || !fs.existsSync(modelPath)) {
            modelPath = await promptForModel();
          }

          if (modelPath) {
            await launchServer(extensionPath);
          }
        }
        return;
      }

      outputChannel.show();
      return;
    }

    if (!modelPath || !fs.existsSync(modelPath)) {
      outputChannel.appendLine(
        modelPath
          ? `Model file not found at: ${modelPath} — prompting for new path.`
          : "No model configured — prompting user."
      );
      modelPath = await promptForModel();
    }

    if (!modelPath) {
      setStatus("stopped");
      vscode.window.showWarningMessage(
        "Fizziwig: no model selected. Extension will not start."
      );
      return;
    }

    const resolvedModelPath = modelPath;
    outputChannel.appendLine(`  model:   ${modelPath}`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fizziwig: loading model...",
        cancellable: false,
      },
      () =>
        new Promise<void>((resolve, reject) => {
          let ready = false;
          const child: cp.ChildProcess = cp.spawn(binaryPath, [
            "-m",
            resolvedModelPath,
            "-c",
            String(contextSize),
            "--port",
            String(port),
            "--log-disable",
          ]);
          serverProcess = child;

          const timer = setTimeout(() => {
            if (!ready) {
              const err = new Error("Model load timed out after 3 minutes.");
              outputChannel.appendLine(`[fizziwig] ${err.message}`);
              setStatus("error", err.message);
              serverProcess = undefined;
              reject(err);
            }
          }, 180_000);

          // llama-server writes its logs to stderr
          child.stderr?.on("data", (data: Buffer) => {
            const text = data.toString();
            outputChannel.append(text);

            // Improved readiness check: Look for a specific success message
            if (!ready && text.includes("listening")) {
              ready = true;
              clearTimeout(timer);
              setStatus("ready");
              outputChannel.appendLine("[fizziwig] Server is ready.");
              resolve();
            }
          });

          child.stdout?.on("data", (data: Buffer) => {
            outputChannel.append(data.toString());
          });

          child.on("error", (err) => {
            clearTimeout(timer);
            setStatus("error", err.message);
            outputChannel.appendLine(`[fizziwig] Process error: ${err.message}`);
            serverProcess = undefined;
            reject(err);
          });

          child.on("exit", (code, signal) => {
            clearTimeout(timer);
            const hadBeenReady = ready;
            serverProcess = undefined;
            if (!ready) {
              const msg = `Server exited before becoming ready (code ${code}, signal ${signal})`;
              setStatus("error", msg);
              outputChannel.appendLine(`[fizziwig] ${msg}`);
              reject(new Error(msg));
              return;
            }

            // If we were ready and the server exits, update status
            if (code !== 0 && signal !== "SIGTERM") {
              setStatus("error", `Exited with code ${code}`);
              outputChannel.appendLine(
                `[fizziwig] Server exited unexpectedly (code ${code}, signal ${signal})`
              );
            } else if (hadBeenReady) {
              setStatus("stopped");
            }
          });
        })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus("error", message);
    vscode.window
      .showErrorMessage(`Fizziwig failed to start: ${message}`, "View Logs")
      .then((choice) => {
        if (choice === "View Logs") outputChannel.show();
      });
  }
}

// ─── Stop ────────────────────────────────────────────────────────────────────

export function stopServer(): void {
  if (serverProcess) {
    outputChannel?.appendLine("[fizziwig] Stopping server...");
    serverProcess.kill("SIGTERM");
    serverProcess = undefined;
    startupPromise = undefined;
    setStatus("stopped");
  }
}

// ─── Restart command (handy during development) ───────────────────────────────

export function registerRestartCommand(
  context: vscode.ExtensionContext
): void {
    context.subscriptions.push(
      vscode.commands.registerCommand("fizziwig.restartServer", async () => {
        stopServer();
        await ensureServerStarted(context);
      })
    );
}

function shouldManageLocalServer(serverUrl: string): boolean {
  try {
    const parsed = new URL(serverUrl);
    return LOCAL_HOSTNAMES.has(parsed.hostname);
  } catch {
    return true;
  }
}
