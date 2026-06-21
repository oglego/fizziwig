# Fizziwig

Fizziwig is a minimal, free, and open-source Visual Studio Code extension
that adds a local-first chat assistant to the VS Code Chat panel. Instead of
relying on cloud-based APIs or requiring API keys, Fizziwig communicates with
an OpenAI-compatible HTTP server running locally (for example, `llama-server`)
so your code and conversations stay on your machine.

Key points:

- Local-first: talk to models running on your computer (no cloud required).
- Lightweight: integrates with the VS Code Chat Participant API to surface
  a `@fizziwig` participant in the Chat view.
- Context-aware: the extension sends the currently active file as context so
  the model can reason about your code.
- Streaming output: model responses stream back into the chat in real time,
  recreating the feel of an interactive assistant.
- Apply code: if a response contains a code block, you can apply it to the
  active file with one command (full-file replace, confirmed by a prompt).

## Why the name "Fizziwig"?

The name is intentionally playful and compact. It blends two ideas:

- "Fizzi" evokes something bubbly and fast — a lightweight, responsive
  assistant that feels immediate and local.
- The second syllable, "wig", is a wink to the extension's small-footprint
  UI and the idea of a helper that briefly "dons a wig" to assist you with
  a focused task.

There's also a gentle nod to classic literature: the name resembles
"Fezziwig" — a jovial, hospitable character — which matches the extension's
goal of offering friendly, helpful interactions inside the editor. The
project isn't otherwise related to that work; the similarity is only meant
to convey tone: cheerful, unobtrusive, and focused on making development
pleasant.

## How it works (high level)

1. A local server (for example, `llama-server`) exposes an OpenAI-compatible
   chat completions endpoint (e.g. `http://localhost:8080/v1/chat/completions`).
2. The extension registers a Chat Participant (`@fizziwig`) using VS Code's
   Chat Participant API. When you mention `@fizziwig` in the Chat panel, the
   extension forwards the conversation (plus the active file contents) to the
   configured server.
3. The model's response is streamed back into the Chat view; if it emits a
   code block, a command is available to replace the active file with that
   code. The extension prompts for confirmation before making any changes.

## Setup

These instructions assume you have a local model server available. The README
below uses `llama-server` from the `llama.cpp` project as an example.

1) Build and run `llama-server` (example):

```bash
# clone and build (one-time)
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build && cmake --build build --config Release

# run the server with a GGUF model (adjust memory, port, and model path)
./build/bin/llama-server -m /path/to/your-model.gguf -c 8192 --port 8080
```

This exposes an endpoint like `http://localhost:8080/v1/chat/completions`.

2) Install dependencies and build the extension:

```bash
npm install
npm run compile
```

3) Run in Extension Development Host:

Open the folder in VS Code, press `F5` to start an Extension Development Host
window, open the Chat panel, and mention `@fizziwig` followed by your query.

## Configuration

In your VS Code settings (`settings.json`) you can configure at minimum:

```json
{
  "fizziwig.serverUrl": "http://localhost:8080/v1/chat/completions",
  "fizziwig.modelName": "your-model-name"
}
```

- `fizziwig.serverUrl`: The OpenAI-compatible chat completions URL for your
  local server.
- `fizziwig.modelName`: Optional hint used by some servers to pick a model.

The extension should also work with other local servers that implement the
same API surface (for example, Ollama at `http://localhost:11434/v1/chat/completions`).

## Usage details

- Mention `@fizziwig` in the Chat panel to route a message to the local model.
- The extension sends the active file's text as context with each message —
  this keeps the model focused on the code you are looking at.
- Responses stream as they arrive so you can watch the model compose its
  answer in real time.
- When a response contains a fenced code block, a command is exposed to
  replace the active file with that code. The extension prompts for
  confirmation before making any changes.

## Troubleshooting & tips

- If you see connection errors, verify `fizziwig.serverUrl` matches your
  running server and that the server is reachable from the host running VS Code.
- For large files, consider copying only the most relevant portion into a
  smaller file or use the server's context-window configuration to increase
  capacity where possible.
- If the model produces partial or incorrect code, prefer asking follow-up
  questions in the chat or request a corrected patch rather than applying
  the first suggestion blindly.

## Roadmap / Possible improvements

- Codebase indexing + retrieval: embed files and retrieve only the most
  relevant chunks instead of sending the entire active file.
- Diff-based edits: show a diff and apply only the minimal changes.
- Multi-file editing and worktree-aware changes.
- Inline ghost-text completions using `InlineCompletionItemProvider`.
- Per-workspace server/model profiles and persisted chat history.

## Known limitations (MVP)

- Only the active file is sent as context — large files consume model
  context quickly.
- "Apply edit" currently replaces the full file rather than applying a
  minimal patch.
- Chat history does not persist across VS Code restarts in this MVP.
