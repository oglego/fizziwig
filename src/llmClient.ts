/// <reference lib="dom" />
import * as vscode from "vscode";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streams a chat completion from a local OpenAI-compatible server
 * (e.g. `llama-server` from llama.cpp, run with --chat-template gemma).
 *
 * Start llama-server like:
 *   llama-server -m gemma-4b.gguf -c 8192 --port 8080
 */
export async function* streamChatCompletion(
  messages: ChatMessage[],
  token: vscode.CancellationToken
): AsyncGenerator<string> {
  const config = vscode.workspace.getConfiguration("fizziwig");
  const url = config.get<string>("serverUrl")!;
  const model = config.get<string>("modelName")!;

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.3
    }),
    signal: controller.signal
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Local model server error: ${response.status} ${response.statusText}. ` +
        `Is llama-server running at ${url}?`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }
}
