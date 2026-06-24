import * as vscode from "vscode";
import { streamChatCompletion, ChatMessage } from "./llmClient";

const SYSTEM_PROMPT = `You are a helpful, concise coding assistant running locally.
You can see the user's currently open file as context.
When proposing a code change, put the full revised code in a single fenced code block
with the language tag, so it can be applied directly. Keep explanations brief.`;

export function registerChatParticipant(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (
    request,
    chatContext,
    stream,
    token
  ) => {
    const editor = vscode.window.activeTextEditor;
    let fileContext = "No file is currently open.";
    if (editor) {
      const fileName = editor.document.fileName;
      const lang = editor.document.languageId;
      const fullText = editor.document.getText();

      // Truncate large files to avoid blowing past model context windows.
      const cfg = vscode.workspace.getConfiguration("fizziwig");
      const contextTokens = cfg.get<number>("contextSize") ?? 8192;
      const approxCharsPerToken = 4; // conservative chars->token estimate
      const maxChars = Math.min(200_000, Math.max(2_000, contextTokens * approxCharsPerToken));

      let excerpt = fullText;
      let truncatedNote = "";
      if (fullText.length > maxChars) {
        // Keep the tail of the file which is often most relevant (recent edits)
        excerpt = fullText.slice(fullText.length - maxChars);
        const removed = fullText.length - excerpt.length;
        truncatedNote = `\n\n[Truncated ${removed} characters from start of file to fit model context]`;
      }

      fileContext = `Current file: ${fileName}\n\`\`\`${lang}\n${excerpt}\n\`\`\`` + truncatedNote;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: fileContext }
    ];

    // include prior turns in this chat session for continuity
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

    let fullResponse = "";
    try {
      for await (const chunk of streamChatCompletion(messages, token)) {
        fullResponse += chunk;
        stream.markdown(chunk);
      }
    } catch (err: any) {
      stream.markdown(`\n\n⚠️ **Error talking to local model:** ${err.message}`);
      return;
    }

    // stash the last code block so the "Apply Last Edit" command can use it
    const codeBlock = extractLastCodeBlock(fullResponse);
    if (codeBlock) {
      context.workspaceState.update("lastSuggestedEdit", codeBlock);
      stream.markdown(
        "\n\n*Run **Fizziwig: Apply Last Suggested Edit** to insert this into the active editor.*"
      );
    }
  };

  const participant = vscode.chat.createChatParticipant("fizziwig.chat", handler);
  context.subscriptions.push(participant);
}

function extractLastCodeBlock(text: string): string | undefined {
  const matches = [...text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}
