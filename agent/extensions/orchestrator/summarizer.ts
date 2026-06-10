// Bytes per token — conservative estimate for code content
const BYTES_PER_TOKEN = 3.5;
// Tokens reserved for the system prompt, question, and model output
const CONTEXT_RESERVE_TOKENS = 2_048;
// Safe fallback if Ollama show API fails
const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;

export const WORKER_TIMEOUT_MS = 30_000;

const SENSITIVE_COMMANDS = /\b(npm|yarn|pnpm|gradle|mvn|make|jest|pytest|cargo|go test|vitest|mocha|jasmine|bun test)\b/;
const GREP_FILE_PREFIX = /^([^:]+):/;

const SYSTEM_PROMPT =
  "You are a precise code-analysis assistant. " +
  "Answer in 3–5 sentences of plain prose. No markdown headers, no bullet lists, no bold labels. " +
  "Focus only on what is asked. Do not repeat code verbatim. " +
  "No preamble or closing remarks. " +
  "Suppress any <think> blocks — output only the final answer.";

export interface WorkerConfig {
  model: string;
  baseUrl: string;
}

// Per-model context budget cache (keyed by model name)
const _budgetCache = new Map<string, number>();

export async function getWorkerContextBudget(config: WorkerConfig): Promise<number> {
  const cached = _budgetCache.get(config.model);
  if (cached !== undefined) return cached;

  let budget: number;
  try {
    const res = await fetch(`${config.baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: config.model }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { model_info?: Record<string, unknown> };
      const info = json.model_info ?? {};
      // Ollama stores context length as e.g. "llama.context_length" or "qwen2.context_length"
      const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
      const ctxTokens = ctxKey ? Number(info[ctxKey]) : DEFAULT_CONTEXT_WINDOW_TOKENS;
      const usableTokens = Math.max(1024, ctxTokens - CONTEXT_RESERVE_TOKENS);
      budget = Math.floor(usableTokens * BYTES_PER_TOKEN);
    } else {
      budget = Math.floor((DEFAULT_CONTEXT_WINDOW_TOKENS - CONTEXT_RESERVE_TOKENS) * BYTES_PER_TOKEN);
    }
  } catch {
    budget = Math.floor((DEFAULT_CONTEXT_WINDOW_TOKENS - CONTEXT_RESERVE_TOKENS) * BYTES_PER_TOKEN);
  }

  _budgetCache.set(config.model, budget);
  return budget;
}

export function invalidateBudgetCache(model: string): void {
  _budgetCache.delete(model);
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function callOllama(
  config: WorkerConfig,
  question: string,
  content: string,
  signal: AbortSignal | undefined,
  goalContext?: string
): Promise<string> {
  const contextPrefix = goalContext ? `Context: ${goalContext}\n\n` : "";
  const userMessage = `${contextPrefix}Question: ${question}\n\nContent:\n${content}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  // Combine user abort signal with timeout signal
  const combinedSignal =
    signal && (AbortSignal as any).any
      ? (AbortSignal as any).any([signal, controller.signal])
      : controller.signal;

  try {
    const response = await fetch(`${config.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        options: { temperature: 0.1, num_predict: 256 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 404) throw new OllamaModelMissingError(config.model);
      throw new Error(`Ollama ${response.status}: ${body.slice(0, 200)}`);
    }

    const json = (await response.json()) as { message?: { content?: string }; error?: string };
    if (json.error) throw new Error(`Ollama error: ${json.error}`);

    return stripThink(json.message?.content?.trim() ?? "(no response)");
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaModelMissingError extends Error {
  constructor(public readonly model: string) {
    super(`Model not found: ${model}`);
  }
}

export function isSensitiveCommand(command: string): boolean {
  return SENSITIVE_COMMANDS.test(command);
}

// Fallback questions used only when Sonnet's intent is unavailable
const FALLBACK_QUESTIONS: Record<string, string> = {
  read: "List public methods with signatures, key types, important dependencies, and any error handling gaps.",
  grep: "What role does this pattern play in each of these files? Group by file, be concise.",
  bash: "Summarize the key facts in this output: numbers, paths, errors, patterns.",
  find: "Describe the directory structure and what each folder or file grouping appears to be for.",
  ls:   "Describe the directory structure and what each folder or file grouping appears to be for.",
};

// Extract filenames from a bash cat command, e.g. "cat foo.java\ncat bar.java"
function extractCatFiles(command: string): string[] {
  const files: string[] = [];
  for (const line of command.split(/\n|&&/)) {
    const m = line.trim().match(/^cat\s+(.+)$/);
    if (m) files.push(m[1].trim().split("/").pop() ?? m[1].trim());
  }
  return files;
}

export function deriveTask(
  toolName: string,
  input: Record<string, unknown>,
  orchestratorIntent?: string
): string {
  // Upgrade bash cat → read-style question so we ask about the files, not generic output
  const command = (input.command as string) ?? "";
  const isCat = toolName === "bash" && /^\s*cat\s+/.test(command);
  const effectiveTool = isCat ? "read" : toolName;

  // Use Sonnet's actual intent as the primary question when available
  if (orchestratorIntent) {
    const intent = orchestratorIntent.trim().slice(0, 300);
    switch (effectiveTool) {
      case "read":
        return `${intent}\n\nFocus on: method signatures, types, dependencies, and patterns relevant to the above. Be concise.`;
      case "grep":
        return `${intent}\n\nFocus on: how this pattern is used across the matched files. Group by file.`;
      case "bash":
        return `${intent}\n\nExtract the key facts from this output relevant to the above.`;
      case "find":
      case "ls":
        return `${intent}\n\nDescribe the relevant parts of this directory structure.`;
      default:
        return intent;
    }
  }

  // No intent — derive the best question we can from the tool args alone
  if (isCat) {
    const files = extractCatFiles(command);
    if (files.length > 0) {
      return `For each of these files (${files.join(", ")}): list public methods with signatures, key types, important dependencies, and any notable patterns or error handling. One section per file.`;
    }
  }

  if (toolName === "grep") {
    const pattern = (input.pattern ?? input.regex ?? "") as string;
    return `What role does \`${pattern}\` play in each of these files? Group by file, be concise.`;
  }

  return FALLBACK_QUESTIONS[toolName] ?? "Summarize the key findings relevant to the coding task.";
}

function splitGrepByFile(raw: string, budget: number): string[] {
  const byFile = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    const m = GREP_FILE_PREFIX.exec(line);
    const file = m ? m[1] : "__other__";
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(line);
  }

  const chunks: string[] = [];
  let current = "";
  for (const lines of byFile.values()) {
    const block = lines.join("\n") + "\n";
    if (Buffer.byteLength(current + block, "utf-8") > budget) {
      if (current) chunks.push(current);
      current = block;
    } else {
      current += block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitByLines(raw: string, budget: number): string[] {
  const lines = raw.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const addition = line + "\n";
    if (Buffer.byteLength(current + addition, "utf-8") > budget) {
      if (current) chunks.push(current);
      current = addition;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function countGrepFiles(raw: string): number {
  const files = new Set<string>();
  for (const line of raw.split("\n")) {
    const m = GREP_FILE_PREFIX.exec(line);
    if (m) files.add(m[1]);
  }
  return files.size;
}

export async function summarize(
  config: WorkerConfig,
  toolName: string,
  input: Record<string, unknown>,
  rawContent: string,
  signal: AbortSignal | undefined,
  goalContext?: string,
  orchestratorIntent?: string
): Promise<string> {
  const budget = await getWorkerContextBudget(config);
  const rawBytes = Buffer.byteLength(rawContent, "utf-8");
  const question = deriveTask(toolName, input, orchestratorIntent);

  // Grep stratification: too many files → meta-summary instead of per-line
  if (toolName === "grep") {
    const fileCount = countGrepFiles(rawContent);
    if (fileCount > 10) {
      const pattern = (input.pattern ?? input.regex ?? "") as string;
      const metaQ = `Which 5 files most centrally use \`${pattern}\` and what role does each play? The rest are secondary — just note their count.`;
      if (rawBytes <= budget) {
        return callOllama(config, metaQ, rawContent, signal, goalContext);
      }
      const chunks = splitGrepByFile(rawContent, budget);
      const partials = await Promise.all(chunks.map((c) => callOllama(config, metaQ, c, signal, goalContext)));
      if (partials.length === 1) return partials[0];
      return callOllama(config, "Merge these partial answers into one coherent summary:", partials.join("\n\n---\n\n"), signal);
    }
  }

  // Fast path: fits in one call
  if (rawBytes <= budget) {
    return callOllama(config, question, rawContent, signal, goalContext);
  }

  // Chunked path: split → N summaries → merge
  const chunks = toolName === "grep" ? splitGrepByFile(rawContent, budget) : splitByLines(rawContent, budget);
  const partials = await Promise.all(chunks.map((c) => callOllama(config, question, c, signal, goalContext)));
  if (partials.length === 1) return partials[0];
  return callOllama(config, "Merge these partial summaries into one coherent answer:", partials.join("\n\n---\n\n"), signal);
}
