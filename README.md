# pi-delegate

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that enforces context discipline: the brain (Sonnet) **never reads source files for comprehension**. All code understanding is delegated to a local worker LLM via focused single-question calls. The brain only reads files immediately before editing them.

## The Problem It Solves

In a standard coding session, Sonnet reads large source files to understand them — pulling thousands of tokens of raw Java/TypeScript into its context. This is wasteful: most of that content is irrelevant to the task, and it fills up the context window quickly.

The naive fix (silently summarizing reads) makes things worse — Sonnet doesn't know it's getting summaries, gets confused when it needs exact content for edits, and wastes turns on workarounds.

This extension takes a different approach: **make the constraint explicit and enforce it at the tool level**.

- Files over 200 lines are blocked from direct reads with a clear message
- Sonnet is guided to ask the worker one focused factual question per call
- The worker (local Ollama model) reads the file and answers precisely
- Sonnet only reads a file raw when it's about to edit it (second read of same file = edit intent)

## Architecture

```
User message
    │
    ▼
Sonnet (brain) ─── worker_delegate("What condition checks if policy is inflight?", ["PlanService.java"])
    │                       │
    │                       ▼
    │               qwen3-coder:30b (worker)
    │               reads file, answers question
    │               returns: "The condition checks requestId != null && gaId == null"
    │
    ▼
Sonnet plans edit, calls read(PlanService.java) → blocked (342 lines)
Sonnet calls read(PlanService.java) again → passes through (edit intent)
Sonnet calls edit(PlanService.java, ...)
```

## Prerequisites

- [pi coding agent](https://github.com/badlogic/pi-mono) installed
- [Ollama](https://ollama.com) running locally
- A local model pulled (default: `qwen3-coder:30b`)

### Install pi

```bash
npm install -g @mariozechner/pi-coding-agent
```

### Configure your Anthropic API key

Create `~/.pi/agent/auth.json`:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "sk-ant-..."
  }
}
```

Get your key from [console.anthropic.com](https://console.anthropic.com).

### Install Ollama and pull the worker model

```bash
# Install Ollama from https://ollama.com
ollama pull qwen3-coder:30b
```

> You can use a smaller/faster model if needed — see [Switching models](#switching-models).

## Installation

Copy the extension files into pi's extensions directory:

```bash
# Clone this repo
git clone https://github.com/varenyamnikam/pi-delegate.git

# Copy to pi's extensions directory (auto-loaded on startup)
cp pi-delegate/worker-agent.ts ~/.pi/agent/extensions/
cp -r pi-delegate/orchestrator ~/.pi/agent/extensions/
```

Pi loads all `.ts` files from `~/.pi/agent/extensions/` automatically on startup.

## Usage

### Starting a session

```
pi                          # start pi in your project directory
/orchestrator on            # enable orchestrator mode
```

You'll see `brain [on]` in the status bar confirming the worker model is reachable.

### How Sonnet behaves in orchestrator mode

**Understanding code** — Sonnet asks the worker one focused question at a time:

```
worker_delegate
  task: "What condition in PlanService.submitPlan checks if the parent policy is inflight?"
  files: ["src/main/java/com/example/PlanService.java"]

→ "The method checks requestId != null && gaId == null on the parent policy object,
   treating this as the inflight state."
```

**Reading for edits** — blocked on first attempt, passes through on second:

```
read(PlanService.java)
→ [Orchestrator] PlanService.java has 342 lines — too large for a comprehension read.
   For understanding: use worker_delegate with a focused question.
   To read before an edit: call read again — the next read of this file will pass through.

read(PlanService.java)   ← second read, passes through raw
→ [full file content]

edit(PlanService.java, ...)
```

### Commands

| Command | Description |
|---|---|
| `/orchestrator on` | Enable orchestrator mode |
| `/orchestrator off` | Disable, shows session summary |
| `/orchestrator status` | Worker model, context budget, call count |
| `/orchestrator debug on` | Show live widget with every worker_delegate call |
| `/orchestrator debug off` | Hide widget |
| `/orchestrator log [N]` | Print last N worker_delegate calls with Q&A |
| `/orchestrator worker <model>` | Switch worker model (e.g. `qwen3-coder:7b`) |
| `/orchestrator worker <model> <url>` | Switch model + custom Ollama base URL |
| `Ctrl+Shift+O` | Toggle orchestrator mode |

### Switching models

```
/orchestrator worker qwen3-coder:7b
/orchestrator worker llama3.1:8b
/orchestrator worker deepseek-coder:6.7b http://remote-host:11434
```

The worker model change applies to both automatic blocking and explicit `worker_delegate` calls immediately — no reload needed.

## How worker_delegate works

Sonnet calls `worker_delegate` with one precise question and 1–5 file paths. The worker reads the files locally (via `fs.readFileSync`) and answers in plain prose.

**Good questions (narrow, factual):**
- "What does the `validatePartner` method return and what does it throw?"
- "What fields does `PartnerRequest` have and what are their types?"
- "What BPM method does `PlanService.submit` call and what arguments does it pass?"

**Bad questions (broad, asks for code):**
- "Show me the complete implementation of submitPlan with code snippets" — use `read` instead
- "Explain everything about how auth works" — split into multiple focused calls

The worker cannot reproduce code accurately — it describes logic in plain language. For exact code, read the file.

## File structure

```
~/.pi/agent/extensions/
├── worker-agent.ts              # worker_delegate tool definition
└── orchestrator/
    ├── index.ts                 # /orchestrator command + system prompt injection
    ├── interceptor.ts           # read block enforcement (>200 lines) + debug widget
    ├── summarizer.ts            # Ollama API caller (used for context budget probe)
    └── cache.ts                 # LRU cache (retained for future use)
```

## Configuration

| Setting | Default | How to change |
|---|---|---|
| Worker model | `qwen3-coder:30b` | `/orchestrator worker <model>` |
| Ollama base URL | `http://localhost:11434` | `/orchestrator worker <model> <url>` |
| Large file threshold | 200 lines | Edit `LARGE_FILE_LINES` in `interceptor.ts` |

## Reload after changes

After editing any extension file:

```
/reload
```

Pi reloads all extensions without restarting the session.