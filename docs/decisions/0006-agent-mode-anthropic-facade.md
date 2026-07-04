# ADR 0006 — Agent-mode implementation via an Anthropic-compat façade

**Date:** 2026-07-04 · **Status:** Accepted. Extends ADR 0005 (whose single-shot loop remains the fallback). Inspired by the free-claude-code pattern (github.com/Alishahryar1/free-claude-code), with the proxy folded into our engine.

## Decision
Instead of building a bespoke multi-turn tool loop, task implementation spawns a **real coding-agent CLI** headless in the project workspace:

- The engine exposes an **Anthropic Messages API façade** at `/anthropic/v1/messages` (`src/gateway/anthropic-compat.ts`): full request/response translation to the connected code-role model's OpenAI-compatible API — content blocks ↔ chat messages, `tool_use`/`tool_result` ↔ `tool_calls`/`tool` role, streaming SSE event synthesis (`message_start` → `content_block_*` → `message_stop`), plus `count_tokens` and `/v1/models`. Ollama is reached via its OpenAI-compatible `/v1` API so tools work uniformly.
- `POST /engine/tasks/{id}/run` picks a mode (`implementation_mode` app-state: `auto` default / `agent` / `loop`). In agent mode it spawns **Claude Code** (`claude -p … --output-format stream-json --permission-mode acceptEdits --allowedTools Edit,Write,Read,Glob,Grep,Bash`) in the project dir with `ANTHROPIC_BASE_URL` pointed at the façade, streams readable progress to the UI, then commits whatever changed and records Artifacts + the AgentRun. `PROMPTZONE_AGENT_CMD` substitutes any other agent (also how tests inject a fake agent).

## Why
The agent brings what ADR 0005 could not: it reads files on demand, iterates, and can run tests — while the model powering it stays BYO through our existing gateway and keychain.

## Terminal helper (local-LLM Claude Code, copy-paste)
The same façade powers the developer's own use: the integrated terminal has a **"Point Claude Code at your model"** disclosure that shows the exact exports — `ANTHROPIC_BASE_URL` (→ façade), `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_ATTRIBUTION_HEADER=0` (KV-cache guard from the local-LLM guides) — for the connected model, served by `GET /engine/local-llm-env`, with a Copy button. Developers paste them into the shell themselves (chosen over auto-injection: the audience is developers who know their shell, and it keeps their own Claude account the default). Our translation layer means Ollama's tool calls work where a raw `/v1/messages` pointing at Ollama would not.

## Caveats
- **ToS grey zone (roadmap risk #5):** `ANTHROPIC_BASE_URL` is a supported Claude Code config for gateways, but routing it to non-Anthropic models is not an endorsed use. Per-provider/Anthropic ToS review before this ships beyond local dev. An openly-licensed agent CLI (OpenCode/Codex CLI) is the drop-in alternative via `PROMPTZONE_AGENT_CMD`.
- Requires the agent CLI installed; `auto` mode falls back to the one-shot loop when absent.
- **Shell access is opt-in.** The BYO model steers the agent, so a hostile or compromised model endpoint plus an allowed `Bash` tool would equal arbitrary command execution. Default `--allowedTools` is file tools only (Edit/Write/Read/Glob/Grep); `PROMPTZONE_AGENT_ALLOW_BASH=1` re-enables Bash (needed for the agent to run tests) as an explicit user acceptance. Before distribution, replace the env toggle with a per-project setting plus a command allow/deny classifier via permission hooks, or run the agent in an OS-level sandbox.
- The façade's protocol translation is e2e-tested against a mock provider (text, tool_use, streaming event shape).

## Live dogfood findings (2026-07-04, Claude Code 2.1.201 → façade → Ollama)
- The spawned agent must run with an **isolated `CLAUDE_CONFIG_DIR`** — otherwise the user's global plugins leak extra tools into the system prompt and write state files (`.omc/…`) into the workspace, which defeated the "agent made no changes" guard and got committed as fake task output. Fixed: isolated config dir under app data, dot-directory paths excluded from change detection, and only detected files are committed.
- **Model capability floor (roadmap risk #4, now with data):** `qwen2.5-coder:7b` via Ollama passes Scope/Spec/Tasks but cannot emit structured `tool_calls` even for a single trivial tool — it prints the call as text — so it cannot drive agent mode. The planning roles tolerate small local models; the agent-mode `code` role needs a model with real function-calling. Follow-up: probe tool-calling capability in the code-role health check so users learn this at connect time, not mid-task.
