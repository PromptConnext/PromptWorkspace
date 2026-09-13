# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

PromptConnext is an **AI-native development workspace**: the **3S flow** (Scope → Spec → Skill) over a **BYO-model** orchestration engine, with a traceable task graph. Under the hood the process follows Spec Kit faithfully — **constitution → specify → plan → tasks → implement** — presented to users as 3S.

Two load-bearing decisions shape everything (see `docs/decisions/`):

- **Tauri shell + Node sidecar** (ADR 0001) — the desktop app is a thin Rust window; the engine runs locally as a spawned process.
- **BYO-agent / BYO-model** (ADR 0009) — PromptConnext orchestrates the coding agent and model you already pay for (Claude Code, Gemini CLI, Codex CLI, Ollama, or any CLI via `PROMPTCONNEXT_AGENT_CMD`); it ships no model runtime of its own. Compute, keys, and code stay on the user's machine.

## Layout

This is a **pnpm workspace** (`apps/*`) plus one Python app — no monorepo build tool. The five apps are independent.

| App | Stack | Purpose |
|---|---|---|
| `apps/desktop` | Tauri 2 (Rust) + React 18 / Vite webview | The app window; spawns the engine as a sidecar |
| `apps/engine` | Node 24 / TypeScript — Hono, `node:sqlite`, `node-pty` | Local engine on `127.0.0.1:47131`; runs TS natively, **no build step** |
| `apps/cloud` | FastAPI (Python ≥ 3.10) + Supabase/Postgres | **Optional** sync + collaboration backend (task-graph hub, RAG assistant) |
| `apps/web` | Next.js 16 App Router, React 19, TypeScript | Team-member web UI; read/collaborate against `apps/cloud` |
| `apps/corp` | Next.js 16 App Router, React 19, `next-intl` (EN/TH), Tailwind v4 | Public **marketing website** + the **desktop-app download page**; static/SEO-first, no backend |
| `apps/vscode` | VS Code extension — TypeScript, esbuild, no runtime deps | Developer surface for cloud-planned work (ADR 0019): assigned tasks, coding rules from the clone, push-driven task close (ADR 0022). Talks straight to `apps/cloud` — **no sidecar** |

`apps/desktop` (React 18), `apps/web` (React 19) and `apps/corp` (React 19) share one pnpm store; root `package.json`'s `pnpm.packageExtensions` pins each package's `@types/react` edge explicitly (not `pnpm-workspace.yaml` — pnpm 9.x only reads `packageExtensions` from `package.json`) — don't remove those. `apps/corp` is a **public, unauthenticated** surface — it talks to no engine and no cloud API; its only outbound links are the download host (desktop installers) and the cloud sign-in URL.

> **Retirement accepted, 2026-09-13.** [ADR 0019](docs/decisions/0019-desktop-as-vscode-extension.md) and
> [ADR 0020](docs/decisions/0020-cloud-is-the-source-of-truth.md) moved from Proposed to Accepted:
> the cloud is authoritative for the task graph, and `apps/desktop` plus `apps/desktop-theia` are being
> retired in favour of `apps/vscode` and an MCP server. Deletion is sequenced in
> [plan 0011](docs/plans/0011-desktop-decision-gate.md); the sync inversion is
> [plan 0012](docs/plans/0012-close-the-write-path.md). Treat desktop sections below as describing
> what still exists, not what to extend.

## Development commands

From the repo root:

```bash
pnpm install
pnpm desktop     # full app: Tauri window + engine sidecar + hot-reload UI (first run compiles Rust)
pnpm engine      # engine alone on 127.0.0.1:47131 (tokenless dev mode)
pnpm web         # apps/web (team UI) on http://localhost:3000
pnpm corp        # apps/corp (marketing + download) on http://localhost:3002
pnpm vscode      # apps/vscode esbuild watch; press F5 in apps/vscode for an Extension Host
```

`apps/web` and `apps/corp` are both Next.js on different ports (3000 vs 3002) so they can run side by side.

Browser-only UI iteration (no Rust compile): run `pnpm engine` in one terminal and `pnpm --dir apps/desktop dev` (Vite on `:1420`) in another.

**Engine** (`apps/engine`) — Node ≥ 24 is a hard requirement (`node:sqlite`, native TS). No build step; test suite: `node --test test/*.test.ts`.

**Cloud** (`apps/cloud`):

```bash
cd apps/cloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080     # in-memory backend, stub auth — no Supabase needed
pytest                                         # cloud's test suite
ruff check .                                   # lint (line-length 100)
```

**Web** (`apps/web`): `next dev` / `next build` / `tsc --noEmit` (typecheck) / `vitest run` (test suite).

**VS Code extension** (`apps/vscode`): `typecheck` / `build` (esbuild) / `test` (`node --test test/unit/*.test.ts`, no editor host) / `package` (VSIX). Configured through VS Code settings (`promptconnext.*`), never `process.env` — nothing sets env for the extension host. `src/git/git.d.ts` is a **vendored pinned copy** of the built-in Git extension's API and `src/git/gitBridge.ts` is its only importer; typecheck is the drift tripwire. It has no sidecar and must not grow one (ADR 0019).

**Corp** (`apps/corp`): `pnpm --dir apps/corp dev` (port 3002) / `build` / `typecheck` / `lint`. Copy `.env.example` → `.env.local` and set `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, and `NEXT_PUBLIC_DOWNLOAD_BASE_URL` (leave the last empty to render the download page's "coming soon" state).

The cloud app is **optional** for desktop work: the engine defaults to the hosted Railway instance. Point it locally with `CLOUD_API_URL=http://localhost:8080`, or disable sync with `CLOUD_API_URL=""`.

## Architecture

### Engine (`apps/engine/src`)

Hono server bound to `127.0.0.1:47131` (`index.ts`). Routes are mounted flat: `models`, `onboarding`, `projects`, `files`, `agents`, `cloud`, `backups`, plus the Anthropic façade at `/anthropic` and a terminal WebSocket.

- **`gateway/`** — the BYO-model gateway. `ModelConnection` is an **OpenAI-compatible** shape (`endpoint` + `/chat/completions`); `anthropic-compat.ts` is the Anthropic Messages façade (ADR 0006) that lets Claude Code speak to the connected BYO model.
- **`agent/`** — `loop.ts::runStage()` is the thin single-shot planning generator (constitution/specify/plan/tasks). `agent-runner.ts` + `adapters/` orchestrate external coding agents for **implementation**; each adapter (`claude-code`, `gemini`, `codex`, `custom`) is ~30 lines with `detect() / buildSpawn() / parseLine() / bringsOwnModel`. Result capture is **agent-agnostic** — changed files are read from Git and committed; a commit ref marks a task done.
- **`db.ts`** — local `node:sqlite` task graph. A **cache of the cloud's graph**, not an authority: ADR 0020 inverted ADR 0003, so it may be deleted and rebuilt from the cloud without loss.
- **`backup.ts`** — snapshots that database via SQLite's `VACUUM INTO` (consistent under concurrent writes; no WAL side-files to capture separately), surfaced as `GET`/`POST /engine/backups` and the desktop's "Back up now" panel. Cloud sync is opt-in, so this is the only second copy an offline user has. Never overwrites an existing file; restore is a manual file swap back to `dbFilePath()`.
- **`keychain.ts`** — model credentials live in the OS keychain (macOS `security` CLI; Windows DPAPI via PowerShell), never in SQLite or config.
- **`security.ts`** — origin allowlist + per-session bearer token (ADR 0008). See Security below.
- **`cloudClient.ts` / `sync/loop.ts`** — authenticate to `apps/cloud` as the cloud user and push the local graph up on an interval (ADR 0010). Per ADR 0015 they also mirror the **cloud-authoritative roster** (workspaces + project metadata) into a local cache that renders offline (refreshed on sign-in/focus/explicit refresh, scrubbed on logout), and `hydrateProjectGraph()` runs a one-shot **full-graph bootstrap-pull** (keyset-paginated) for a roster project with no local graph. New projects are born into the active `workspace_id`.

### Cloud (`apps/cloud/app`)

FastAPI entrypoint `main.py` (`uvicorn app.main:app --port 8080`). Routers in `api/`: `workspaces`, `sync`, `discussions`, `presence`, `assistant`, `integrations`, `github`, `health`, `documents`, `generation`, `stage_documents`, `policies`, `deployments`, `desktop_auth`. A `memory` data backend (stub auth via `X-User-Id`) needs no Supabase; `DATA_BACKEND=supabase` + `AUTH_MODE=supabase` enables real Postgres + JWT.

- **Task-graph sync** (`sync.py`, ADR 0010) — the cloud graph is a **projection** of the local SQLite schema. `PUT /sync/projects/{id}/graph` pushes a delta; `GET …?since=<cursor>` pulls. **Credentials never sync; source code never syncs** (that's Git). Push/pull is manual (Git-like); conflict policy is last-write-wins by `updated_at`. `sync.py` also owns the **project lifecycle state machine** (`planning → pending_tech_review → tech_review → repo_created`, `pz_projects.lifecycle_status`): `POST /projects/{id}/lifecycle/submit-for-review` is the only transition currently wired, gating on a non-empty requirement/spec/task graph.
- **Stage generation** (`generation/`, `api/generation.py`, ADR 0013) — the cloud Planner's own Spec Kit stage runner for business users with no desktop app, SSE-streamed via `POST /projects/{id}/generate/{stage}`. Independent of the engine's `runStage()` below. `routing.py::select_model()` is **unconditionally the managed Typhoon connection** — no BYO model, no per-stage routing table; it returns `None` (and the endpoint 400s) unless `MANAGED_MODEL_ENABLED=true` and `MANAGED_MODEL_API_KEY` are set.
- **RAG assistant** (`rag/`, `api/assistant.py`, ADR 0011) — grounded Q&A over synced artifacts, membership-scoped **before** similarity search. Uses a **workspace-connected BYO model** (`POST /workspaces/{id}/model-connection`), falling back to the managed tier (chat + a separate managed embedding model, since Typhoon itself has no embeddings endpoint) when none is configured; keys live in the server secret store (`secrets.py`), never in a Supabase row. Token budgets in `rag/budget.py`.
- **Git-host integration** (`integrations/github.py`, `integrations/github_auth.py`, `api/github.py`, ADR 0017 + its 2026-08-01 amendment) — auth is a **per-workspace fine-grained PAT**, not a platform GitHub App: an admin connects one via `PUT /workspaces/{id}/integrations/github` (verified against GitHub before storage, then Fernet-encrypted through `secrets.py`), and `github_auth.resolve_token()` is the single reader for all three consumers (repo creation, RAG code indexing, assistant snippet fetch). Since ADR 0021 that token also needs **Secrets** and **Variables** write; fine-grained PATs expose no permission introspection, so it cannot be verified at connect time and a stale token surfaces as `github_secrets_not_in_token_scope` at repo creation. Workspace config holds **no repo name** — the cloud creates one repo per project at tech-review exit and registers that repo's **own** webhook secret in `pz_repo_webhooks`, keyed by `repo_full_name`, which is what makes an inbound delivery attributable to exactly one project. Don't reintroduce `installation_id` or a workspace-level `repo` field; both were unverified client input (issue #3).
- **Deployment templates** (`deployments/registry.py`, `integrations/deploy_providers.py`, `api/deployments.py`, ADR 0021) — the Tech Lead picks one template per project (`Project.deployment_config`, frozen at `repo_created` like `policy_scope`); `create_repository` seeds its scaffold, its `.github/workflows/deploy.yml` and a `docs/deployment.md` in **one commit** via the Git Data API, writes the Actions secrets/variables *before* that commit, and registers the webhook before it too. The project's own CI deploys; the cloud observes via `deployment_status` + `workflow_run` on the existing per-repo hook. `Project.deployment_state` is the denormalized current view (`url` is last-known-good, `state` is current). A provider's `credential_owner` is three-valued, not a boolean: `customer` (an admin connects a token), `platform` (the cloud mints one per workspace) or `host` (the git host hands the workflow its own ephemeral token — GitHub Pages; the connect routes refuse it with `provider_is_host_owned`). Where a `url_kind="platform"` preview is expected to answer is declared by `DeploymentTemplate.platform_url_source` and resolved only in `deployments/preview_url.py` — both the pre-creation value and the webhook's pin read it, so never compute an expected URL by calling one provider's helper directly. Templates are additive — a new one is a directory plus a registry entry, mirroring `policies/registry.py` including the `ws:<uuid>` namespacing. A scaffold directory containing `base/` is **composed** (ADR 0026): `base/` is always seeded, one `runtimes/<name>/` is picked and the named `services/<name>.yaml` fragments are spliced in at the `# pz:services` marker, all from `plan_profile.derive_stack_profile`'s keyword read of the project's `plan` document. That *selects* hand-written files and never generates one, which is what keeps ADR 0024's boundary and the deterministic seed commit intact. **The cloud never builds, hosts or proxies an application.**
- **Presence** (`ws/manager.py`) — ephemeral who's-viewing roster over WebSocket. **In-memory, single-instance only**; no graph data flows over WS. Horizontal scale needs a shared backplane (Redis) first — flagged, not built.

### Web (`apps/web/src`)

Next.js App Router. `lib/api.ts` (`apiFetch` → `CLOUD_API_URL`) hits `apps/cloud`; there are **no Next.js API routes**. Routes: `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/invite/[token]`, `/w/[workspaceId]`, `/w/[workspaceId]/members`, `/w/[workspaceId]/settings`, `/w/[workspaceId]/p/[projectId]` (tabs: **Planner** (default) / Graph / Tasks / Progress / Discussion / **Preview**), `/w/[workspaceId]/p/[projectId]/settings`. Beyond read/collaborate, the Planner tab authors directly — PRD upload, stage generation (`components/project/Planner.tsx`, `useStageGeneration.ts`), and new-project creation (`POST /projects`). The only WebSocket is a **client-side** connection to `apps/cloud`'s presence endpoint (`lib/presence.ts` → `CLOUD_WS_URL`) — the web app hosts no socket server.

### Corp / marketing (`apps/corp/src`)

Next.js App Router, **static/SEO-first, backend-free**. Bilingual (EN/TH) via `next-intl` with a `[locale]` route segment (`/en`, `/th`, `x-default → /en`); config in `src/i18n/{routing,request,navigation}.ts`. Use the locale-aware `Link`/hooks from `@/i18n/navigation`, **never** `next/link`, for internal links. Content is data-driven: product/pricing/FAQ/prose pages are typed modules in `src/content/*`, article clusters in `src/content/articles/{en,th}.ts`, and the blog is MDX in `content/blog/{en,th}/*.mdx` (`next-mdx-remote` + `gray-matter`). SEO is built in — Metadata API, `robots.ts`, `sitemap.ts` (both locales + `hreflang`), dynamic OG images, JSON-LD. Design tokens live in `src/app/globals.css` under `@theme` (dark-first, WCAG AA); use semantic classes, never raw hex. The **`/download` page** is the primary conversion surface: it reads `NEXT_PUBLIC_DOWNLOAD_BASE_URL` (the desktop release host — see Deployment) and falls back to a "coming soon" state when unset. One API route, `/api/contact`, forwards form submissions to `CONTACT_WEBHOOK_URL` (logs only if unset). This app is public and unauthenticated — it never reaches the engine or the cloud API.

## Spec Kit workflow

`runStage()` fills Spec Kit document templates from the BYO model. The constitution (`.specify/memory/constitution.md`) steers specify → plan → tasks. Task `acceptance_criteria` is stored and sent to the frontend as `{text: string}[]`, **not** plain strings — don't change the shape. Implementation is external-agent-orchestrated (ADR 0009), with a one-shot `runImplementation` fallback for users with no agent CLI (ADR 0005). The cloud runs a second, independent stage generator for the web Planner (`apps/cloud/app/generation/`, see Cloud above) — managed Typhoon only, no BYO; don't look for per-stage routing plumbing there.

## Security posture

The engine binds loopback but any web page can still reach it, so (ADR 0008): an **origin allowlist** (`tauri://localhost`, vite dev; extend via `PROMPTCONNEXT_ALLOWED_ORIGINS`) governs browsers, and a **per-session bearer** (`PROMPTCONNEXT_AUTH_TOKEN`, minted by the Tauri shell) is required on every request when set — `Authorization: Bearer` for HTTP, `?token=` for the terminal WS. Dev mode (`pnpm engine`, no token) enforces nothing. Native clients send no `Origin` and are unaffected. The terminal WS closes 1008 before spawning a shell if the origin isn't allowlisted (prevents CSWSH→RCE).

## Key environment variables

**Engine** (`apps/engine/src/config.ts`): `PROMPTCONNEXT_ENGINE_PORT` (default 47131) · `CLOUD_API_URL` (default hosted Railway; `""` disables sync; `http://localhost:8080` targets a local cloud) · `SUPABASE_URL` + `SUPABASE_ANON_KEY` (unset = stub cloud auth) · `PROMPTCONNEXT_AGENT_CMD` (custom agent CLI; task text in `$TASK_PROMPT`) · `PROMPTCONNEXT_AGENT_ALLOW_BASH=1` (let agents run shell) · `CLOUD_WEB_URL` (ADR 0014 browser-login target; hosted default — see that ADR's phishing-risk note before pointing this at a new domain) · `PROMPTCONNEXT_DEEP_LINK_SCHEME` (set by the host shell — `promptconnext` from Tauri, `promptconnext-theia` from Theia — and forwarded to the web sign-in page so the ADR 0014 callback returns to the shell that started it; adding a value here means adding it to the allow-list in `apps/web/src/app/(auth)/login/page.tsx`).

**Cloud** (`apps/cloud`): `DATA_BACKEND` (`memory` | `supabase`) · `AUTH_MODE` (`stub` | `supabase`) · `SUPABASE_URL` / `SUPABASE_KEY` / `SUPABASE_JWT_SECRET` · `CORS_ORIGINS` (default includes `localhost:3000` and `localhost:1420`) · `MANAGED_MODEL_ENABLED` + `MANAGED_MODEL_API_KEY` (Typhoon; **required, not optional** — the Planner tab's `/generate/{stage}` fails closed on every request without both, see Deployment) · `RAG_KEY_ENCRYPTION_KEY` (Fernet key; required before any workspace configures a RAG model connection **or a GitHub PAT**) · `WEB_APP_URL` (base for invitation accept links; **must** be set in production, and `{WEB_APP_URL}/invite/*` must be allow-listed as a `/**` wildcard in Supabase's Redirect URLs or the confirmation bounces to the site root) · `PUBLIC_API_URL` (webhook callback base; empty disables webhook registration only) · `DEPLOY_R2_*` (ADR 0021 platform-hosted deploy template — `DEPLOY_R2_API_TOKEN` is account-wide and used **only** to mint per-workspace bucket-scoped credentials; only the minted one is sealed into a repo; `DEPLOY_R2_PUBLIC_BASE_URL` is required or that template refuses at repo creation).

**Web** (`apps/web`): `NEXT_PUBLIC_CLOUD_API_URL`, `NEXT_PUBLIC_CLOUD_WS_URL`, `NEXT_PUBLIC_AUTH_MODE` (`stub` fails *closed* to supabase), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

**Corp** (`apps/corp`): `NEXT_PUBLIC_SITE_URL` (canonical/OG/sitemap base) · `NEXT_PUBLIC_APP_URL` (cloud sign-in/signup target) · `NEXT_PUBLIC_APP_VERSION` (shown on `/download`) · `NEXT_PUBLIC_DOWNLOAD_BASE_URL` (desktop release asset base; **empty ⇒ "coming soon"**) · `CONTACT_WEBHOOK_URL` (optional `/api/contact` sink). See `apps/corp/.env.example`.

## Deployment

Four deployable pieces (`docs/DEPLOYMENT.md`):

- **`apps/cloud` → Railway** (or any container host; `Dockerfile` targets Cloud Run too). **Not Vercel** — it's a long-lived container with WebSocket presence and in-process state that requires a **single instance**. On Cloud Run, enable session affinity and pin one instance until a backplane exists.
- **`apps/web` → Vercel.** Static/client rendering, no server WS — a clean fit. Wire `NEXT_PUBLIC_CLOUD_*` to the cloud origin and add the Vercel domain to the cloud's `CORS_ORIGINS`.
- **`apps/corp` → Vercel.** Static/SEO marketing site, no backend — another clean Vercel fit (separate project/domain from `apps/web`). Point `NEXT_PUBLIC_DOWNLOAD_BASE_URL` at the desktop release host below so `/download` links resolve.
- **`apps/desktop` → installers** built in CI (`.github/workflows/desktop-build.yml`, matrix macos-latest **arm64** + windows-latest **x64**) via `tauri-action` (bundle targets `app` + `nsis`). The workflow zips the macOS `.app` and uploads both installers **flat to a Cloudflare R2 bucket under `installation/`** — `PromptConnext.app.zip` and `PromptConnext_<version>_x64-setup.exe`, plus a version-free copy of the latter at `PromptConnext_x64-setup.exe`. `apps/corp`'s `NEXT_PUBLIC_DOWNLOAD_BASE_URL` must point at that R2 prefix's public URL (no version subfolder). `NEXT_PUBLIC_APP_VERSION` is **display copy only** — the `/download` page links the two version-free names, so a bump needs no corp redeploy and a stale value can't misroute anyone; unset just drops the version from the page. Installed apps update themselves from the signed `latest.json` the workflow's `manifest` job assembles. No Linux build; the `/download` page offers macOS + Windows only.

**Packaging is host-platform-bound:** `pnpm tauri build` stages the engine and copies the **build machine's own Node binary** + `node-pty` prebuild into the bundle. Build each platform *on* that platform (hence the CI matrix); cross-compiling the Rust shell alone won't produce a working app. Details in `docs/DEVELOPMENT.md` and `docs/BUILD_AND_DISTRIBUTE.md`.

## ADR index (`docs/decisions/`)

Read the relevant ADR before changing its area — they carry the "why," including retired approaches not to restore.

0001 Tauri shell + Node sidecar · 0002 minimal agent loop over templates · 0003 SQLite graph, zero cloud in the skeleton · 0004 Skill stage owns task generation · 0005 implementation kickoff (single-shot fallback) · 0006 Anthropic-compat façade · 0007 Cursor-like workspace (integrated terminal + Git) · 0008 localhost origin allowlist + bearer · 0009 orchestrate external agents (no own runtime) · 0010 task-graph sync model · 0011 cloud as product pillar (web workspace + RAG) · 0012 web-app authoring via paired local compute node · 0013 managed Thai-LLM tier (Typhoon); the per-stage routing table it originally proposed was dropped for the cloud Planner, which is unconditionally managed-only (see the ADR's 2026-07-25 update) · 0014 desktop signs in through the hosted web auth pages (browser handoff, no native form) · 0015 desktop requires a cloud identity + workspace membership (cloud-projected roster) · 0016 VS Code–compatible shell via Eclipse Theia, not a fork · 0017 the cloud creates the project Git repo at tech-review exit, seeded with AI context · 0018 tasks assignable to workspace members via a pz-owned `assigned_user_id` (web edits, desktop displays) · 0021 deployment is a repo-seeded template run by the project's own CI, observed and embedded by the cloud · 0022 the developer's task loop starts and closes in the editor; a task closes on push, not on commit · 0023 the preview generalizes to every project type via a `delivery_kind` discriminator, and every build names the tasks inside it (its 2026-09-06 amendment adds GitHub Pages as a third, *host-owned* credential posture and generalizes the preview-URL pin) · 0024 a model may author a project's application scaffold, never its deployment pipeline (proposed, and answered mostly in the negative) · 0025 a deploy credential splits in two — the provider account is workspace-scoped, the provider-side project it deploys to is project-scoped and lives in `DeploymentConfig.provider_values` · 0026 Docker Compose on a server the customer owns, reached over SSH, with the runtime and backing services *selected* from the project's technical plan among hand-written scaffolds (this retires the Fly.io template and provider — don't restore them).

`0016` was briefly claimed twice; the task-assignment ADR was renumbered to 0018, so `0016` means the Theia shell decision only. Check the directory before claiming a number.

0012 is **Proposed** (not yet built): it would add a paired local compute node so business users could author, not just browse, in the web app. 0013 Part A (the managed Typhoon tier itself) **shipped** as the cloud Planner's only model source; Part B's per-stage routing table was dropped (see the ADR's update note above) rather than built.

## Conventions

- **Prose-forward docs.** ADRs and guides are written in paragraphs, not bullet dumps. Match the surrounding file.
- **No build step for the engine** — it runs TS directly on Node 24. Don't add a bundler.
- **The workspace lock** (`git_workspace` pattern where present) is reentrant per project — every handler that writes the workspace or calls git must hold it.
- **Don't re-add retired surfaces** — several ADRs cancel earlier code paths (e.g. the homegrown multi-turn tool loop, ADR 0009). Check the ADR before reviving anything.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
