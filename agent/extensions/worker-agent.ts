/**
 * worker_delegate — delegate focused code-analysis questions to a local Ollama model.
 *
 * Reads up to 5 source files, sends them + a focused question to the configured worker
 * model, and returns a concise answer (3–5 sentences plain prose).
 *
 * Model config is shared with the orchestrator extension via globalThis.__piWorkerConfig,
 * so /orchestrator worker <model> updates both automatically.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3-coder:30b";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 100 * 1024; // 100 KB per file
const TIMEOUT_MS = 30_000;

// Shared config with orchestrator extension — written by /orchestrator worker <model>
function getWorkerConfig(): { model: string; baseUrl: string } {
  const g = globalThis as any;
  if (!g.__piWorkerConfig) {
    g.__piWorkerConfig = { model: DEFAULT_MODEL, baseUrl: DEFAULT_OLLAMA_BASE_URL };
  }
  return g.__piWorkerConfig;
}

const SYSTEM_PROMPT =
  "You are a precise code-analysis assistant. " +
  "Answer the question about the provided source files in plain prose. " +
  "Focus only on what is asked — one specific fact at a time. " +
  "If asked for a 'complete implementation', 'code snippets', or to 'be very detailed': " +
  "describe the logic in plain language instead (conditions, field names, call targets, " +
  "return values, exceptions). Do not reproduce large code blocks verbatim. " +
  "No preamble, no closing remarks, no markdown headers or bullets. " +
  "Suppress any <think> blocks — output only the final answer.";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "worker_delegate",
    label: "Worker Delegate",
    description:
      "Delegate ONE focused factual question to a local worker LLM. " +
      "The worker reads source files and answers questions about conditions, method signatures, " +
      "field assignments, control flow, dependencies, and comparisons. " +
      "It CANNOT reproduce code verbatim accurately — do not ask for 'complete implementation' " +
      "or 'code snippets'. For exact code, use read immediately before edit. " +
      "Ask one question per call. Decompose multi-part questions into separate calls.",

    parameters: Type.Object({
      task: Type.String({
        description:
          "The specific question to answer. Be precise — e.g. " +
          "'What does the updatePlan method do — what status check does it perform, " +
          "what exception does it throw, and under what condition?'",
      }),
      files: Type.Array(Type.String({ description: "Relative or absolute path to a source file" }), {
        description: "Files to analyze (1–5)",
        minItems: 1,
        maxItems: MAX_FILES,
      }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { task, files } = params;
      const config = getWorkerConfig();

      // --- Read files ---
      const fileSections: string[] = [];
      const errors: string[] = [];

      for (const relPath of files.slice(0, MAX_FILES)) {
        const absPath = path.isAbsolute(relPath)
          ? relPath
          : path.join(ctx.cwd, relPath);

        try {
          const stat = fs.statSync(absPath);
          if (!stat.isFile()) {
            errors.push(`Not a file: ${relPath}`);
            continue;
          }

          let content = fs.readFileSync(absPath, "utf-8");

          if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
            const lines = content.split("\n");
            let kept = "";
            let bytes = 0;
            for (const line of lines) {
              const lb = Buffer.byteLength(line + "\n", "utf-8");
              if (bytes + lb > MAX_FILE_BYTES) break;
              kept += line + "\n";
              bytes += lb;
            }
            content = kept + `\n... [truncated — file exceeds ${MAX_FILE_BYTES / 1024} KB] ...`;
          }

          fileSections.push(`### File: ${relPath}\n\`\`\`\n${content}\n\`\`\``);
        } catch (err: any) {
          errors.push(`Cannot read ${relPath}: ${err.message}`);
        }
      }

      if (fileSections.length === 0) {
        return {
          content: [{ type: "text", text: `Error reading files:\n${errors.join("\n")}` }],
          details: {},
        };
      }

      // --- Build prompt ---
      const userMessage =
        `Question: ${task}\n\n` +
        fileSections.join("\n\n") +
        (errors.length > 0 ? `\n\n(Some files could not be read: ${errors.join("; ")})` : "");

      // --- Call Ollama with timeout ---
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const combinedSignal = (signal && (AbortSignal as any).any)
        ? (AbortSignal as any).any([signal as AbortSignal, controller.signal])
        : controller.signal;

      try {
        const response = await fetch(`${config.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            stream: false,
            options: { temperature: 0.1 },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage },
            ],
          }),
          signal: combinedSignal,
        });

        if (!response.ok) {
          const errText = await response.text();
          return {
            content: [{ type: "text", text: `Ollama error ${response.status}: ${errText.slice(0, 200)}` }],
            details: {},
          };
        }

        const json = (await response.json()) as {
          message?: { content?: string };
          error?: string;
        };

        if (json.error) {
          return {
            content: [{ type: "text", text: `Ollama error: ${json.error}` }],
            details: {},
          };
        }

        let answer = json.message?.content?.trim() ?? "(no response)";
        answer = answer.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

        return {
          content: [{ type: "text", text: `Q: ${task}\n\n${answer}` }],
          details: { model: config.model, filesAnalyzed: fileSections.length },
        };
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return {
            content: [{ type: "text", text: "worker_delegate: request aborted." }],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: `worker_delegate failed: ${err.message}` }],
          details: {},
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}