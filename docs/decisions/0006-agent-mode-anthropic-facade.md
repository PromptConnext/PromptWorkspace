# ADR 0006 — Agent-mode implementation via an Anthropic-compat façade

**Date:** 2026-07-04 · **Status:** Accepted. Extends ADR 0005 (whose single-shot loop remains the fallback). Inspired by the free-claude-code pattern (github.com/Alishahryar1/free-claude-code), with the proxy folded into our engine.

## Decision
Instead of building a bespoke multi-turn tool loop, task implementation spawns a **real coding-agent CLI** headless in the project workspace:

- The engine exposes an **Anthropic Messages API façade** at `/anthropic/v1/messages` (`src/gateway/anthropic-compat.ts`): full request/response translation to the connected code-role model's OpenAI-compatible API — content blocks ↔ chat messages, `tool_use`/`tool_result` ↔ `tool_calls`/`tool` role, streaming SSE event synthesis (`message_start` → `content_block_*` → `message_stop`), plus `count_tokens` and `/v1/models`. Ollama is reached via its OpenAI-compatible `/v1` API so tools work uniformly.
- `POST /engine/tasks/{id}/run` picks a mode (`implementation_mode` app-state: `auto` default / `agent` / `loop`). In agent mode it spawns **Claude Code** (`claude -p … --output-format stream-json --permission-mode acceptEdits --allowedTools Edit,Write,Read,Glob,Grep,Bash`) in the project dir with `ANTHROPIC_BASE_URL` pointed at the façade, streams readable progress to the UI, then commits whatever changed and records Artifacts + the AgentRun. `PROMPTZONE_AGENT_CMD` substitutes any other agent (also how tests inject a fake agent).

## Why
The agent brings what ADR 0005 could not: it reads files on demand, iterates, and can run tests — while the model powering it stays BYO through our existing gateway and keychain.

## Caveats
- **ToS grey zone (roadmap risk #5):** `ANTHROPIC_BASE_URL` is a supported Claude Code config for gateways, but routing it to non-Anthropic models is not an endorsed use. Per-provider/Anthropic ToS review before this ships beyond local dev. An openly-licensed agent CLI (OpenCode/Codex CLI) is the drop-in alternative via `PROMPTZONE_AGENT_CMD`.
- Requires the agent CLI installed; `auto` mode falls back to the one-shot loop when absent.
- **Shell access is opt-in.** The BYO model steers the agent, so a hostile or compromised model endpoint plus an allowed `Bash` tool would equal arbitrary command execution. Default `--allowedTools` is file tools only (Edit/Write/Read/Glob/Grep); `PROMPTZONE_AGENT_ALLOW_BASH=1` re-enables Bash (needed for the agent to run tests) as an explicit user acceptance. Before distribution, replace the env toggle with a per-project setting plus a command allow/deny classifier via permission hooks, or run the agent in an OS-level sandbox.
- Live validation with real Claude Code + a real model is pending dogfood; the façade's protocol translation is e2e-tested against a mock provider (text, tool_use, streaming event shape).
