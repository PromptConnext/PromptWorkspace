# PromptConnext

AI-native development workspace: the **3S flow** (Scope → Spec → Skill) over a BYO-model orchestration engine, with a traceable task graph. `docs/decisions/` has the ADRs. For product framing, use [`docs/product-vision-2026-09-12.md`](docs/product-vision-2026-09-12.md), not `promptzone-product-roadmap.md` or `promptzone-platform-architecture.md` — both are superseded and describe the two-persona desktop product ADRs 0019/0020 retired.

The primary loop today runs in the cloud: sign in to a workspace at `apps/web` → create a project → the Planner's Scope stage generates a spec → approve → Spec generates a plan → approve → Skill hands tasks to a developer working in `apps/vscode`, who commits against a task reference. The original desktop-first loop still runs (`apps/desktop`: launch → onboarding gate that connects/health-checks one model → sign in → create project → same Scope/Spec/Skill stages, generated locally) but is being retired — see the Layout notice below. Compute, keys, and code stay on your machine when you run the desktop or engine path; credentials live in the OS keychain (macOS `security`, Windows DPAPI), never in SQLite or config.

## Layout

pnpm workspace (`apps/*`) plus one Python app. No monorepo build tool — the apps are independent.

- `apps/engine` — Node 24 / TypeScript local engine (Hono, `node:sqlite`, `node-pty`) on `127.0.0.1:47131`. Owns the BYO-model gateway, the Anthropic-compat façade, external-agent orchestration, the local task graph (a cache of the cloud's, per ADR 0020), and cloud sync. Runs TS natively — **no build step**. Tests: `node --test test/*.test.ts`.
- `apps/desktop` — Tauri 2 (Rust) shell + React 18 / Vite webview. Spawns the engine as a sidecar, mints the engine's per-session bearer token, and hosts the 3S flow, Monaco editor, file tree, and PTY terminal. Still builds, but frozen since 2026-08-13 and being retired (see the notice below) — don't extend it.
- `apps/desktop-theia` — Eclipse Theia + Electron shell (ADR 0016), at plumbing parity with `apps/desktop` and running the same engine sidecar. Also frozen and being retired; the planned M4 cutover to this shell is cancelled, not pending.
- `apps/cloud` — FastAPI (Python ≥ 3.10) + Supabase/Postgres. **Optional** sync + collaboration backend: workspaces and membership, task-graph sync, the web Planner's stage generator (managed Typhoon), the RAG assistant, presence, and tracker integrations. Credentials never sync; source code never syncs (that's Git).
- `apps/web` — Next.js 16 App Router / React 19. Team-member web UI against `apps/cloud`: Planner (authoring — PRD upload, stage generation, project creation), Graph, Tasks, Progress, Discussion. No Next API routes.
- `apps/vscode` — VS Code extension (ADR 0019), bundled with esbuild. The developer surface for cloud-planned work: assigned tasks, the project's AI coding rules read from the clone, copy-task-context for any assistant, and task status closed from a commit. Talks straight to `apps/cloud` — **no sidecar, no engine, no local server**. Tests: `node --test test/unit/*.test.ts`.

> **Retirement accepted, 2026-09-13.** [ADR 0019](docs/decisions/0019-desktop-as-vscode-extension.md) and
> [ADR 0020](docs/decisions/0020-cloud-is-the-source-of-truth.md) are now Accepted: the cloud is
> authoritative for the task graph, and `apps/desktop` and `apps/desktop-theia` are being retired in favour
> of `apps/vscode` plus an MCP server (not yet built — [plan 0025](docs/plans/0025-mcp-server.md)). Both
> shells still build while deletion is sequenced — see [plan 0011](docs/plans/0011-desktop-decision-gate.md)
> — but neither is the product direction any more. The engine's interval graph-clobber push has been
> disabled ([plan 0012](docs/plans/0012-close-the-write-path.md) M1), but the rest of that plan — aligning
> the two task-status vocabularies, the pull-loop inversion, git-truth status writes — is still open, so
> the engine's local graph is not yet a clean read-only cache of the cloud's.

## Run (dev)

Prereqs: Node ≥ 24, pnpm, Rust (for the Tauri shell), Python ≥ 3.10 (only for `apps/cloud`).

```sh
pnpm install
pnpm desktop        # full app: Tauri window + vite + engine sidecar (first run compiles Rust)
pnpm engine         # engine alone on 127.0.0.1:47131 (tokenless dev mode)
pnpm web            # team web UI      → http://localhost:3000
pnpm vscode         # extension: esbuild watch, then press F5 in apps/vscode
```

Browser-only UI iteration, no Rust compile: `pnpm engine` in one terminal, `pnpm --dir apps/desktop dev` (Vite on `:1420`) in another.

Cloud backend, optional — the engine defaults to the hosted instance:

```sh
cd apps/cloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --env-file .env.local --reload --port 8080

# Unit Test
cd apps/cloud
python -m venv .venv && source .venv/bin/activate
pytest && ruff check .
```

Point the engine at it with `CLOUD_API_URL=http://localhost:8080`, or disable sync entirely with `CLOUD_API_URL=""`.

A zero-cost first model: install [Ollama](https://ollama.com), `ollama pull qwen3:0.6b`, then pick "Local Ollama" in onboarding.

## Deploy

`apps/cloud` → Railway or any container host (**not** Vercel — long-lived container, WebSocket presence, single instance). `apps/web` → Vercel. The marketing site lives in [`PromptConnext/promptconnext-corp-web`](https://github.com/PromptConnext/promptconnext-corp-web) (also Vercel). `apps/desktop` → installers still built per-platform in CI (macOS arm64 + Windows x64) and published to R2, unsigned on macOS; packaging is host-platform-bound because the build machine's own Node binary is bundled. This pipeline is frozen product, not a maintained release channel — see the retirement notice above. Details in `docs/DEPLOYMENT.md` and `docs/BUILD_AND_DISTRIBUTE.md`.

## Implementation is BYO-agent (ADR 0009)

This section describes the **engine/desktop** implementation path. `apps/vscode` doesn't orchestrate an agent CLI at all — per ADR 0022 it hands the developer the task's context to paste into whatever assistant they already run in the editor, and closes the task when their commit reaches the remote. Whether that gap gets closed is one of the open questions in the product vision doc.

PromptConnext doesn't ship its own coding-agent runtime — it **orchestrates the agent you already use**, exactly as it orchestrates the model you already pay for. Pick a coding agent per project in the Skill stage:

- **Claude Code** — routed to your connected BYO model via the engine's Anthropic-compat façade (`/anthropic/v1/messages`).
- **Gemini CLI / Codex CLI** — run on the developer's own account/model; PromptConnext provides the workspace, task, and context.
- **Custom** — any CLI via `PROMPTCONNEXT_AGENT_CMD` (task text in `$TASK_PROMPT`).
- **Fallback** — if no agent CLI is installed, the built-in one-shot generator runs on a connected coding model.

Result capture is **agent-agnostic**: whatever the agent (or you, in the integrated terminal) commits is read back from Git — a commit mentioning a task ref (`T003: …`) marks that task done. Adapters live in `apps/engine/src/agent/adapters/`.

Under the hood the process follows Spec Kit faithfully — **constitution → specify → plan → tasks → implement** — presented as the 3S vision (Scope/Spec/Skill).
