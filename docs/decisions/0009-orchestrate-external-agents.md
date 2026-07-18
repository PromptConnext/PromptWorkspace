# ADR 0009 — PromptConnext orchestrates external coding agents; it does not ship its own coding-agent runtime

**Date:** 2026-07-05 · **Status:** Accepted. Supersedes the implementation direction of ADR 0005/0006 (which remain as the fallback + façade). Prompted by the question: *since we're building a VS Code–like app, do we still need our own AI agent runtime?*

## Decision
**No.** Developers already work through their preferred coding agents (Claude Code, Codex CLI, Gemini CLI, …) with their own accounts. PromptConnext's durable value is the **workspace + 3S process + project context + AI routing + collaboration + the transparency graph** — not a coding agent. So implementation is **BYO-agent**, exactly as the model is **BYO-model**.

This *simplifies*: the planned homegrown multi-turn tool loop (ADR 0005's "upgrade path") is **cancelled** — external agents are that loop, done better.

## Two runtimes, treated differently
- **Planning generator** (`runStage` in `agent/loop.ts`, for constitution/specify/plan/tasks) — a thin single-shot template-filler over the BYO model gateway. *Not* a coding agent. **Kept** (business persona, cheap/local models, no CLI dependency).
- **Implementation** — **primary path is external-agent orchestration**; the one-shot `runImplementation` is demoted to a thin fallback for users with no agent CLI (ADR 0005).

## How it works
- **Adapter registry** (`agent/adapters/`): `claude-code` (routed to the BYO model via the Anthropic façade, ADR 0006), `gemini` (own Google account; headless `-p` + `--approval-mode auto_edit`), `codex` (own OpenAI account; `codex exec --full-auto`, experimental), `custom` (`PROMPTCONNEXT_AGENT_CMD`). Each adapter: `detect()`, `buildSpawn()`, `parseLine()`, and `bringsOwnModel`.
- **Agent-agnostic result capture** is the key enabler: the runner reads changed files from Git and commits them; `syncTasksFromGit` marks tasks done from commit refs. Any agent that works in the repo and produces a commit is captured — no deep per-agent integration. This is why adapters stay ~30 lines.
- **Routing:** a task runs on the project's chosen agent (`GET /engine/agents`, `implementation_agent.<projectId>`). Agents that bring their own model need **no** PromptConnext `code` connection; only the one-shot fallback and façade-routed Claude Code do.
- **Two developer paths, same graph:** the orchestrated Run button, or the developer running any agent themselves in the integrated terminal — both captured via Git.

## Spec Kit fidelity
3S (Scope/Spec/Skill) is the user-facing vision; underneath, the process follows Spec Kit faithfully: **constitution → specify → plan → tasks → implement**. The missing **constitution** step is now added (project principles that steer specify/plan/tasks), written to `.specify/memory/constitution.md`.

## Consequences
- Model-capability limits stop being PromptConnext's problem for implementation: the dev's own agent brings its own capable model (resolves the qwen-7B-can't-tool-call finding).
- Codex/Gemini adapters use the developer's own auth — no ToS grey area from proxying (unlike the Claude-Code-on-BYO-model path, which stays optional).
- Verified headless: `/engine/agents` detects claude/gemini/custom; a task ran via the custom agent with no code model connected → done, artifact + commit captured, `agent_run.model_connection_id` null. Codex adapter is unverified against a live install (marked experimental).

## Live Gemini hardening (2026-07-05, real `gemini` CLI)
Running the Gemini adapter for real surfaced three issues, two fixed:
1. **Untrusted-folder refusal (fixed):** headless Gemini exits 55 and silently downgrades `--approval-mode` to `default` (writes nothing) unless the workspace is trusted. The adapter now sets `GEMINI_CLI_TRUST_WORKSPACE=true` — correct because PromptConnext owns the project dir. With it, Gemini writes files (verified: created `hello.txt`, `wc.js`).
2. **No incremental output (fixed):** Gemini's default text output only prints a summary at the very end — a long run looked hung. Switched to `--output-format stream-json`; the adapter parses `init/message/tool_use/tool_result/result` events into live progress (verified against captured real events → `[write_file]`, `[list_directory]`, …).
3. **Latency (inherent):** Gemini can take minutes to first action, worsened by transient upstream 503s ("high demand"). The 10-min runner timeout accommodates it; stream-json now keeps the UI alive meanwhile. Not a PromptConnext bug.
`auto_edit` correctly blocks `run_shell_command` (file tools only); Gemini adapts and writes via its edit tool. Shell needs the Bash opt-in (yolo).

**Error handling verified:** the full engine→Gemini→commit chain was attempted live; Gemini exited code 1 on a Google **API rate limit** (free-tier, plus transient 503s). The runner caught the non-zero exit and surfaced a clear SSE error (`Gemini CLI exited with code 1: …rate-limit…`) + marked the task failed — no silent stall. So each link is independently proven — Gemini writes files with our flags/env; the runner captures+commits+marks-done (custom agent); the runner surfaces agent errors — but a single **happy-path** engine→Gemini→committed-code run is still unobserved end-to-end, blocked only by the account rate limit, not by our code. Re-run when quota resets (or with Claude Code / a paid agent).
