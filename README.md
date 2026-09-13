# PromptConnext

AI-native development workspace: the **3S flow** (Scope → Spec → Skill) over a BYO-model orchestration engine, with a traceable task graph. See `docs/` for the product roadmap and platform architecture; `docs/decisions/` for ADRs.

The core loop runs end to end: launch → onboarding gate (connect + health-check one model) → sign in to a cloud workspace → create project → Scope generates a spec → approve → Spec generates a plan → approve → Skill hands tasks to your coding agent. Compute, keys, and code stay on your machine; credentials live in the OS keychain (macOS `security`, Windows DPAPI), never in SQLite or config.

## Layout

pnpm workspace (`apps/*`) plus one Python app. No monorepo build tool — the apps are independent.

- `apps/engine` — Node 24 / TypeScript local engine (Hono, `node:sqlite`, `node-pty`) on `127.0.0.1:47131`. Owns the BYO-model gateway, the Anthropic-compat façade, external-agent orchestration, the local task graph (a cache of the cloud's, per ADR 0020), and cloud sync. Runs TS natively — **no build step**. Tests: `node --test test/*.test.ts`.
- `apps/desktop` — Tauri 2 (Rust) shell + React 18 / Vite webview. The shipping app window; spawns the engine as a sidecar, mints the engine's per-session bearer token, and hosts the 3S flow, Monaco editor, file tree, and PTY terminal.
- `apps/desktop-theia` — Eclipse Theia + Electron shell (ADR 0016), at plumbing parity with `apps/desktop` and running the same engine sidecar. Ships alongside the Tauri shell until the ADR's M4 cutover; **`apps/desktop` is the one you run today**.
- `apps/cloud` — FastAPI (Python ≥ 3.10) + Supabase/Postgres. **Optional** sync + collaboration backend: workspaces and membership, task-graph sync, the web Planner's stage generator (managed Typhoon), the RAG assistant, presence, and tracker integrations. Credentials never sync; source code never syncs (that's Git).
- `apps/web` — Next.js 16 App Router / React 19. Team-member web UI against `apps/cloud`: Planner (authoring — PRD upload, stage generation, project creation), Graph, Tasks, Progress, Discussion. No Next API routes.
- `apps/corp` — Next.js 16 / React 19 / `next-intl` (EN/TH) / Tailwind v4. Public marketing site and the desktop **download page**. Static, SEO-first, unauthenticated — talks to no engine and no cloud API.
- `apps/vscode` — VS Code extension (ADR 0019), bundled with esbuild. The developer surface for cloud-planned work: assigned tasks, the project's AI coding rules read from the clone, copy-task-context for any assistant, and task status closed from a commit. Talks straight to `apps/cloud` — **no sidecar, no engine, no local server**. Tests: `node --test test/unit/*.test.ts`.

> **Retirement accepted, 2026-09-13.** [ADR 0019](docs/decisions/0019-desktop-as-vscode-extension.md) is now
> Accepted: `apps/desktop` and `apps/desktop-theia` are being retired in favour of `apps/vscode` plus an MCP
> server. Both still build while the deletion is sequenced — see
> [plan 0011](docs/plans/0011-desktop-decision-gate.md) — but neither is the product direction any more.

## Run (dev)

Prereqs: Node ≥ 24, pnpm, Rust (for the Tauri shell), Python ≥ 3.10 (only for `apps/cloud`).

```sh
pnpm install
pnpm desktop        # full app: Tauri window + vite + engine sidecar (first run compiles Rust)
pnpm engine         # engine alone on 127.0.0.1:47131 (tokenless dev mode)
pnpm web            # team web UI      → http://localhost:3000
pnpm corp           # marketing + download → http://localhost:3002
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

`apps/cloud` → Railway or any container host (**not** Vercel — long-lived container, WebSocket presence, single instance). `apps/web` and `apps/corp` → Vercel, separate projects. `apps/desktop` → installers built per-platform in CI (macOS arm64 + Windows x64) and published to R2; packaging is host-platform-bound because the build machine's own Node binary is bundled. Details in `docs/DEPLOYMENT.md` and `docs/BUILD_AND_DISTRIBUTE.md`.

## Implementation is BYO-agent (ADR 0009)

PromptConnext doesn't ship its own coding-agent runtime — it **orchestrates the agent you already use**, exactly as it orchestrates the model you already pay for. Pick a coding agent per project in the Skill stage:

- **Claude Code** — routed to your connected BYO model via the engine's Anthropic-compat façade (`/anthropic/v1/messages`).
- **Gemini CLI / Codex CLI** — run on the developer's own account/model; PromptConnext provides the workspace, task, and context.
- **Custom** — any CLI via `PROMPTCONNEXT_AGENT_CMD` (task text in `$TASK_PROMPT`).
- **Fallback** — if no agent CLI is installed, the built-in one-shot generator runs on a connected coding model.

Result capture is **agent-agnostic**: whatever the agent (or you, in the integrated terminal) commits is read back from Git — a commit mentioning a task ref (`T003: …`) marks that task done. Adapters live in `apps/engine/src/agent/adapters/`.

Under the hood the process follows Spec Kit faithfully — **constitution → specify → plan → tasks → implement** — presented as the 3S vision (Scope/Spec/Skill).
