# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

PromptZone is an **AI-native development workspace**: the **3S flow** (Scope → Spec → Skill) over a **BYO-model** orchestration engine, with a traceable task graph. Under the hood the process follows Spec Kit faithfully — **constitution → specify → plan → tasks → implement** — presented to users as 3S.

Two load-bearing decisions shape everything (see `docs/decisions/`):

- **Tauri shell + Node sidecar** (ADR 0001) — the desktop app is a thin Rust window; the engine runs locally as a spawned process.
- **BYO-agent / BYO-model** (ADR 0009) — PromptZone orchestrates the coding agent and model you already pay for (Claude Code, Gemini CLI, Codex CLI, Ollama, or any CLI via `PROMPTZONE_AGENT_CMD`); it ships no model runtime of its own. Compute, keys, and code stay on the user's machine.

## Layout

This is a **pnpm workspace** (`apps/*`) plus one Python app — no monorepo build tool. The four apps are independent.

| App | Stack | Purpose |
|---|---|---|
| `apps/desktop` | Tauri 2 (Rust) + React 18 / Vite webview | The app window; spawns the engine as a sidecar |
| `apps/engine` | Node 24 / TypeScript — Hono, `node:sqlite`, `node-pty` | Local engine on `127.0.0.1:47131`; runs TS natively, **no build step** |
| `apps/cloud` | FastAPI (Python ≥ 3.10) + Supabase/Postgres | **Optional** sync + collaboration backend (task-graph hub, RAG assistant) |
| `apps/web` | Next.js 16 App Router, React 19, TypeScript | Team-member web UI; read/collaborate against `apps/cloud` |

`apps/desktop` (React 18) and `apps/web` (React 19) share one pnpm store; `pnpm-workspace.yaml` pins each package's `@types/react` edge explicitly — don't remove those `packageExtensions`.

## Development commands

From the repo root:

```bash
pnpm install
pnpm desktop     # full app: Tauri window + engine sidecar + hot-reload UI (first run compiles Rust)
pnpm engine      # engine alone on 127.0.0.1:47131 (tokenless dev mode)
pnpm web         # apps/web on http://localhost:3000
```

Browser-only UI iteration (no Rust compile): run `pnpm engine` in one terminal and `pnpm --dir apps/desktop dev` (Vite on `:1420`) in another.

**Engine** (`apps/engine`) — Node ≥ 24 is a hard requirement (`node:sqlite`, native TS). No build, no test suite today.

**Cloud** (`apps/cloud`):

```bash
cd apps/cloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080     # in-memory backend, stub auth — no Supabase needed
pytest                                         # the only app with a test suite
ruff check .                                   # lint (line-length 100)
```

**Web** (`apps/web`): `next dev` / `next build` / `tsc --noEmit` (typecheck).

The cloud app is **optional** for desktop work: the engine defaults to the hosted Railway instance. Point it locally with `CLOUD_API_URL=http://localhost:8080`, or disable sync with `CLOUD_API_URL=""`.

## Architecture

### Engine (`apps/engine/src`)

Hono server bound to `127.0.0.1:47131` (`index.ts`). Routes are mounted flat: `models`, `onboarding`, `projects`, `files`, `agents`, `cloud`, plus the Anthropic façade at `/anthropic` and a terminal WebSocket.

- **`gateway/`** — the BYO-model gateway. `ModelConnection` is an **OpenAI-compatible** shape (`endpoint` + `/chat/completions`); `anthropic-compat.ts` is the Anthropic Messages façade (ADR 0006) that lets Claude Code speak to the connected BYO model.
- **`agent/`** — `loop.ts::runStage()` is the thin single-shot planning generator (constitution/specify/plan/tasks). `agent-runner.ts` + `adapters/` orchestrate external coding agents for **implementation**; each adapter (`claude-code`, `gemini`, `codex`, `custom`) is ~30 lines with `detect() / buildSpawn() / parseLine() / bringsOwnModel`. Result capture is **agent-agnostic** — changed files are read from Git and committed; a commit ref marks a task done.
- **`db.ts`** — local `node:sqlite` task graph, the **offline source of truth** (ADR 0003).
- **`keychain.ts`** — model credentials live in the OS keychain (macOS `security` CLI; Windows DPAPI via PowerShell), never in SQLite or config.
- **`security.ts`** — origin allowlist + per-session bearer token (ADR 0008). See Security below.
- **`cloudClient.ts` / `sync/loop.ts`** — authenticate to `apps/cloud` as the cloud user and push the local graph up on an interval (ADR 0010).

### Cloud (`apps/cloud/app`)

FastAPI entrypoint `main.py` (`uvicorn app.main:app --port 8080`). Routers in `api/`: `workspaces`, `sync`, `discussions`, `presence`, `assistant`, `integrations`, `github`, `health`. A `memory` data backend (stub auth via `X-User-Id`) needs no Supabase; `DATA_BACKEND=supabase` + `AUTH_MODE=supabase` enables real Postgres + JWT.

- **Task-graph sync** (`sync.py`, ADR 0010) — the cloud graph is a **projection** of the local SQLite schema. `PUT /sync/projects/{id}/graph` pushes a delta; `GET …?since=<cursor>` pulls. **Credentials never sync; source code never syncs** (that's Git). Push/pull is manual (Git-like); conflict policy is last-write-wins by `updated_at`.
- **RAG assistant** (`rag/`, `api/assistant.py`, ADR 0011) — grounded Q&A over synced artifacts, membership-scoped **before** similarity search. Uses a **workspace-connected BYO model** (`POST /workspaces/{id}/model-connection`); keys live in the server secret store (`secrets.py`), never in a Supabase row. Token budgets in `rag/budget.py`.
- **Presence** (`ws/manager.py`) — ephemeral who's-viewing roster over WebSocket. **In-memory, single-instance only**; no graph data flows over WS. Horizontal scale needs a shared backplane (Redis) first — flagged, not built.

### Web (`apps/web/src`)

Next.js App Router, **read/collaborate-first**. `lib/api.ts` (`apiFetch` → `CLOUD_API_URL`) hits `apps/cloud`; there are **no Next.js API routes**. Routes: `/login`, `/invite/[token]`, `/w/[workspaceId]`, `/w/[workspaceId]/p/[projectId]` (tabs: Graph / Tasks / Progress / Discussion). The only WebSocket is a **client-side** connection to `apps/cloud`'s presence endpoint (`lib/presence.ts` → `CLOUD_WS_URL`) — the web app hosts no socket server.

## Spec Kit workflow

`runStage()` fills Spec Kit document templates from the BYO model. The constitution (`.specify/memory/constitution.md`) steers specify → plan → tasks. Task `acceptance_criteria` is stored and sent to the frontend as `{text: string}[]`, **not** plain strings — don't change the shape. Implementation is external-agent-orchestrated (ADR 0009), with a one-shot `runImplementation` fallback for users with no agent CLI (ADR 0005).

## Security posture

The engine binds loopback but any web page can still reach it, so (ADR 0008): an **origin allowlist** (`tauri://localhost`, vite dev; extend via `PROMPTZONE_ALLOWED_ORIGINS`) governs browsers, and a **per-session bearer** (`PROMPTZONE_AUTH_TOKEN`, minted by the Tauri shell) is required on every request when set — `Authorization: Bearer` for HTTP, `?token=` for the terminal WS. Dev mode (`pnpm engine`, no token) enforces nothing. Native clients send no `Origin` and are unaffected. The terminal WS closes 1008 before spawning a shell if the origin isn't allowlisted (prevents CSWSH→RCE).

## Key environment variables

**Engine** (`apps/engine/src/config.ts`): `PROMPTZONE_ENGINE_PORT` (default 47131) · `CLOUD_API_URL` (default hosted Railway; `""` disables sync; `http://localhost:8080` targets a local cloud) · `SUPABASE_URL` + `SUPABASE_ANON_KEY` (unset = stub cloud auth) · `PROMPTZONE_AGENT_CMD` (custom agent CLI; task text in `$TASK_PROMPT`) · `PROMPTZONE_AGENT_ALLOW_BASH=1` (let agents run shell).

**Cloud** (`apps/cloud`): `DATA_BACKEND` (`memory` | `supabase`) · `AUTH_MODE` (`stub` | `supabase`) · `SUPABASE_URL` / `SUPABASE_KEY` / `SUPABASE_JWT_SECRET` · `CORS_ORIGINS` (includes `localhost:3000` by default).

**Web** (`apps/web`): `NEXT_PUBLIC_CLOUD_API_URL`, `NEXT_PUBLIC_CLOUD_WS_URL`, `NEXT_PUBLIC_AUTH_MODE` (`stub` fails *closed* to supabase), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## Deployment

Three deployable halves (`docs/DEPLOYMENT.md`):

- **`apps/cloud` → Railway** (or any container host; `Dockerfile` targets Cloud Run too). **Not Vercel** — it's a long-lived container with WebSocket presence and in-process state that requires a **single instance**. On Cloud Run, enable session affinity and pin one instance until a backplane exists.
- **`apps/web` → Vercel.** Static/client rendering, no server WS — a clean fit. Wire `NEXT_PUBLIC_CLOUD_*` to the cloud origin and add the Vercel domain to the cloud's `CORS_ORIGINS`.
- **`apps/desktop` → installers** built in CI (`.github/workflows/desktop-build.yml`, matrix macOS + Windows) and published for download.

**Packaging is host-platform-bound:** `pnpm tauri build` stages the engine and copies the **build machine's own Node binary** + `node-pty` prebuild into the bundle. Build each platform *on* that platform (hence the CI matrix); cross-compiling the Rust shell alone won't produce a working app. Details in `docs/DEVELOPMENT.md` and `docs/BUILD_AND_DISTRIBUTE.md`.

## ADR index (`docs/decisions/`)

Read the relevant ADR before changing its area — they carry the "why," including retired approaches not to restore.

0001 Tauri shell + Node sidecar · 0002 minimal agent loop over templates · 0003 SQLite graph, zero cloud in the skeleton · 0004 Skill stage owns task generation · 0005 implementation kickoff (single-shot fallback) · 0006 Anthropic-compat façade · 0007 Cursor-like workspace (integrated terminal + Git) · 0008 localhost origin allowlist + bearer · 0009 orchestrate external agents (no own runtime) · 0010 task-graph sync model · 0011 cloud as product pillar (web workspace + RAG) · 0012 web-app authoring via paired local compute node · 0013 managed Thai-LLM tier (Typhoon) + stage-based routing · 0014 desktop signs in through the hosted web auth pages (browser handoff, no native form).

0012–0013 are **Proposed** (not yet built): they add the model source that would let business users author — not just browse — in the web app.

## Conventions

- **Prose-forward docs.** ADRs and guides are written in paragraphs, not bullet dumps. Match the surrounding file.
- **No build step for the engine** — it runs TS directly on Node 24. Don't add a bundler.
- **The workspace lock** (`git_workspace` pattern where present) is reentrant per project — every handler that writes the workspace or calls git must hold it.
- **Don't re-add retired surfaces** — several ADRs cancel earlier code paths (e.g. the homegrown multi-turn tool loop, ADR 0009). Check the ADR before reviving anything.
