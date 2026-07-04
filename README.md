# PromptZone

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

## Implementation modes

Running a task uses one of two modes (ADR 0005/0006): if a coding-agent CLI is installed (Claude Code by default, any CLI via `PROMPTZONE_AGENT_CMD`), the engine spawns it headless in the project folder, pointed at the engine's Anthropic-compat façade (`/anthropic/v1/messages`) so it runs on your connected code-role model. Otherwise it falls back to one-shot codegen. Force a mode with the `implementation_mode` app state (`auto`/`agent`/`loop`).
