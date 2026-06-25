import * as path from "path";
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

// Chunking/retrieval defaults. These keep large files useful without flooding
// the prompt with the entire repository.
const CHUNK_SIZE_CHARS = 2200;
const CHUNK_OVERLAP_CHARS = 240;
const MAX_FOLDER_CANDIDATES = 160;
const MAX_FOLDER_FILES_TO_OPEN = 24;
const MAX_CONTEXT_SLICES = 20;
const MAX_FILE_SIZE_BYTES = 1_500_000;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "let",
  "me",
  "of",
  "on",
  "or",
  "please",
  "show",
  "tell",
  "the",
  "their",
  "this",
  "to",
  "was",
  "what",
  "where",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "tmp",
  "temp",
]);

export function registerChatParticipant(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (
    request,
    chatContext,
    stream,
    token
  ) => {
    const config = vscode.workspace.getConfiguration("fizziwig");
    const contextTokens = config.get<number>("contextSize") ?? 8192;
    const fileBudgetChars = Math.max(
      0,
      (contextTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN
    );
    const activeFileMaxChars = Math.floor(fileBudgetChars * ACTIVE_FILE_SHARE);
    const referenceBudgetChars = fileBudgetChars - activeFileMaxChars;
    const retrievalQuery = buildRetrievalQuery(request.prompt, chatContext);
    const queryTerms = tokenizeForRetrieval(retrievalQuery);

    // Start the server while we collect and score context in parallel.
    const serverReady = ensureServerStarted(context);
    const referencedFilesPromise = resolveReferencedFiles(
      request.references,
      queryTerms
    );
    const referencedFiles = await referencedFilesPromise;
    await serverReady;

    // Always include the active file if not already referenced.
    const editor = vscode.window.activeTextEditor;
    let activeFile: ContextFile[] = [];
    if (editor) {
      const activePath = editor.document.uri.fsPath;
      const alreadyReferenced = referencedFiles.some(
        (file) => file.path === activePath
      );
      if (!alreadyReferenced) {
        activeFile = await resolveDocumentContext(
          editor.document.uri,
          editor.document.languageId,
          queryTerms,
          { sourcePath: activePath }
        );
      }
    }

    const budgetedActive = applyBudgetAcrossFiles(
      activeFile,
      activeFileMaxChars
    ).slice(0, MAX_CONTEXT_SLICES);

    const budgetedRefs = applyBudgetAcrossFiles(
      referencedFiles,
      referenceBudgetChars
    );

    const allFiles = compact([
      ...budgetedActive,
      ...budgetedRefs,
    ]).slice(0, MAX_CONTEXT_SLICES);

    const fileSection =
      allFiles.length > 0
        ? `The following files are provided as context. Folder references are expanded into relevant files and chunks, and large files may be represented by selected chunks:\n\n${allFiles.map(formatFile).join("\n\n")}`
        : "No files are currently open in the editor.";

    const systemContent = `You are Fizziwig, a helpful and concise coding assistant running locally.
DO NOT ask the user to paste or provide code. File context is injected automatically below.
If no files are shown, tell the user to open a file or use #file or a folder attachment to add context.
Some large files may be truncated or chunked — this will be noted inline.
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

    // Show context summary so the user knows what was sent.
    if (allFiles.length > 0) {
      const summary = allFiles
        .map((file) => {
          const name = path.basename(file.path);
          const suffix = file.chunkLabel ? ` ${file.chunkLabel}` : "";
          return file.truncated
            ? `${name}${suffix} *(truncated)*`
            : `${name}${suffix}`;
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
  chunkLabel?: string;
  relevance?: number;
}

interface ResolveOptions {
  sourcePath?: string;
}

interface ScoredSlice {
  index: number;
  total: number;
  content: string;
  score: number;
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
  if (files.length === 0 || totalBudget <= 0) return [];

  let remaining = totalBudget;
  const result: ContextFile[] = [];

  for (let i = 0; i < files.length && remaining > 0; i++) {
    const sharePerFile = Math.max(1, Math.floor(remaining / (files.length - i)));
    const limited = applyLimit(files[i], sharePerFile);
    result.push(limited);
    remaining -= Math.min(files[i].content.length, sharePerFile);
  }

  return result;
}

// ─── File and folder resolution ──────────────────────────────────────────────

async function resolveReferencedFiles(
  references: readonly vscode.ChatPromptReference[],
  queryTerms: Set<string>
): Promise<ContextFile[]> {
  const files = await Promise.all(
    references.map(async (ref) => {
      let uri: vscode.Uri | undefined;

      if (ref.value instanceof vscode.Uri) {
        uri = ref.value;
      } else if (ref.value instanceof vscode.Location) {
        uri = ref.value.uri;
      }

      if (!uri) return [] as ContextFile[];

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          return resolveFolderContext(uri, queryTerms);
        }
        if (stat.type === vscode.FileType.File) {
          return resolveDocumentContext(uri, undefined, queryTerms, {
            sourcePath: uri.fsPath,
          });
        }
      } catch {
        // Ignore unreadable references.
      }

      return [] as ContextFile[];
    })
  );

  return compact(files.flat());
}

async function resolveFolderContext(
  folderUri: vscode.Uri,
  queryTerms: Set<string>
): Promise<ContextFile[]> {
  const candidateUris = await collectFolderCandidateUris(folderUri);
  if (candidateUris.length === 0) return [];

  const scoredCandidates = await Promise.all(
    candidateUris.map(async (uri) => {
      let score = scorePath(uri.fsPath, queryTerms);

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          score -= 2;
        }
      } catch {
        score -= 2;
      }

      return { uri, score };
    })
  );

  const shortlist = scoredCandidates
    .sort((a, b) => b.score - a.score || a.uri.fsPath.localeCompare(b.uri.fsPath))
    .slice(0, MAX_FOLDER_FILES_TO_OPEN)
    .map((entry) => entry.uri);

  const resolved = await Promise.all(
    shortlist.map((uri) => resolveDocumentContext(uri, undefined, queryTerms, {
      sourcePath: uri.fsPath,
    }))
  );

  return compact(resolved.flat());
}

async function resolveDocumentContext(
  uri: vscode.Uri,
  languageId: string | undefined,
  queryTerms: Set<string>,
  options: ResolveOptions = {}
): Promise<ContextFile[]> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const resolvedLanguageId = languageId ?? doc.languageId;
    const content = doc.getText();
    const sourcePath = options.sourcePath ?? uri.fsPath;

    if (content.length <= CHUNK_SIZE_CHARS) {
      return [
        {
          path: sourcePath,
          languageId: resolvedLanguageId,
          content,
          relevance: scorePath(sourcePath, queryTerms),
        },
      ];
    }

    return scoreAndSelectChunks(sourcePath, resolvedLanguageId, content, queryTerms);
  } catch {
    // file couldn't be read — skip silently
    return [];
  }
}

async function collectFolderCandidateUris(
  folderUri: vscode.Uri
): Promise<vscode.Uri[]> {
  const results: vscode.Uri[] = [];
  const stack: vscode.Uri[] = [folderUri];

  while (stack.length > 0 && results.length < MAX_FOLDER_CANDIDATES) {
    const current = stack.pop();
    if (!current) continue;

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(current);
    } catch {
      continue;
    }

    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        if (!IGNORED_DIR_NAMES.has(name) && !name.startsWith(".")) {
          stack.push(vscode.Uri.joinPath(current, name));
        }
        continue;
      }

      if (type !== vscode.FileType.File) {
        continue;
      }

      if (shouldSkipFile(name)) {
        continue;
      }

      results.push(vscode.Uri.joinPath(current, name));
      if (results.length >= MAX_FOLDER_CANDIDATES) {
        break;
      }
    }
  }

  return results;
}

function shouldSkipFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".bmp") ||
    lower.endsWith(".ico") ||
    lower.endsWith(".pdf") ||
    lower.endsWith(".zip") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".gz") ||
    lower.endsWith(".7z") ||
    lower.endsWith(".exe") ||
    lower.endsWith(".dll") ||
    lower.endsWith(".so") ||
    lower.endsWith(".dylib")
  );
}

// ─── Chunking and retrieval ───────────────────────────────────────────────────

function scoreAndSelectChunks(
  sourcePath: string,
  languageId: string,
  content: string,
  queryTerms: Set<string>
): ContextFile[] {
  const chunks = splitIntoChunks(content, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS);
  if (chunks.length <= 1) {
    return [
      {
        path: sourcePath,
        languageId,
        content,
        relevance: scorePath(sourcePath, queryTerms),
      },
    ];
  }

  const scored = chunks.map((chunk, index) => ({
    index,
    total: chunks.length,
    content: chunk,
    score:
      scorePath(sourcePath, queryTerms) +
      scoreText(chunk, queryTerms) +
      scoreChunkStructure(chunk),
  }));

  const selectedIndices = new Set<number>();
  const topSlices = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(3, scored.length));

  for (const slice of topSlices) {
    selectedIndices.add(slice.index);
    if (slice.index > 0) selectedIndices.add(slice.index - 1);
    if (slice.index < slice.total - 1) selectedIndices.add(slice.index + 1);
  }

  return [...selectedIndices]
    .sort((a, b) => a - b)
    .map((index) => {
      const slice = scored[index];
      return {
        path: sourcePath,
        languageId,
        content: slice.content,
        truncated: true,
        chunkLabel: `chunk ${index + 1}/${slice.total}`,
        relevance: slice.score,
      };
    });
}

function splitIntoChunks(
  content: string,
  chunkSize: number,
  overlap: number
): string[] {
  if (content.length <= chunkSize) return [content];

  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    const end = Math.min(content.length, start + chunkSize);
    chunks.push(content.slice(start, end));
    if (end >= content.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

function scoreText(text: string, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0;

  const normalized = text.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    const count = countOccurrences(normalized, term);
    if (count > 0) {
      score += count;
      if (normalized.includes(`function ${term}`)) score += 2;
      if (normalized.includes(`class ${term}`)) score += 2;
      if (normalized.includes(`export ${term}`)) score += 1;
    }
  }

  return score;
}

function scoreChunkStructure(text: string): number {
  let score = 0;
  if (text.includes("export ")) score += 1;
  if (text.includes("function ")) score += 1;
  if (text.includes("class ")) score += 1;
  if (text.includes("interface ")) score += 1;
  if (text.includes("const ")) score += 0.5;
  return score;
}

function scorePath(filePath: string, queryTerms: Set<string>): number {
  const normalized = filePath.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const basename = path.basename(filePath).toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    if (basename.includes(term)) {
      score += 5;
    } else if (normalized.includes(term)) {
      score += 2;
    }
  }

  if (/readme|package\.json|tsconfig|index|main|app|server|route|router|controller|service/.test(basename)) {
    score += 1;
  }

  return score;
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(term, index);
    if (index === -1) break;
    count++;
    index += term.length;
  }
  return count;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function buildRetrievalQuery(
  prompt: string,
  chatContext: vscode.ChatContext
): string {
  const recentQuestions = chatContext.history
    .slice(-4)
    .filter((turn): turn is vscode.ChatRequestTurn => turn instanceof vscode.ChatRequestTurn)
    .map((turn) => turn.prompt);

  return [prompt, ...recentQuestions].join("\n");
}

function tokenizeForRetrieval(text: string): Set<string> {
  const terms = text
    .toLowerCase()
    .replace(/[`"'()[\]{}.,!?;:/\\|<>@#$%^&*+=~\-]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));

  return new Set(terms);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatFile(file: ContextFile): string {
  const chunkLabel = file.chunkLabel ? ` [${file.chunkLabel}]` : "";
  const relevance = file.relevance ? ` (relevance ${file.relevance.toFixed(1)})` : "";
  const truncationNote = file.truncated ? "\n// ... [file chunked/truncated by Fizziwig]" : "";
  return `File: ${file.path}${chunkLabel}${relevance}\n\`\`\`${file.languageId}\n${file.content}${truncationNote}\n\`\`\``;
}

function extractLastCodeBlock(text: string): string | undefined {
  const matches = [...text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

function compact<T>(items: Array<T | undefined | null>): T[] {
  return items.filter((item): item is T => item !== undefined && item !== null);
}
