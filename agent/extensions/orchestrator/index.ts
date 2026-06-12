import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupInterceptor, createState, type OrchestratorState } from "./interceptor.js";
import { getWorkerContextBudget, invalidateBudgetCache } from "./summarizer.js";
import * as cache from "./cache.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptTemplate = readFileSync(join(__dirname, "prompts", "orchestrator.prompt.md"), "utf8");

const STATUS_KEY = "orchestrator";

// Default worker: local Ollama. User can override with /orchestrator worker <model> [baseUrl]
const DEFAULT_WORKER_MODEL = "qwen3-coder:30b";
const DEFAULT_WORKER_BASE_URL = "http://localhost:11434";

// Saved state across the extension lifecycle
let state: OrchestratorState;

export default function (pi: ExtensionAPI) {
  state = createState({ model: DEFAULT_WORKER_MODEL, baseUrl: DEFAULT_WORKER_BASE_URL });
  setupInterceptor(pi, state);

  // Keep edit review status current across sessions
  pi.on("agent_start", (_event: any, ctx: any) => {
    updateEditModeStatus(ctx);
  });

  // Inject orchestrator guidance into the system prompt on every agent turn when enabled
  pi.on("before_agent_start", (event, _ctx) => {
    if (!state.enabled) return;
    const guidance = "\n" + promptTemplate.replace("{{workerModel}}", state.workerConfig.model);
    return { systemPrompt: (event as any).systemPrompt + guidance };
  });

  // Clear cache and reset counters on new session
  pi.on("session_start", (_event, _ctx) => {
    cache.clear();
    state.interceptedCount = 0;
    state.savedBytesEstimate = 0;
    state.goalContext = undefined;
  });

  // Auto-compact when Sonnet's context exceeds 60% (keep brain lean)
  pi.on("turn_end", async (_event, ctx) => {
    if (!state.enabled) return;
    const usage = (ctx as any).getContextUsage?.();
    if (usage?.percent && usage.percent > 60) {
      await (ctx as any).compact?.({
        customInstructions:
          "Summarize the work done so far in under 500 words: files modified, key decisions, what remains to do.",
      });
    }
  });

  // /orchestrator command
  pi.registerCommand("orchestrator", {
    description:
      "Manage orchestrator mode (brain=Sonnet, hands=local worker LLM). " +
      "Usage: /orchestrator [on|off|status|debug [on|off]|worker <model> [baseUrl]]",

    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? "";

      // --- on ---
      if (sub === "on" || (sub === "" && !state.enabled)) {
        await enableOrchestrator(ctx);
        return;
      }

      // --- off ---
      if (sub === "off" || (sub === "" && state.enabled)) {
        disableOrchestrator(ctx);
        return;
      }

      // --- status ---
      if (sub === "status") {
        const budgetBytes = await getWorkerContextBudget(state.workerConfig).catch(() => null);
        const budgetKB = budgetBytes != null ? `${Math.round(budgetBytes / 1024)}KB` : "unknown";
        ctx.ui.notify(
          [
            `Orchestrator: ${state.enabled ? "ON" : "OFF"}`,
            `Edit mode: ${state.autoAccept ? "auto-accept" : "review (Ctrl+Shift+A to toggle)"}`,
            `Worker model: ${state.workerConfig.model} @ ${state.workerConfig.baseUrl}`,
            `Worker context budget: ~${budgetKB}`,
            `Worker status: ${state.workerStatus}`,
            `Intercepted: ${state.interceptedCount} tool results`,
            `Estimated token savings: ~${Math.round(state.savedBytesEstimate / 4 / 1000)}k tokens`,
          ].join("\n"),
          "info"
        );
        return;
      }

      // --- debug [on|off] ---
      if (sub === "debug") {
        const toggle = parts[1]?.toLowerCase();
        if (toggle === "off" || (toggle === undefined && state.debug)) {
          state.debug = false;
          state.debugLog = [];
          ctx.ui.setWidget("orchestrator-debug", [], { placement: "aboveEditor" });
          ctx.ui.notify("Orchestrator debug OFF", "info");
        } else {
          state.debug = true;
          state.debugLog = [];
          ctx.ui.notify(
            "Orchestrator debug ON\n" +
            "Every worker call will be shown above the editor:\n" +
            "  trigger | question sent | raw→summary size | duration | result preview",
            "info"
          );
        }
        return;
      }

      // --- log [N] — print last N debug entries as text ---
      if (sub === "log") {
        const n = parseInt(parts[1] ?? "10", 10);
        if (state.debugLog.length === 0) {
          ctx.ui.notify("No debug entries yet. Run /orchestrator debug on first.", "info");
          return;
        }
        const entries = state.debugLog.slice(-n);
        const lines: string[] = [`Last ${entries.length} worker calls:`];
        for (const e of entries) {
          const tag = e.kind === "worker_delegate" ? "DELEGATE" : e.passedThrough ? "SKIP" : e.fromCache ? "CACHE" : "CALL";
          lines.push(`#${e.seq} ${tag}  ${e.trigger}`);
          if (e.fullArgs) lines.push(`       args: ${e.fullArgs}`);
          if (e.question) lines.push(`       Q: ${e.question}`);
          if (e.goalContext) lines.push(`       ctx: ${e.goalContext}`);
          if (e.passthroughReason) lines.push(`       reason: ${e.passthroughReason}`);
          if (e.rawBytes) lines.push(`       raw: ${Math.round(e.rawBytes / 1024)}KB → summary: ${Math.round(e.summaryBytes / 1024)}KB`);
          if (e.durationMs != null) lines.push(`       duration: ${e.durationMs}ms`);
          if (e.summary) lines.push(`       response:\n${e.summary}`);
          if (e.error) lines.push(`       error: ${e.error}`);
          lines.push("");
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // --- worker <model> [baseUrl] ---
      if (sub === "worker") {
        const model = parts[1];
        const baseUrl = parts[2] ?? DEFAULT_WORKER_BASE_URL;
        if (!model) {
          ctx.ui.notify(
            `Current worker: ${state.workerConfig.model} @ ${state.workerConfig.baseUrl}\n` +
            `Usage: /orchestrator worker <model-name> [http://host:port]`,
            "info"
          );
          return;
        }
        invalidateBudgetCache(state.workerConfig.model);
        state.workerConfig = { model, baseUrl };
        // Sync to shared globalThis config so worker_delegate picks up the new model too
        (globalThis as any).__piWorkerConfig = { model, baseUrl };
        cache.clear();
        ctx.ui.notify(`Worker set to: ${model} @ ${baseUrl}`, "info");

        // Probe the new model's context window and report it
        getWorkerContextBudget(state.workerConfig).then((budget) => {
          ctx.ui.notify(
            `Worker context budget: ~${Math.round(budget / 1024)}KB (from Ollama)`,
            "info"
          );
        }).catch(() => {
          ctx.ui.notify(`Could not probe context window for ${model} — using default`, "warning");
        });
        return;
      }

      ctx.ui.notify(
        "Usage: /orchestrator [on|off|status|worker <model> [baseUrl]]",
        "info"
      );
    },

    getArgumentCompletions: (prefix) => {
      return ["on", "off", "status", "debug", "log", "worker"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ label: v, value: v }));
    },
  });

  // Ctrl+Shift+O: quick toggle orchestrator on/off
  pi.registerShortcut("ctrl+shift+o", {
    description: "Toggle orchestrator mode",
    handler: async (ctx) => {
      if (state.enabled) {
        disableOrchestrator(ctx);
      } else {
        await enableOrchestrator(ctx);
      }
    },
  });

}

function updateEditModeStatus(ctx: any) {
  if (state.enabled) ctx.ui.setStatus(STATUS_KEY, "brain [on]");
}

async function enableOrchestrator(ctx: any) {
  state.enabled = true;
  cache.clear();
  state.interceptedCount = 0;
  state.savedBytesEstimate = 0;
  state.workerStatus = "online";
  // Sync worker config to shared globalThis so worker_delegate uses the same model
  (globalThis as any).__piWorkerConfig = { ...state.workerConfig };
  updateEditModeStatus(ctx);

  // Probe worker model availability and report context window
  getWorkerContextBudget(state.workerConfig).then((budget) => {
    ctx.ui.notify(
      `Orchestrator ON\n` +
      `Worker: ${state.workerConfig.model} @ ${state.workerConfig.baseUrl}\n` +
      `Context budget: ~${Math.round(budget / 1024)}KB (from Ollama)`,
      "info"
    );
  }).catch(() => {
    ctx.ui.notify(
      `Orchestrator ON (worker model probe failed — is Ollama running?)\n` +
      `Worker: ${state.workerConfig.model}`,
      "warning"
    );
  });
}

function disableOrchestrator(ctx: any) {
  state.enabled = false;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.notify(
    `Orchestrator OFF\n` +
    `Intercepted: ${state.interceptedCount} tool results\n` +
    `Estimated savings: ~${Math.round(state.savedBytesEstimate / 4 / 1000)}k tokens`,
    "info"
  );
}
