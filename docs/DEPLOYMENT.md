# PromptConnext Deployment Guide

How to ship the three deployable halves of PromptConnext:

1. **Cloud app** (`apps/cloud`) — FastAPI sync/collaboration backend → **Railway** (public HTTPS).
2. **Web app** (`apps/web`, M8) — Next.js read-only workspace UI → **Vercel**.
3. **Desktop app** (`apps/desktop` + `apps/engine`) — Tauri 2 bundle → installers published to **Cloudflare R2** for download.

Railway is used (not Vercel) for the cloud app because it's a long-lived container with WebSockets (presence) and in-process state that requires a **single instance** — a poor fit for serverless. `apps/web` has none of those constraints (its only WebSocket use is a client-side connection *to* `apps/cloud`, not a server it hosts), so Vercel's static/SSR hosting is a good fit — see [§2.8](#28-web-app-apps-web--vercel). Deploys are manual for now; CI/CD recommendations are in [§6](#6-cicd-recommendations).

---

## 1. Architecture recap

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Desktop app (per user)     │  HTTPS │  PromptConnext Cloud (Railway)  │
│  Tauri shell + engine       │───────▶│  FastAPI, 1 instance         │
│  models/keys stay local     │  WS    │  DATA_BACKEND=supabase       │
└─────────────────────────────┘        └──────────────┬───────────────┘
        ▲ download .dmg/.msi                          │
┌───────┴─────────────────────┐        ┌──────────────▼───────────────┐
│  Cloudflare R2 (downloads)  │        │  Supabase (Postgres + Auth)  │
└─────────────────────────────┘        └──────────────────────────────┘
```

The engine always runs locally as a sidecar — only the sync backend and the installer files are deployed.

---

## 2. Cloud app → Railway

### 2.1 Prerequisites

- Railway account + CLI: `npm i -g @railway/cli && railway login`
- A Supabase project (production) — grab `SUPABASE_URL` and the **service_role** key
- `psql` locally for applying migrations

### 2.2 Apply Supabase migrations

Migrations are plain SQL in `apps/cloud/migrations/`. The recommended way to apply them is `apps/cloud/scripts/migrate.py` — a dependency-free wrapper around `psql` (see the script's own docstring for why it shells out rather than adding a Postgres driver) that reads `pz_schema_migrations` to know what's already applied, applies only what's pending in numeric order, wraps each migration in a transaction so a failure leaves it wholly unapplied, records the ledger row in that same transaction, and refuses — loudly, before touching anything — if an already-applied file's checksum no longer matches what's recorded:

```bash
cd apps/cloud
.venv/bin/python scripts/migrate.py --db-url "$SUPABASE_DB_URL" apply --dry-run   # see what's pending first
.venv/bin/python scripts/migrate.py --db-url "$SUPABASE_DB_URL" apply             # then actually apply it
```

`SUPABASE_DB_URL` is the direct Postgres connection string (Supabase → Settings → Database); `--db-url` can be omitted if that variable (or `DATABASE_URL`) is already in the environment. Migration 0003 installs the RLS policies that back workspace membership — do not skip it (the runner won't let you skip anything out of order regardless). On a brand-new database the runner bootstraps `pz_schema_migrations` itself (see 0024 below) before anything else, then proceeds through the rest in normal numeric order — a fresh database needs no separate ledger step, just run `apply` and stop.

**Migration 0023 needs a deploy-time value.** It replaces the embedding column's fixed `vector(1536)` width with a parameter (there is no `1536` baked into the schema anymore), and doing so is destructive: any already-embedded `pz_rag_chunks`/`pz_code_chunks` rows are deleted, because a vector computed at one width cannot be reinterpreted at another. Its header declares this to the runner (`migration-runner: requires-vars=embed_dim`), so `apply` refuses to run it — before opening a connection — without a matching `--var`:

```bash
.venv/bin/python scripts/migrate.py --db-url "$SUPABASE_DB_URL" apply --var embed_dim=1024
```

Pick the width your embedding model actually produces (e.g. 1024 for BGE-m3 or Jina v3, 896 for KaLM-embedding-multilingual v2.5) — there is deliberately no default; omitting `--var embed_dim` stops the run rather than silently reapplying the 1536 ceiling this migration exists to remove. This `requires-vars` header convention is generic, not a one-off for 0023 — any future migration that needs a deploy-time value declares it the same way and gets the same fail-fast treatment; see the runner's docstring. **After 0023 runs, reindex before the assistant can ground content again**: `POST /workspaces/{id}/assistant/reindex` (or per-project `POST /projects/{id}/assistant/reindex`). Until that completes, content/mixed chat questions degrade to the existing "no indexed content" ungrounded path (`app/api/assistant.py`) rather than erroring — nothing is silently wrong, but nothing is grounded either. A workspace's model connection (`POST /workspaces/{id}/model-connection`) also needs its own `embed_dim` set to the same number; a mismatch there now 409s with `embed_dim_mismatch` instead of failing at query time against the vector column.

**Migration 0024** creates `pz_schema_migrations` itself — the table that makes all of the above possible. It records, per file: filename, a sha256 checksum of the file's exact bytes (so an edit to an already-applied file becomes detectable instead of silently drifting from what actually ran — this repo has already had an operator decline to let a migration file be touched post-application for exactly that reason), when the row was written, who wrote it, and a `source` of either `applied` (the runner executed the file and wrote the row in the same action) or `adopted` (an operator asserted the row's truth without that execution — see below).

<details>
<summary>Fallback: applying migrations without the runner (no Python venv available)</summary>

The runner is a thin wrapper — everything it does can still be done by hand with plain `psql`, and this is worth keeping documented for an environment with no `apps/cloud/.venv` handy:

```bash
cd apps/cloud
for f in migrations/00*.sql; do
  psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f "$f" || { echo "migration failed: $f" >&2; break; }
done
```

(The glob is `00*.sql`, not `000*.sql` — migration numbers passed 0009 long ago, and the tighter pattern silently stops matching anything from 0010 on.) This loop does **not** wrap each file in its own transaction, does **not** write ledger rows, and does **not** check checksums — it is the pre-0024 behavior, kept only as a manual fallback. Migration 0023 is not part of it — run it by hand, in its numeric place, exactly as shown above but with plain `psql -v embed_dim=1024 -f migrations/0023_configurable_embed_dim.sql`, before resuming the loop. If this fallback is ever used against a database the runner will later manage, follow up with the adoption procedure below so `pz_schema_migrations` reflects what actually happened.

</details>

#### Adopting an existing database into the migrations ledger

The ledger has a bootstrapping problem: the operator's production database almost certainly already carries 0001 through 0022 (0023 is destructive and requires its own deliberate `-v embed_dim` run, so don't assume it), applied over months by the plain `psql -f` loop, with nothing anywhere recording that fact. Once `pz_schema_migrations` exists, that history needs to be *in* it — but re-running 0001–0022 to populate it is exactly the wrong move: several of those files are only partially idempotent (0003 guards 15 of 32 DDL statements, 0009 guards 9 of 16, 0006 none of its one `GRANT`), so replaying them against a database that already has their effects would fail partway or silently duplicate work. The ledger has to be told this history, not made to re-derive it by force.

It also must not be told automatically. A migration that inserted "every file numbered below me is applied" the first time it ran would be guessing on the operator's behalf and recording that guess as though it were observed fact — precisely the uncertainty this table exists to remove. `apps/cloud/scripts/migrate.py apply` never does this on its own; adoption is its own subcommand, gated behind an explicit `--through` and an interactive confirmation (or `--yes`), so it can't be triggered by running the ordinary `apply` path. Every row it writes carries `source = 'adopted'` rather than `'applied'`, so the distinction between "we watched this happen" and "we were told this happened" survives in the data rather than being flattened away for convenience.

```bash
cd apps/cloud
.venv/bin/python scripts/migrate.py --db-url "$SUPABASE_DB_URL" adopt --through 0022
```

`--through` is the last migration you believe this database already has (0023 is refused unless you also pass `--yes` — see the warning it prints; 0024 and anything after it is always refused outright, since those are only ever recorded by actually running them). Run with no `--yes` first: it prints the full plan — which files will be marked `adopted`, whether the ledger table itself still needs creating — and prompts before writing anything, so nothing changes on a dry look. Add `--yes` (optionally `--adopted-by NAME` and `--note "..."`) to actually commit it. This single command replaces what used to be three separate manual `psql` steps (create the ledger table, loop-insert the adopted rows, separately record 0024 itself as `applied`): it creates `pz_schema_migrations` by actually running 0024 if it isn't there yet — recorded `source='applied'`, because that part really is watched, not asserted — then records everything through `--through` as `adopted` in one transaction. It's also safe to re-run: rows already in the ledger are left alone (`on conflict (filename) do nothing`), so retrying after a partial failure or re-checking an already-adopted database is a no-op, not a duplicate.

The checksum recorded for each adopted row is of the file as it exists on disk *today*, not as it looked whenever the migration actually ran — this table cannot recover that historical byte-for-byte state, and doesn't pretend to. What it buys is a going-forward baseline: if that file changes after adoption, a checksum comparison will catch the drift on the next `apply`, which is the failure mode this column exists for regardless of whether the row's origin was `applied` or `adopted`.

After adoption, resume with the runner for anything past `--through` that hasn't run yet — `apply --var embed_dim=<N>` will stop and ask for it when it reaches 0023, exactly as it would on any other database.

A **fresh** database needs none of this: `apply` bootstraps the ledger table itself and proceeds through everything else in numeric order, with no history to assert and therefore nothing to adopt.

### 2.3 Create the Railway service

The repo already has a working `apps/cloud/Dockerfile` (respects `$PORT`, single uvicorn worker). Two options:

**CLI (manual deploy):**

```bash
cd apps/cloud
railway init                 # create project, e.g. "promptconnext-cloud"
railway up                   # builds the Dockerfile, deploys
```

**Dashboard (repo-linked):** New Project → Deploy from GitHub repo → set **Root Directory** to `apps/cloud` so Railway finds the Dockerfile. Repo-linked services auto-deploy on push — fine for the dev environment, consider disabling auto-deploy on prod until CI exists.

### 2.4 Environment variables (Railway → service → Variables)

Production values:

| Variable | Value | Notes |
|---|---|---|
| `DATA_BACKEND` | `supabase` | `memory` loses all data on restart — dev only |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | |
| `SUPABASE_KEY` | service_role key | Server-side only; requests are re-scoped to the caller's JWT |
| `AUTH_MODE` | `supabase` | `stub` (X-User-Id header) must never reach production |
| `SUPABASE_JWT_SECRET` | (usually empty) | Legacy HS256 fallback only; JWKS via `SUPABASE_URL` is the default path |
| `APP_ENV` | `production` | |
| `LOG_LEVEL` | `INFO` | |
| `CORS_ORIGINS` | `tauri://localhost,http://localhost:1420,https://<web-app>.vercel.app` | Packaged Tauri app origin + dev Vite origin + the `apps/web` deployment's origin(s) — see [§2.8](#28-web-app-apps-web--vercel) |
| `RATE_LIMIT_ENABLED` | `true` | |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_BURST` | `300` / `60` | Defaults are fine to start |
| `WS_HEARTBEAT_SECONDS` | `20` | |
| `WS_MAX_CONNECTIONS_PER_PROJECT` | `50` | |
| `TOMBSTONE_TTL_DAYS` | `30` | `0` disables the GC loop |
| `TOMBSTONE_GC_INTERVAL_SECONDS` | `3600` | |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_WEBHOOK_SECRET` | as needed | Only if the Jira/ClickUp mirror (M5) is in use |
| `RAG_KEY_ENCRYPTION_KEY` | Fernet key | Required before any workspace configures a model connection (M9 RAG assistant); generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Without it, `POST /workspaces/{id}/model-connection` fails closed rather than storing a plaintext key. |
| `WEB_APP_URL` | `https://<web-app>.vercel.app` | Base for every invitation accept link — both the URL emailed to the invitee and the `accept_url` handed to the admin who created the invite. **Required in production:** the default is `http://localhost:3000`, so leaving it unset mails invitees a link to their own machine and the invitation silently dead-ends. `{WEB_APP_URL}/invite/*` must also be allow-listed in Supabase → Authentication → URL Configuration → Redirect URLs, as a `/**` wildcard — see [§2.8](#28-web-app-apps-web--vercel). |
| `PUBLIC_API_URL` | **this** service's origin, e.g. `https://promptconnextcloud-production.up.railway.app` | Callback base for per-repo GitHub webhooks (`{PUBLIC_API_URL}/api/webhooks/github`). The cloud origin, not the web one — easy to confuse with `WEB_APP_URL` above. GitHub POSTs to it directly, so it must be publicly reachable over HTTPS. Leaving it empty is a valid launch choice — repo creation and seeding still work, only PR/push indexing stays dormant — but **it does not apply retroactively**: hooks are registered once, at repo creation, so any repo created while this is unset never gets one and there is no backfill. Set it before real projects start creating repos. There is **no** platform GitHub credential to configure; each workspace supplies its own fine-grained PAT in workspace settings, encrypted with `RAG_KEY_ENCRYPTION_KEY` (ADR 0017 amendment). |
| `DEPLOY_R2_*` | see `apps/cloud/.env.example` | Only for the platform-hosted deployment template (ADR 0021). `DEPLOY_R2_API_TOKEN` is account-wide and is used **only** to mint a per-workspace, bucket-scoped credential — only the minted one is ever written into a customer repository, because a repo secret is readable by anyone who can push to that repo. `DEPLOY_R2_PUBLIC_BASE_URL` is required for that template: without it there is no preview address to hand the pipeline and repo creation refuses with `deployment_preview_url_not_configured`. Leave the block empty to disable the template entirely (it then refuses with `deployment_provider_not_configured` rather than seeding a pipeline that could never succeed). **Never set `DEPLOY_R2_ALLOW_SHARED_KEY=true` outside local dev** — it seals one shared key into every repository. |

Railway injects `PORT` automatically; the Dockerfile already honors it.


### Deployment templates and the workspace GitHub token (ADR 0021)

Selecting a deployment template makes the cloud write GitHub Actions **secrets and variables** into each new project repository, which the workspace's fine-grained PAT must be permitted to do. That is a permission most existing tokens do not carry, and GitHub offers no way to read a fine-grained token's own scopes — so it cannot be checked when the token is connected. A stale token connects cleanly, works for months, and then fails at repo creation with `github_secrets_not_in_token_scope`. Before enabling deployment templates for real projects, ask workspace admins to reissue their tokens with **Secrets** and **Variables** write access alongside Contents, Administration and Webhooks.

Repositories created before ADR 0021 carry webhooks subscribed only to `push` and `pull_request`, so no deploy they run will ever be visible in the cloud. Re-running repo creation does not fix this — that route returns early for a project already at `repo_created`, and hook registration treats GitHub's "already exists" response as success. `POST /projects/{id}/deployment/repair-webhook` (workspace admin) is the migration path: it widens the existing hook's event list in place, leaving its signing secret untouched, and is idempotent.

One network note for production. After a successful deploy the cloud makes a single outbound request to the deployed preview URL, to read whether it permits being embedded — a question no browser can answer for a cross-origin frame. That URL is reported by the project's own workflow, so it is attacker-chosen input from anyone with push access to a project repository. The code refuses to probe any hostname resolving to a loopback, private, link-local, reserved or multicast address and follows no redirects, which blocks the direct request-forgery path. It cannot, on its own, close DNS rebinding between the resolution and the connection. If the cloud runs anywhere with reachable internal services or an instance-metadata endpoint, put its egress behind a proxy that enforces the same public-address rule at the network layer.

The cloud Planner UI (the web app's stage-generation tab, `apps/cloud/app/api/generation.py`) has no BYO-model fallback: `select_model()` (`apps/cloud/app/generation/routing.py`) returns whatever `build_managed_connection()` (`apps/cloud/app/generation/managed.py`) produces from `MANAGED_MODEL_ENABLED` and `MANAGED_MODEL_API_KEY`, and returns nothing at all if either is unset. `apps/cloud/.env.example` ships `MANAGED_MODEL_ENABLED=false` by default, so a deployment that only follows the table above will have a Planner tab that fails closed on every request. Treat `MANAGED_MODEL_ENABLED=true` plus a valid `MANAGED_MODEL_API_KEY` as required, not optional, before telling users the Planner is available — set both explicitly in Railway's Variables alongside the settings above.

Turning on `MANAGED_MODEL_ENABLED` covers the Planner's *generation* path, but the RAG assistant's *retrieval* path needs a second, separate setting: Typhoon is chat-only, so a keyless workspace's content questions (anything grounded in synced documents or code, as opposed to task status or lineage) are answered by `build_managed_embed_connection()` (`apps/cloud/app/generation/managed.py`), which reads `MANAGED_EMBED_BASE_URL`, `MANAGED_EMBED_MODEL`, and `MANAGED_EMBED_API_KEY`. Leave any of those unset and it silently returns `None` — `app/api/assistant.py` then skips retrieval entirely, and every content question comes back with a fluent "I don't have enough information" that is indistinguishable from a working assistant that genuinely doesn't know. The app now logs a startup WARNING when this combination occurs (`MANAGED_MODEL_ENABLED=true` with no embed connection resolved), but don't wait to see it in the logs — set the three `MANAGED_EMBED_*` variables in Railway's Variables alongside `MANAGED_MODEL_*` whenever the managed tier is on. `apps/cloud/.env.example` documents the constraint that matters most when picking a model: `pz_rag_chunks.embedding` is a fixed `vector(1536)` column, so the embedding model's output dimension must be exactly 1536 — most open multilingual encoders (BGE-m3, Jina v3, KaLM-embedding-multilingual) do not fit that, and OpenAI's `text-embedding-3-small`, Google's `gemini-embedding-001` (MRL-truncated to 1536), and `Alibaba-NLP/gte-Qwen2-1.5B-instruct` are known-good options instead.

### 2.5 Scaling constraints — important

Presence, rate-limit, metrics, the RAG embed queue, and the RAG daily token
budget are all **in-process**. Until a shared backplane (e.g. Redis) exists:

- **Replicas = 1.** Do not scale horizontally.
- Railway routes all traffic to the single replica, so session affinity is a non-issue at 1 instance — but revisit before ever raising the replica count.
- Vertical scaling (more memory/CPU on the one instance) is the only safe lever.

**What breaks first, if the replica count ever does leave 1.** The order matters because the four components fail differently, not equally. The **daily token budget** (`apps/cloud/app/rag/budget.py`, plus the global managed limiter built in `apps/cloud/app/main.py`) goes first, because its failure costs money: it is a dict keyed by workspace, so split across N replicas each workspace gets N times its daily cap and the managed-Typhoon bill multiplies to match. **Presence** (`apps/cloud/app/ws/manager.py`) is second — two people on the same project connected to different replicas simply do not see each other, which is a wrong answer rather than an error, and the kind of thing users report. The **rate limiter** (`apps/cloud/app/ratelimit.py`) and the **embed queue** (`apps/cloud/app/rag/queue.py`) come last, not because they matter least but because they degrade *silently*: every client's effective request limit becomes N times the configured one, and a job enqueued on one replica is invisible to the other, so the index-status panel's `pending_jobs` becomes a coin flip. Fix them in that same order if a backplane is ever genuinely needed — a shared counter for the budget and the managed limiter, then pub/sub fan-out for presence, then the request limiter, then the queue, which by that point wants a real job broker rather than a Redis list.

**What to watch.** `GET /health` carries a `capacity` block (`apps/cloud/app/capacity.py`), ordered by that same priority — it is read-only introspection over the four components, not a second copy of their state:

```json
"capacity": {
  "instance_id": "9f2a…",
  "instance_started_at": "2026-09-22T01:20:04.118Z",
  "budget":   { "managed_daily_limit": 200000, "busiest_workspace_tokens": 4000,
                "headroom_tokens": 196000, "headroom_fraction": 0.98,
                "workspaces_charged_today": 2 },
  "presence": { "rooms": 1, "connections": 2 },
  "queue":    { "depth": 0, "projects": 0 }
}
```

The budget block reports headroom against `MANAGED_DAILY_TOKEN_BUDGET` — the cap whose overrun spends the platform's money (ADR 0027), as opposed to a BYO workspace overrunning its own key — and deliberately names no workspace or project: `/health` is unauthenticated, so it reports the shape of the load and not whose it is.

**The alarm.** Nothing in this repository talks to an uptime-monitoring service; wire the following into whichever one you already use (Better Uptime, UptimeRobot, Pingdom, a Railway-side check), polling `/health` every 60 s:

- **Two concurrent polls returning different `instance_id`s ⇒ more than one instance is serving traffic.** Page on it: that is the condition all four components above break under, and it is the closest thing to a replica-count alarm that exists, because **a process cannot count its own peers.** There is no discovery mechanism here, no registry, and nothing the container platform guarantees to set to the current replica count, so the service does not report a `replicas` field rather than report a guess. `instance_id` is minted once per process, which makes "how many replicas?" answerable from outside by comparison alone.
- **`instance_id` changed between two sequential polls ⇒ the single instance restarted.** Not an error by itself (a deploy does this), but it drops every queued embed job and empties every presence room, so an unexplained change is worth an alert.
- **`capacity.queue.depth` non-zero and not decreasing across 3 consecutive polls ⇒ the embed worker is stuck or jobs are being discarded.** A legitimate backfill sweep queues hundreds and drains steadily, so test the trend, not the value. Confirm the cause with `GET /projects/{id}/assistant/index-status`, whose `last_error` distinguishes "still draining" from "thrown away for want of a model connection".
- **`capacity.budget.headroom_fraction` below `0.1` ⇒ the busiest workspace is about to start getting 429s** from the Planner and the assistant, and on the managed tier that number is also the day's spend. Below `0.0`-adjacent values it is already blocked.
- **`capacity.presence.connections` climbing toward `WS_MAX_CONNECTIONS_PER_PROJECT` × active projects** is the only saturation signal presence has; a room at capacity rejects new sockets with close code 1013.

The rate limiter is the one component with no counter of its own: a bucket count measures how many clients have been seen, not how close anything is to a limit, and its multi-instance failure is caught by the `instance_id` check like everything else that degrades quietly.

### 2.6 Verify

```bash
curl https://<service>.up.railway.app/health     # schema_version from migrations + the capacity block (§2.5)
open https://<service>.up.railway.app/docs       # FastAPI docs
```

Then point a desktop build's cloud-sync URL at the Railway domain and confirm push/pull on `/sync/projects/{id}/graph`.

### 2.7 Dev vs production environments

Use Railway **Environments** (one project, `dev` + `production`) or two projects:

| | dev | production |
|---|---|---|
| `DATA_BACKEND` | `memory` (or a dev Supabase project) | `supabase` |
| `AUTH_MODE` | `stub` acceptable | `supabase` — required |
| `APP_ENV` | `development` | `production` |
| `LOG_LEVEL` | `DEBUG` | `INFO` |
| Deploys | auto-deploy on push OK | manual / CI-gated |
| Supabase | separate free project | production project |

Never share a Supabase project between environments — migrations and tombstone GC would collide.

### 2.8 Web app (`apps/web`) → Vercel

`apps/web` (M8) is a read-only Next.js client of `apps/cloud` — no server-side
secrets, no WebSocket server of its own (presence is a client-side connection
*to* `apps/cloud`), so it deploys as a normal static/SSR Vercel project.

1. Import `apps/web` as the project root in Vercel (monorepo → set "Root
   Directory" to `apps/web`).
2. Environment variables (Vercel → project → Settings → Environment
   Variables), mirroring `apps/web/.env.example`:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_CLOUD_API_URL` | `https://<cloud-service>.up.railway.app` |
   | `NEXT_PUBLIC_CLOUD_WS_URL` | `wss://<cloud-service>.up.railway.app` |
   | `NEXT_PUBLIC_AUTH_MODE` | `supabase` |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key (safe to expose client-side) |

3. After the first deploy, add the resulting `https://<project>.vercel.app`
   origin (and any custom domain) to `apps/cloud`'s `CORS_ORIGINS` (§2.4) and
   redeploy the cloud service — without this, the browser blocks every
   request with a CORS error.

No changes to `apps/cloud` are required beyond that CORS entry: `apps/web`
only calls the sync/graph/workspace/invitation endpoints the desktop client
already uses.

4. Set `apps/cloud`'s `WEB_APP_URL` to this deployment's origin. It is the base
   for every invitation accept link, and it defaults to `http://localhost:3000`
   — left unset in production, invitation emails point at the invitee's own
   machine.

5. In the Supabase dashboard (Authentication → URL Configuration), add
   **wildcard** entries to Redirect URLs — `https://<project>.vercel.app/**`
   and `http://localhost:3000/**` — alongside the Site URL.

   This one is easy to get wrong and fails quietly. Supabase matches a
   requested `redirect_to` against that allow list *literally*: a bare origin
   entry matches the origin and nothing beneath it. Invitations redirect to
   `{WEB_APP_URL}/invite/{token}` and password resets to
   `{origin}/reset-password`, so without the `/**` suffix Supabase silently
   falls back to the Site URL and drops the user on `/` with the token gone.
   Nothing errors; the invitee simply never joins the workspace they were
   invited to. (`apps/web` recovers from this — `/` surfaces any invitation
   addressed to the signed-in user via `GET /invitations/pending` — but the
   direct link is the intended path.)

### 2.9 Corp app (`apps/corp`) → Vercel

`apps/corp` is the public marketing site + desktop-app download page — static/SEO-first, no backend of its own, so it deploys as a normal Vercel project like `apps/web`, on a separate project/domain.

1. Import `apps/corp` as the project root in Vercel (monorepo → set "Root Directory" to `apps/corp`).
2. Environment variables (Vercel → project → Settings → Environment Variables), mirroring `apps/corp/.env.example`:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SITE_URL` | `https://<corp-domain>` (canonical/OG/sitemap base, no trailing slash) |
   | `NEXT_PUBLIC_APP_URL` | `https://<web-app-domain>` (cloud sign-in/signup target) |
   | `NEXT_PUBLIC_APP_VERSION` | display copy only; `/download` links version-free filenames, so a bump needs no corp redeploy. Leave empty to omit the version from the page |
   | `NEXT_PUBLIC_DOWNLOAD_BASE_URL` | the R2 `installation/` prefix's public URL (§4); leave empty to render `/download`'s "coming soon" state |
   | `CONTACT_WEBHOOK_URL` | optional; `/api/contact` logs server-side only if unset |

3. No `apps/cloud` CORS entry needed — `apps/corp` never calls the engine or the cloud API.

---

## 3. Desktop app → build installers

### 3.1 macOS (Apple Silicon) — supported today

Prereqs on the build machine: Node ≥ 24 (its version/arch becomes the app runtime), pnpm, Rust (rustup), Xcode CLT. Full detail in [`BUILD_AND_DISTRIBUTE.md`](./BUILD_AND_DISTRIBUTE.md).

```bash
pnpm install
cd apps/desktop
pnpm tauri build
```

Output: `apps/desktop/src-tauri/target/release/bundle/macos/PromptConnext.app` (~192 MB, self-contained engine + bundled Node).

**Produce a DMG for distribution** — add `"dmg"` to bundle targets in `src-tauri/tauri.conf.json`:

```json
"bundle": { "targets": ["app", "dmg"] }
```

Rebuild; the `.dmg` lands in `bundle/dmg/`.

**Unsigned-app reality:** without an Apple Developer account, Gatekeeper blocks downloaded copies. Ship with instructions for testers:

```bash
xattr -dr com.apple.quarantine /Applications/PromptConnext.app
```

or right-click → Open → Open. When you get an Apple Developer account later: set `bundle.macOS.signingIdentity` in `tauri.conf.json`, export `APPLE_ID`, `APPLE_PASSWORD` (app-specific) or `APPLE_API_KEY`, and `APPLE_TEAM_ID`, and Tauri signs + notarizes during `tauri build`. Treat signing as a prerequisite for any public (non-tester) distribution.

### 3.2 Windows — via CI (Linux still not supported)

Windows can't be built locally on an M1 (Tauri's MSI/WiX path doesn't run on macOS at all, and the NSIS cross-compile route is experimental) — it ships from `.github/workflows/desktop-build.yml`, a `macos-latest` + `windows-latest` matrix using `tauri-apps/tauri-action`. Trigger with `git tag v0.0.1 && git push origin v0.0.1` or `gh workflow run desktop-build.yml`. Full detail (why CI and not local cross-compile, and the experimental local route for debugging) is in [`DEVELOPMENT.md` — Build target 3](./DEVELOPMENT.md#build-target-3--windows-from-the-m1-use-ci-recommended).

The three app-level gaps this required are closed:

1. `stage:engine` and `scripts/bundle-node.mjs` are platform-aware (`node.exe` on Windows, cross-platform staged-dir cleanup instead of `rm -rf`).
2. `tauri.conf.json` `bundle.targets` includes `"nsis"`.
3. `apps/engine/src/keychain.ts` has a Windows path (DPAPI via PowerShell, user-scoped, no native addon) alongside the macOS `security` CLI path.

`node-pty` native prebuilds are still handled correctly because CI runs the hoisted `pnpm deploy` on the target OS itself (§6/§3.2 of `DEVELOPMENT.md`) — no cross-compilation of the engine is attempted.

**Linux is not yet supported**: no bundle target (`"deb"`/`"appimage"`), no libsecret keychain path, and the build machine would need WebKit dev headers (`libwebkit2gtk-4.1-dev`). List it as "coming soon" on the download page until that work happens.

### 3.3 Versioning

Bump `version` in `apps/desktop/src-tauri/tauri.conf.json` (and keep `apps/desktop/package.json` in sync) before each release. Use the version in the uploaded filename (below) so URLs are immutable.

---

## 3A. VS Code extension (`apps/vscode`) → Marketplace + Open VSX

The extension is not an installer and does not touch R2. It has no bundled runtime and spawns no
executable, so there is nothing to sign and nothing to disclose beyond saying so.

```bash
pnpm --dir apps/vscode typecheck
pnpm --dir apps/vscode test
pnpm --dir apps/vscode build
pnpm --dir apps/vscode package        # → promptconnext-vscode-<version>.vsix
```

**Publish from Linux or macOS, never Windows.** Packaging on Windows strips the POSIX executable
bit from bundled files. Harmless while we bundle no executables — establish the habit before that
stops being true.

Two registries, both from day one (ADR 0019):

```bash
npx @vscode/vsce publish --azure-credential   # Microsoft Marketplace → VS Code
npx ovsx publish promptconnext-vscode-<version>.vsix -p "$OVSX_TOKEN"   # → Cursor, Windsurf, VSCodium, code-server
```

Three things to get right before the first release:

- **Register the publisher on both registries.** The extension id (`publisher.name`) is baked into
  the sign-in callback URI (`src/auth/signIn.ts::EXTENSION_ID`) and into the web app's scheme
  allow-list expectations. Renaming after release breaks in-flight sign-ins.
- **Do not build a PAT-based publishing flow.** Global Azure DevOps PATs retire **2026-12-01**;
  use Entra ID workload identity federation with `vsce publish --azure-credential`.
- **Marketplace Participation Policies §3(b)**: the listing and walkthrough may not promote our
  other IDE offerings. That pitch belongs on `apps/corp`.

Bumping `version` in `apps/vscode/package.json` is the whole release process — installed
extensions auto-update from the registry, so there is no manifest to assemble and no channel to
maintain.

---

## 4. Publish installers to Cloudflare R2

### 4.1 One-time bucket setup

1. Cloudflare dashboard → **R2 Object Storage** → Create bucket, e.g. `promptconnext-releases`. Location: automatic.
2. Create an **R2 API token** (R2 → Manage API Tokens): *Object Read & Write*, scoped to this bucket. Note the Access Key ID / Secret.
3. **Public access** — two options:
   - **Custom domain (recommended):** bucket → Settings → Public access → Connect Domain → `downloads.<yourdomain>` (the domain must be on Cloudflare DNS). Cloudflare creates the DNS record and proxies/caches automatically.
   - **r2.dev subdomain (dev/testing only):** enable the `*.r2.dev` public URL. Rate-limited, not cached, fine for internal testing.

No CORS config is needed for direct-download links; add a CORS policy only if a web page fetches release metadata (e.g. `latest.json`) via `fetch()`:

```json
[{ "AllowedOrigins": ["https://<yourdomain>"], "AllowedMethods": ["GET"], "AllowedHeaders": ["*"] }]
```

### 4.2 Upload a release (manual)

R2 is S3-compatible. Using AWS CLI (or `rclone`, or Wrangler):

```bash
# one-time config
aws configure --profile r2          # use the R2 Access Key ID / Secret
# endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com

VERSION=0.0.1
aws s3 cp apps/desktop/src-tauri/target/release/bundle/dmg/PromptConnext_${VERSION}_aarch64.dmg \
  s3://promptconnext-releases/desktop/${VERSION}/PromptConnext_${VERSION}_macos-arm64.dmg \
  --profile r2 --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --content-type application/x-apple-diskimage
```

Alternatively with Wrangler: `wrangler r2 object put promptconnext-releases/desktop/${VERSION}/... --file=...`.

### 4.3 Suggested layout

```
desktop/
  latest.json                        # {"version":"0.0.1","macos-arm64":"https://downloads.../PromptConnext_0.0.1_macos-arm64.dmg"}
  0.0.1/
    PromptConnext_0.0.1_macos-arm64.dmg
    checksums.txt                    # shasum -a 256 *.dmg
```

Versioned paths are immutable (cache-friendly); `latest.json` is the one mutable pointer a download page or future in-app updater reads. Always publish `checksums.txt` — especially while builds are unsigned.

---

## 5. DNS summary

| Record | Target | Purpose |
|---|---|---|
| `downloads.<domain>` | R2 custom domain (Cloudflare-managed) | Installer downloads |
| `api.<domain>` (optional, later) | CNAME → Railway service domain (Railway → Settings → Custom Domain) | Stable cloud API URL |

Using Railway's default `*.up.railway.app` URL is fine to start; add `api.<domain>` before hardcoding the URL into distributed desktop builds — a custom domain lets you migrate hosts without shipping a new app version.

---

## 6. CI/CD recommendations

Manual is fine now; when ready, GitHub Actions is the natural fit:

**Cloud (deploy on push to `main`, path-filtered to `apps/cloud/**`):** run `pytest` + `ruff`, then `railway up --service promptconnext-cloud` using a `RAILWAY_TOKEN` secret. Gate the production environment behind a manual approval (GitHub Environments).

**Desktop (release on tag `v*`):** matrix build — `macos-14` (arm64) now; add `windows-latest` / `ubuntu-latest` after closing the §3.2 gaps. Each job: install Node 24 + pnpm + Rust → `pnpm tauri build` → upload artifacts to R2 with the S3 action/CLI (secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`) → update `latest.json` last, only after all uploads succeed. Add checksum generation, and signing/notarization secrets once the Apple Developer account exists.

**Migrations:** keep applying manually via `scripts/migrate.py apply` (§2.2) before deploying code that needs them; automate later with a pre-deploy job.

---

## 7. Production checklist

- [ ] `scripts/migrate.py apply` run against the target database, `schema_version` on `/health` matches — including 0023 with its required `--var embed_dim=<N>` (§2.2), followed by a reindex
- [ ] `pz_schema_migrations` reflects this database's real history — for a database that had migrations applied before the ledger existed, that means `scripts/migrate.py adopt` (§2.2) ran once, not that it was silently skipped
- [ ] `AUTH_MODE=supabase`, `DATA_BACKEND=supabase`, `APP_ENV=production`
- [ ] service_role key set only in Railway variables — never in the repo or client
- [ ] Replicas = 1 (in-process presence/rate-limit state)
- [ ] `CORS_ORIGINS` includes the packaged app origin, excludes wildcards
- [ ] `SENTRY_DSN` set on the cloud service and `NEXT_PUBLIC_SENTRY_DSN` on both Vercel projects (`apps/web`, `apps/corp`) — unset means the SDK never initialises and the instance runs blind; the cloud logs a startup warning to that effect
- [ ] The scrubbing hook is on — `apps/cloud/app/observability.py` is what `sentry_sdk.init()` is called through, not a bare init, and `apps/cloud/tests/test_error_reporting.py` is green. Stack-frame locals, request bodies, `Authorization`/`X-User-Id` headers, log-record arguments, query strings and secret-bearing URL path segments must all be off; the web/corp equivalent is `src/lib/sentry.ts` in each app, covered by `src/lib/sentry.test.ts`. The URL rules are the ones worth re-reading before adding a route: a credential in a path or fragment has no key name for a denylist to match, which is how `/invitations/{token}/accept` and Supabase's `#access_token=` recovery link both leaked in review
- [ ] DMG uploaded to versioned R2 path + `checksums.txt` + `latest.json` updated
- [ ] Download page includes the Gatekeeper workaround note (until signing exists)
- [ ] Version bumped in `tauri.conf.json` and tagged in git
