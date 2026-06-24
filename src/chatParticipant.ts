import * as vscode from "vscode";
import { streamChatCompletion, ChatMessage } from "./llmClient";

const SYSTEM_PROMPT = `You are Fizziwig, a helpful and concise coding assistant running locally on the user's machine.
You can see one or more of the user's files as context. Some large files may be truncated — this will be noted inline.
When proposing a code change, put the full revised code in a single fenced code block
with the language tag, so it can be applied directly. Keep explanations brief.`;

// ─── Token budget ─────────────────────────────────────────────────────────────
// Rough estimate: 1 token ≈ 4 characters.
// Total context: 8192 tokens. We reserve:
//   ~512  for the system prompt + chat history overhead
//   ~1024 for the model's response
// That leaves ~6656 tokens (~26,600 chars) for file content.
const CHARS_PER_TOKEN = 4;
const TOTAL_CONTEXT_TOKENS = 8192;
const RESERVED_TOKENS = 1536; // system prompt + history + response headroom
const FILE_BUDGET_CHARS =
  (TOTAL_CONTEXT_TOKENS - RESERVED_TOKENS) * CHARS_PER_TOKEN;

// Active file gets up to 60% of the budget; referenced files share the rest
const ACTIVE_FILE_MAX_CHARS = Math.floor(FILE_BUDGET_CHARS * 0.6);
const REFERENCE_BUDGET_CHARS = FILE_BUDGET_CHARS - ACTIVE_FILE_MAX_CHARS;

export function registerChatParticipant(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (
    request,
    chatContext,
    stream,
    token
  ) => {
    // Collect #file references
    const referencedFiles = await resolveReferencedFiles(request.references);

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
      ? applyLimit(activeFile, ACTIVE_FILE_MAX_CHARS)
      : undefined;

    const budgetedRefs = applyBudgetAcrossFiles(
      referencedFiles,
      REFERENCE_BUDGET_CHARS
    );

    const allFiles = [
      ...(budgetedActive ? [budgetedActive] : []),
      ...budgetedRefs,
    ];

    const fileContext =
      allFiles.length > 0
        ? allFiles.map(formatFile).join("\n\n")
        : "No files are currently open.";

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: fileContext },
    ];

    // Include prior turns for continuity
    for (const turn of chatContext.history) {
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

  // Give each file an equal share of the remaining budget.
  // If a file is smaller than its share, the unused space is
  // redistributed to the remaining files.
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
  const files: ContextFile[] = [];

  for (const ref of references) {
    let uri: vscode.Uri | undefined;

    if (ref.value instanceof vscode.Uri) {
      uri = ref.value;
    } else if (ref.value instanceof vscode.Location) {
      uri = ref.value.uri;
    }

    if (!uri) continue;

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      files.push({
        path: uri.fsPath,
        languageId: doc.languageId,
        content: doc.getText(),
      });
    } catch {
      // file couldn't be read — skip silently
    }
  }

  return files;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatFile(file: ContextFile): string {
  return `File: ${file.path}\n\`\`\`${file.languageId}\n${file.content}\n\`\`\``;
}

function extractLastCodeBlock(text: string): string | undefined {
  const matches = [...text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}