import * as vscode from "vscode";
import { streamChatCompletion, ChatMessage } from "./llmClient";
import { ensureServerStarted } from "./server/llamaServer";

// ─── Token budget ─────────────────────────────────────────────────────────────
// Rough estimate: 1 token ≈ 4 characters.
// Total context: read from config at request time.
// We reserve ~1536 tokens for system prompt + history + response headroom.
const CHARS_PER_TOKEN = 4;
const RESERVED_TOKENS = 1536;
const ACTIVE_FILE_SHARE = 0.6;
const MAX_HISTORY_TURNS = 8;

export function registerChatParticipant(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (
    request,
    chatContext,
    stream,
    token
  ) => {
    // Read context size from config so it stays in sync with llamaServer
    const config = vscode.workspace.getConfiguration("fizziwig");
    const contextTokens = config.get<number>("contextSize") ?? 8192;
    const fileBudgetChars = Math.max(
      0,
      (contextTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN
    );
    const activeFileMaxChars = Math.floor(fileBudgetChars * ACTIVE_FILE_SHARE);
    const referenceBudgetChars = fileBudgetChars - activeFileMaxChars;

    // Start the server and collect file references in parallel.
    const serverReady = ensureServerStarted(context);
    const referencedFilesPromise = resolveReferencedFiles(request.references);
    const referencedFiles = await referencedFilesPromise;
    await serverReady;

    // Always include the active file if not already referenced
    const editor = vscode.window.activeTextEditor;
    let activeFile: ContextFile | undefined;
    if (editor) {
      const activePath = editor.document.uri.fsPath;
      const alreadyReferenced = referencedFiles.some(
        (f) => f.path === activePath
      );
      if (!alreadyReferenced) {
        activeFile = {
          path: activePath,
          languageId: editor.document.languageId,
          content: editor.document.getText(),
        };
      }
    }

    // Apply token budget limits
    const budgetedActive = activeFile
      ? applyLimit(activeFile, activeFileMaxChars)
      : undefined;

    const budgetedRefs = applyBudgetAcrossFiles(
      referencedFiles,
      referenceBudgetChars
    );

    const allFiles = [
      ...(budgetedActive ? [budgetedActive] : []),
      ...budgetedRefs,
    ];

    // Build a single system message — Gemma handles one system message
    // much more reliably than two separate ones
    const fileSection =
      allFiles.length > 0
        ? `The following files are provided as context:\n\n${allFiles.map(formatFile).join("\n\n")}`
        : "No files are currently open in the editor.";

    const systemContent = `You are Fizziwig, a helpful and concise coding assistant running locally.
DO NOT ask the user to paste or provide code. File context is injected automatically below.
If no files are shown, tell the user to open a file or use #file to attach one.
Some large files may be truncated — this will be noted inline.
When proposing a code change, put the full revised code in a single fenced code block with the language tag. Keep explanations brief.

${fileSection}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
    ];

    // Include only the most recent turns; the active file carries most of the
    // useful state, and capping history keeps prompts smaller and faster.
    for (const turn of chatContext.history.slice(-MAX_HISTORY_TURNS)) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({ role: "user", content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((part) =>
            part instanceof vscode.ChatResponseMarkdownPart
              ? part.value.value
              : ""
          )
          .join("");
        messages.push({ role: "assistant", content: text });
      }
    }

    messages.push({ role: "user", content: request.prompt });

    // Show context summary so the user knows what was sent
    if (allFiles.length > 0) {
      const summary = allFiles
        .map((f) => {
          const name = f.path.split("/").pop();
          return f.truncated ? `${name} *(truncated)*` : name;
        })
        .join(", ");
      stream.markdown(`*Context: ${summary}*\n\n`);
    }

    let fullResponse = "";
    try {
      for await (const chunk of streamChatCompletion(messages, token)) {
        fullResponse += chunk;
        stream.markdown(chunk);
      }
    } catch (err: any) {
      stream.markdown(`\n\n⚠️ **Fizziwig error:** ${err.message}`);
      return;
    }

    const codeBlock = extractLastCodeBlock(fullResponse);
    if (codeBlock) {
      context.workspaceState.update("lastSuggestedEdit", codeBlock);
      stream.markdown(
        "\n\n*Run **Fizziwig: Show Suggested Changes** to review, then **Fizziwig: Accept Suggestion** to apply.*"
      );
    }
  };

  const participant = vscode.chat.createChatParticipant("fizziwig.chat", handler);
  context.subscriptions.push(participant);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContextFile {
  path: string;
  languageId: string;
  content: string;
  truncated?: boolean;
}

// ─── Budget helpers ───────────────────────────────────────────────────────────

function applyLimit(file: ContextFile, maxChars: number): ContextFile {
  if (file.content.length <= maxChars) return file;
  return {
    ...file,
    content:
      file.content.slice(0, maxChars) +
      "\n\n// ... [file truncated by Fizziwig — content exceeds context window]",
    truncated: true,
  };
}

function applyBudgetAcrossFiles(
  files: ContextFile[],
  totalBudget: number
): ContextFile[] {
  if (files.length === 0) return [];

  let remaining = totalBudget;
  const result: ContextFile[] = [];

  for (let i = 0; i < files.length; i++) {
    const sharePerFile = Math.floor(remaining / (files.length - i));
    result.push(applyLimit(files[i], sharePerFile));
    remaining -= Math.min(files[i].content.length, sharePerFile);
  }

  return result;
}

// ─── File resolution ──────────────────────────────────────────────────────────

async function resolveReferencedFiles(
  references: readonly vscode.ChatPromptReference[]
): Promise<ContextFile[]> {
  const files = await Promise.all(
    references.map(async (ref) => {
      let uri: vscode.Uri | undefined;

      if (ref.value instanceof vscode.Uri) {
        uri = ref.value;
      } else if (ref.value instanceof vscode.Location) {
        uri = ref.value.uri;
      }

      if (!uri) return undefined;

      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        return {
          path: uri.fsPath,
          languageId: doc.languageId,
          content: doc.getText(),
        };
      } catch {
        // file couldn't be read — skip silently
        return undefined;
      }
    })
  );

  return files.filter((file): file is ContextFile => file !== undefined);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatFile(file: ContextFile): string {
  return `File: ${file.path}\n\`\`\`${file.languageId}\n${file.content}\n\`\`\``;
}

function extractLastCodeBlock(text: string): string | undefined {
  const matches = [...text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}
