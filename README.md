# PromptConnext

AI-native development workspace: the **3S flow** (Scope → Spec → Skill) over a BYO-model orchestration engine, with a traceable task graph. See `docs/` for the product roadmap and platform architecture; `docs/decisions/` for ADRs.

This is the **walking skeleton**: launch → onboarding gate (connect + health-check one model) → create project → Scope generates a spec → approve → Spec generates a plan → approve → Skill prompts for a coding model. Everything runs locally; keys live in the macOS keychain.

## Layout

- `apps/desktop` — Tauri 2 shell + React webview. Spawns the engine as a sidecar.
- `apps/engine` — Node 24/TypeScript local engine (Hono + `node:sqlite`) on `127.0.0.1:47131`. Runs TS natively, no build step.

## Run (dev)

Prereqs: Node ≥ 24, pnpm, Rust (for the shell).

```sh
pnpm install
pnpm desktop        # full app: Tauri window + vite + engine sidecar
# or engine alone:
pnpm engine
```

A zero-cost first model: install [Ollama](https://ollama.com), `ollama pull qwen3:8b`, then pick "Local Ollama" in onboarding.

## Implementation is BYO-agent (ADR 0009)

PromptConnext doesn't ship its own coding-agent runtime — it **orchestrates the agent you already use**, exactly as it orchestrates the model you already pay for. Pick a coding agent per project in the Skill stage:

- **Claude Code** — routed to your connected BYO model via the engine's Anthropic-compat façade (`/anthropic/v1/messages`).
- **Gemini CLI / Codex CLI** — run on the developer's own account/model; PromptConnext provides the workspace, task, and context.
- **Custom** — any CLI via `PROMPTCONNEXT_AGENT_CMD` (task text in `$TASK_PROMPT`).
- **Fallback** — if no agent CLI is installed, the built-in one-shot generator runs on a connected coding model.

Result capture is **agent-agnostic**: whatever the agent (or you, in the integrated terminal) commits is read back from Git — a commit mentioning a task ref (`T003: …`) marks that task done. Adapters live in `apps/engine/src/agent/adapters/`.

Under the hood the process follows Spec Kit faithfully — **constitution → specify → plan → tasks → implement** — presented as the 3S vision (Scope/Spec/Skill).
