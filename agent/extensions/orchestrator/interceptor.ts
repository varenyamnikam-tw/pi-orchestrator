import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { WorkerConfig } from "./summarizer.js";

export interface DebugEntry {
  seq: number;
  trigger: string;           // short label e.g. "read(auth.ts)"
  fullArgs: string;          // full JSON args passed to the tool / worker
  question: string;          // what was sent to worker (the summarizer question)
  rawBytes: number;
  summaryBytes: number;
  fromCache: boolean;
  passedThrough: boolean;
  passthroughReason?: string;
  summary?: string;          // worker's response
  goalContext?: string;
  durationMs?: number;
  error?: string;
  kind: "intercept" | "worker_delegate" | "skip";
}

export interface OrchestratorState {
  enabled: boolean;
  debug: boolean;
  interceptedCount: number;
  savedBytesEstimate: number;
  goalContext: string | undefined;
  lastAssistantMessage: string | undefined;
  workerStatus: "online" | "offline" | "missing" | "timeout";
  workerConfig: WorkerConfig;
  debugLog: DebugEntry[];
}

export function createState(workerConfig: WorkerConfig): OrchestratorState {
  return {
    enabled: false,
    debug: false,
    interceptedCount: 0,
    savedBytesEstimate: 0,
    goalContext: undefined,
    lastAssistantMessage: undefined,
    workerStatus: "online",
    workerConfig,
    debugLog: [],
  };
}

let _seq = 0;

const WIDGET_W = 72; // chars — stay within typical terminal width

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function pushDebugWidget(ctx: any, state: OrchestratorState) {
  if (!state.debug) return;
  const total = state.debugLog.length;
  const recent = state.debugLog.slice(-5);
  const lines: string[] = [`── Orchestrator debug (${total} calls, last 5) ──`];

  for (const e of recent) {
    const tag = e.kind === "worker_delegate" ? "DELEGATE"
              : e.passedThrough               ? "SKIP    "
              : e.fromCache                   ? "CACHE   "
              : e.error                       ? "ERR     "
              :                                 "CALL    ";

    // Header line: #seq TAG trigger timing
    const timing = e.durationMs != null ? `  ${e.durationMs}ms` : "";
    const ratio = (!e.passedThrough && !e.fromCache && e.rawBytes > 0)
      ? `  -${Math.round((1 - e.summaryBytes / e.rawBytes) * 100)}%`
      : "";
    lines.push(trunc(`  #${e.seq} ${tag} ${e.trigger}${timing}${ratio}`, WIDGET_W));

    // Args line — always shown (this is what was missing)
    if (e.fullArgs) lines.push(trunc(`         args: ${e.fullArgs}`, WIDGET_W));

    // Question sent to worker
    if (e.question && !e.passedThrough)
      lines.push(trunc(`         Q: ${e.question}`, WIDGET_W));

    // Goal context
    if (e.goalContext)
      lines.push(trunc(`         ctx: ${e.goalContext}`, WIDGET_W));

    // Pass-through reason
    if (e.passedThrough && e.passthroughReason)
      lines.push(trunc(`         reason: ${e.passthroughReason}`, WIDGET_W));

    // Worker response (first line)
    if (e.summary)
      lines.push(trunc(`         ↳ ${e.summary.split("\n")[0]}`, WIDGET_W));

    // Error
    if (e.error)
      lines.push(trunc(`         error: ${e.error}`, WIDGET_W));
  }

  ctx.ui.setWidget("orchestrator-debug", lines, { placement: "aboveEditor" });
}

const LARGE_FILE_LINES = 200; // lines — reads above this are blocked for comprehension

export function setupInterceptor(pi: ExtensionAPI, state: OrchestratorState) {
  // Per-turn read counts — reset on agent_start so second read = edit intent
  const turnReadCounts: Record<string, number> = {};

  pi.on("agent_start", (_event: any, _ctx: any) => {
    Object.keys(turnReadCounts).forEach(k => delete turnReadCounts[k]);
    state.lastAssistantMessage = undefined;
  });

  // Block large reads for comprehension; second read of same file passes through (edit intent)
  pi.on("tool_result", (event: any, _ctx: any): any => {
    if (!state.enabled) return;
    if (event.toolName !== "read") return;

    const filePath: string = event.input?.path ?? "";
    const rawText: string = (event.content as any[])
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text as string)
      .join("\n") ?? "";

    const lineCount = rawText.split("\n").length;
    if (lineCount <= LARGE_FILE_LINES) return;

    const count = (turnReadCounts[filePath] ?? 0) + 1;
    turnReadCounts[filePath] = count;

    if (count >= 2) return; // second read = edit intent, pass through raw

    return {
      content: [{
        type: "text",
        text: `[Orchestrator] ${filePath} has ${lineCount} lines — too large for a comprehension read.\n` +
              `For understanding: use worker_delegate with a focused question.\n` +
              `To read before an edit Or worker_delegate does'nt produce appropriate response even after multiple prompts: call read again — the next read of this file will pass through.`,
      }],
    };
  });

  // Track worker_delegate calls for debug widget
  const pendingDelegateCalls: Record<string, { seq: number; trigger: string; fullArgs: string; t0: number }> = {};

  pi.on("tool_execution_start", (event: any, _ctx: any) => {
    if (!state.debug) return;
    if ((event as any).toolName !== "worker_delegate") return;
    const input = ((event as any).input ?? {}) as Record<string, unknown>;
    const toolCallId: string = (event as any).toolCallId ?? String(++_seq);
    const files = (input.files as string[] ?? []).join(", ");
    pendingDelegateCalls[toolCallId] = {
      seq: ++_seq,
      trigger: `worker_delegate([${files}])`,
      fullArgs: JSON.stringify(input),
      t0: Date.now(),
    };
  });

  pi.on("tool_result", (event: any, ctx: any) => {
    if (!state.debug) return;
    if ((event as any).toolName !== "worker_delegate") return;
    const toolCallId: string = (event as any).toolCallId ?? "";
    const pending = pendingDelegateCalls[toolCallId];
    if (!pending) return;
    delete pendingDelegateCalls[toolCallId];
    const input = ((event as any).input ?? {}) as Record<string, unknown>;
    const resultText: string = ((event as any).content as any[])
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text as string)
      .join("\n") ?? "";
    state.debugLog.push({
      seq: pending.seq,
      trigger: pending.trigger,
      fullArgs: pending.fullArgs,
      question: (input.task as string) ?? "",
      rawBytes: 0,
      summaryBytes: resultText.length,
      fromCache: false,
      passedThrough: false,
      summary: resultText,
      goalContext: state.goalContext,
      durationMs: Date.now() - pending.t0,
      kind: "worker_delegate",
    });
    pushDebugWidget(ctx, state);
  });
}
