# PromptWorkspace Deployment Guide

PromptConnext is the company; PromptWorkspace is the product this repository ships. Its live surfaces are:

1. **Cloud app** (`apps/cloud`) — FastAPI sync/collaboration backend → **Northflank**, one service per environment.
2. **Web app** (`apps/web`) — Next.js workspace UI → **Vercel** (project `promptworkspace-app`).
3. **VS Code extension** (`apps/vscode`) → Visual Studio Marketplace, ID `promptconnext.promptworkspace` (§3A).
4. **MCP server** (`apps/mcp`) → GitHub Release `mcp-v*` (§3A).

`apps/desktop` (Tauri) and `apps/engine` are renamed but **not deployed** (plan 0011, ADR 0028); `.github/workflows/desktop-build.yml` is `workflow_dispatch`-only. The corp site lives in [`PromptConnext/promptconnext-corp-web`](https://github.com/PromptConnext/promptconnext-corp-web).

Northflank (not Vercel) hosts the cloud app because it is a long-lived container with WebSockets (presence) and in-process state that requires a **single instance** — a poor fit for serverless. `apps/web` has none of those constraints (its only WebSocket use is a client-side connection *to* `apps/cloud`), so Vercel is a good fit — see [§2.8](#28-web-app-apps-web--vercel).

---

## 1. Environments

Two branch-mapped stacks, each with its own Vercel deployments, Northflank service and Supabase project. They never share a database. While plan 0029's work is in flight a temporary third stack exists for branch `feature/trust-outcome`; it follows the same rules and is described in [§8](#8-trust-test-environment-plan-0029).

| | `develop` (staging) | `main` (production) |
|---|---|---|
| Web | `https://promptworkspace.truthledgers.com` | `https://workspace.promptconnext.com` |
| Cloud API | `https://promptworkspace-api.truthledgers.com` | `https://workspace-api.promptconnext.com` |
| Corp | `https://promptconnext.truthledgers.com` | `https://promptconnext.com` |
| Northflank service | `promptworkspace` in project `promptworkspace` (runtime variables) | `promptworkspace-prod` in the same project (runtime variables) |
| Supabase project | `vndszeanigomqguhfmwc` (develop) | `promptworkspace-prod` (Pro plan, daily backups) |
| Auth email (custom SMTP) | sender on `truthledgers.com` | sender on `promptconnext.com` (staging sender until it is verified) |

Code reaches `main` only through a PR from `develop` (merge commit). The VS Code extension and the MCP server default to **production**; develop/staging is reached by overriding all four client settings (`cloudApiUrl`, `cloudWebUrl`, `supabaseUrl`, `supabaseAnonKey` — VS Code settings `promptworkspace.*`, or `PROMPTWORKSPACE_*` env for MCP). The defaults live once, in `packages/cloud-client/src/defaults.ts`.

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  VS Code ext / MCP server   │  HTTPS │  PromptWorkspace Cloud (Northflank)│
│  apps/web (Vercel)          │───────▶│  FastAPI, 1 instance              │
│                             │  WS    │  DATA_BACKEND=supabase            │
└─────────────────────────────┘        └──────────────┬───────────────────┘
                                                      │
                                       ┌──────────────▼───────────────┐
                                       │  Supabase (Postgres + Auth)  │
                                       └──────────────────────────────┘
```

---

## 2. Cloud app → Northflank

### 2.1 Prerequisites

- Northflank project `promptworkspace` with the two services from §1.
- A Supabase project per environment — record `SUPABASE_URL`, the **secret** key (`sb_secret_…`, or the legacy `service_role` JWT if the secret key is refused; cloud pins `supabase>=2.17,<3`, which accepts the new keys), the **publishable** key (`sb_publishable_…` or legacy `anon`) for the clients, and the **Session pooler** URI (IPv4; the direct host is IPv6-only).
- `psql` 10 or later locally for applying migrations.

### 2.2 Apply the schema

Migrations are plain SQL in `apps/cloud/migrations/`, applied by `apps/cloud/scripts/migrate.py` — a dependency-free wrapper around `psql` that reads the `pw_schema_migrations` ledger to know what is applied, applies only what is pending in numeric order, wraps each file in a transaction together with its ledger row, and refuses — before touching anything — if an applied file's checksum no longer matches.

The history was squashed on 2026-10-03 into a **two-file baseline**: `0001_pw_schema_migrations_ledger.sql` (the ledger table) and `0002_pw_baseline.sql` (the whole schema). The 36 files it replaces, with their apply-after-deploy procedures, live only in git tag `pre-promptworkspace-rename`. There is no `adopt` subcommand any more: with the ledger at number 1 there is no pre-ledger history to assert. Future migrations start at `0003_*` and are additive: `0003_pw_stage_inputs.sql` (Planner form answers, service-only grants) is the first. The API tolerates its absence — answers read empty and saves 503 `stage_inputs_unavailable` — so code may deploy before it is applied. `0004_pw_delivery_and_decisions.sql` (plan 0029: delivery changes, decisions, project roles; service-only grants) is the next. It does not have that tolerance: apply it before deploying code that writes `pw_tasks.change_id`. `0005_pw_service_role_grants.sql` is the latest: it grants `service_role` every `pw_` table, which new Supabase projects no longer do by default and which the presence socket, repository creation, the GitHub webhook, the RAG queue and the deployment reconciler need (without it they fail with `permission denied for table pw_workspace_members`). Additive and safe in any order; on an older project that kept the default grants it is a no-op. The baseline is generated by `scripts/baseline/build_baseline.py` (rerun it with `--check` to confirm the committed file is current), and `scripts/baseline/verify_squash.sh` proves it schema-equivalent to the token-mapped 36-file chain.

**One deliberate difference from the old chain: the ledger is closed to end users.** On the old chain `pw_schema_migrations` inherited `authenticated` DML from 0006's default privileges (the ledger, 0024, was created after them) and had no RLS, so on hosted Supabase it was reachable through the Data API. On the baseline the ledger is file 1, created before those defaults exist, and `0001_pw_schema_migrations_ledger.sql` ends in a labelled **post-squash hardening** block, generated by `build_baseline.py`: `alter table pw_schema_migrations enable row level security;` and `revoke all on pw_schema_migrations from anon, authenticated;`. `migrate.py` connects through `psql` as the table's owner (or a superuser), which RLS and these revokes do not restrict, so the runner reads and writes the ledger as before. `scripts/baseline/verify_squash.sh` treats this as the one checked exception: it asserts on the baseline database that `anon` and `authenticated` hold no select/insert/update/delete on the ledger and that RLS is on.

**Pre-baseline databases are reset, not migrated.** If `apply` finds the ledger under its pre-rename table name, it refuses with exit 2 ("pre-baseline database … reset it — fresh-start decision"). Nothing is migrated in place: reset that database and apply the baseline from scratch.

```bash
cd apps/cloud
python scripts/migrate.py --db-url "$POOLER_URL" apply --dry-run
python scripts/migrate.py --db-url "$POOLER_URL" apply --var embed_dim=1536
psql "$POOLER_URL" -c "select has_table_privilege('service_role','public.pw_workspace_members','select,insert,update,delete')"   # must print t
```

**`embed_dim` is required and must equal `MANAGED_EMBED_DIM`.** The baseline declares `migration-runner: requires-vars=embed_dim`, so `apply` refuses without it. The default for both environments is `1536` (OpenAI `text-embedding-3-small`; `gemini-embedding-001` truncated to 1536 also fits). Changing it later is destructive — embedded rows are deleted because a vector of one width cannot be reinterpreted at another — so choose the embedding model first. A workspace's own model connection (`POST /workspaces/{id}/model-connection`) must use the same `embed_dim`; a mismatch 409s with `embed_dim_mismatch`.

If the privilege check prints `f`, migration 0005 has not been applied. (It checks `pw_workspace_members` on purpose: the baseline grants `service_role` on the graph tables such as `pw_tasks` explicitly, so a check on those passes on a database that is missing the rest.)

**Confirm what the database has applied from its ledger, not from `/health`.** `/health.schema_version` is the stem of the newest migration file in the deployed image — the version the *code* expects — and never reads the database, so it now answers `"0004_pw_delivery_and_decisions"` whether or not 0004 was applied (it answered `"0003_pw_stage_inputs"` before plan 0029; and because the API tolerates a missing `pw_stage_inputs`, a missing 0003 looks fine too, while a missing 0004 fails every task write (`pw_tasks.change_id`: the Planner's tasks generation and save, and the sync push) as well as the delivery-plan and decision routes, so unlike 0003 it is not silent: apply it before deploying this code). The proof is `python scripts/migrate.py --db-url "$POOLER_URL" status`, which must list every file on disk under `Applied` and print `Pending (0)`, or the ledger itself:

```bash
psql "$POOLER_URL" -c "select filename, applied_at from pw_schema_migrations order by filename"   # last row: 0005_pw_service_role_grants.sql
```

### 2.3 Create the Northflank service

Per environment: Dockerfile `/apps/cloud/Dockerfile`, build context `/apps/cloud`, port `8080` HTTP public, readiness and liveness `GET /health` on 8080, **instances 1, autoscaling off**, stop-before-start/recreate if offered. Branch `develop` for service `promptworkspace`, `main` for `promptworkspace-prod` (both in Northflank project `promptworkspace`). Keep CI/auto-deploy **off** until that environment's schema is applied and its runtime variables are set; then enable it (or trigger builds manually). Custom domains: `promptworkspace-api.truthledgers.com` / `workspace-api.promptconnext.com`.

#### Region

The API and its Supabase project must run in the same region. Every repository call is one PostgREST request, and a single route makes several in sequence, so the distance between the two is paid many times per click. Today the Northflank services run in `europe-west4` (Netherlands) while the Supabase projects are in `ap-southeast-1` (Singapore), which costs roughly 170–200 ms per database call; on the trust stack a decision action took 6–10 s end to end before the plan 0029 round-trip fixes, and it is still bounded by that per-call cost. Create every new service in the database's region, and move the existing ones.

Northflank cannot move a running service between regions, so a move is a rebuild beside the old service followed by a DNS switch. Whether the plan offers an Asia-Southeast (Singapore) region is **not verified** — check in Northflank before starting.

1. Lower the TTL on the API's CNAME (e.g. to 60 s) a day ahead, so the switch propagates quickly and a rollback is just as fast.
2. Create a Northflank project in the Asia-Southeast (Singapore) region, if the plan offers it.
3. Recreate each service there with identical build settings (§2.3: Dockerfile, context, branch, port, health checks, 1 instance, autoscaling off) and identical runtime variables (§2.4). **Reuse the same `RAG_KEY_ENCRYPTION_KEY` for each environment**: workspace model keys and GitHub tokens are stored encrypted under it, and a new key makes every stored credential unreadable.
4. Attach the same custom domain to the new service and verify it in Northflank.
5. Switch the CNAME to the new service's target, then check `curl -s $API/health` (§2.6) reports the expected `env` and `schema_version`, and that sign-in and one project page load in the web app.
6. Delete the old service once the new one has served traffic cleanly, then restore the TTL.

Webhook URLs registered with GitHub (`PUBLIC_API_URL`) and the web app's `NEXT_PUBLIC_CLOUD_*` variables do not change, because the domain does not.

### 2.4 Environment variables (Northflank → service → Runtime variables)

Production values (develop differs only where noted in §2.7):

| Variable | Value | Notes |
|---|---|---|
| `DATA_BACKEND` | `supabase` | `memory` loses all data on restart — dev only |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | |
| `SUPABASE_KEY` | secret key (`sb_secret_…`, or legacy `service_role` JWT) | Server-side only; requests are re-scoped to the caller's JWT |
| `AUTH_MODE` | `supabase` | `stub` (X-User-Id header) must never reach production |
| `SUPABASE_JWT_SECRET` | **optional — leave unset** | Legacy HS256 fallback only; JWKS via `SUPABASE_URL` is the default path |
| `APP_ENV` | `production` | |
| `LOG_LEVEL` | `INFO` | |
| `CORS_ORIGINS` | `https://workspace.promptconnext.com` | The environment's own web origin only — see [§2.8](#28-web-app-apps-web--vercel) |
| `RATE_LIMIT_ENABLED` | `true` | |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_BURST` | `300` / `60` | Defaults are fine to start |
| `WS_HEARTBEAT_SECONDS` | `20` | |
| `WS_MAX_CONNECTIONS_PER_PROJECT` | `50` | |
| `TOMBSTONE_TTL_DAYS` | `30` | `0` disables the GC loop |
| `TOMBSTONE_GC_INTERVAL_SECONDS` | `3600` | |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` | as needed | Only if the Jira mirror (M5) is in use — the *outbound* credential. There is no longer a `JIRA_WEBHOOK_SECRET`: since plan 0019 the *inbound* secret is generated per Atlassian site when an admin configures the integration and stored encrypted in `pw_workspace_integrations`, because one shared secret cannot tell two tenants apart and a Jira issue key is unique per site, not per provider. ClickUp is registered but not advertised or configurable (`provider_unavailable`) until it has a credential path of its own. |
| `RAG_KEY_ENCRYPTION_KEY` | Fernet key, one per environment | **Required: the service refuses to start with `DATA_BACKEND=supabase` and no key.** It encrypts workspace PATs, model keys and webhook secrets; losing it bricks every stored credential, so keep an offline copy per environment in the team password manager. Generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. |
| `WEB_APP_URL` | `https://workspace.promptconnext.com` | Base for every invitation accept link — both the URL emailed to the invitee and the `accept_url` handed to the admin who created the invite. **Required in production:** the default is `http://localhost:3000`, so leaving it unset mails invitees a link to their own machine and the invitation silently dead-ends. `{WEB_APP_URL}/invite/*` must also be allow-listed in Supabase → Authentication → URL Configuration → Redirect URLs, as a `/**` wildcard — see [§2.8](#28-web-app-apps-web--vercel). |
| `PUBLIC_API_URL` | **this** service's origin, `https://workspace-api.promptconnext.com` | Callback base for per-repo GitHub webhooks (`{PUBLIC_API_URL}/api/webhooks/github`). The cloud origin, not the web one — easy to confuse with `WEB_APP_URL` above. GitHub POSTs to it directly, so it must be publicly reachable over HTTPS. Leaving it empty is a valid launch choice — repo creation and seeding still work, only PR/push indexing stays dormant — but **it does not apply retroactively**: hooks are registered once, at repo creation, so any repo created while this is unset never gets one and there is no backfill. Set it before real projects start creating repos. There is **no** platform GitHub credential to configure; each workspace supplies its own fine-grained PAT in workspace settings, encrypted with `RAG_KEY_ENCRYPTION_KEY` (ADR 0017 amendment). |
| `DEPLOY_R2_*` | see `apps/cloud/.env.example` | Only for the platform-hosted deployment template (ADR 0021). `DEPLOY_R2_API_TOKEN` is account-wide and is used **only** to mint a per-workspace, bucket-scoped credential — only the minted one is ever written into a customer repository, because a repo secret is readable by anyone who can push to that repo. `DEPLOY_R2_PUBLIC_BASE_URL` is required for that template: without it there is no preview address to hand the pipeline and repo creation refuses with `deployment_preview_url_not_configured`. Leave the block empty to disable the template entirely (it then refuses with `deployment_provider_not_configured` rather than seeding a pipeline that could never succeed). **Never set `DEPLOY_R2_ALLOW_SHARED_KEY=true` outside local dev** — it seals one shared key into every repository. |
| `TYPESAFE_API_KEY` | TypeSafe API key | **Optional.** Enables the typed judgment that picks the docker-compose template's runtime and services from a project's plan (`app/deployments/stack_judge.py`, ADR 0026's 2026-09-26 amendment). Unset keeps the keyword scan. `TYPESAFE_BASE_URL`/`TYPESAFE_MODEL` default correctly. Platform-held, like `MANAGED_MODEL_API_KEY`. |

The managed tier also needs `MANAGED_MODEL_*`, `MANAGED_EMBED_*` (with `MANAGED_EMBED_DIM` equal to the migration's `embed_dim`) and `MANAGED_DAILY_TOKEN_BUDGET` — see below and `apps/cloud/.env.example`. The Dockerfile honours `PORT` and defaults to 8080.


### Deployment templates and the workspace GitHub token (ADR 0021)

Selecting a deployment template makes the cloud write GitHub Actions **secrets and variables** into each new project repository, which the workspace's fine-grained PAT must be permitted to do. That is a permission most existing tokens do not carry, and GitHub offers no way to read a fine-grained token's own scopes — so it cannot be checked when the token is connected. A stale token connects cleanly, works for months, and then fails at repo creation with `github_secrets_not_in_token_scope`. Before enabling deployment templates for real projects, ask workspace admins to reissue their tokens with **Secrets** and **Variables** write access alongside Contents, Administration and Webhooks. The full fine-grained permission list for a workspace PAT is: **Contents RW, Administration RW, Webhooks RW, Secrets RW, Variables RW, Metadata R, Pull requests R**.

Repositories created before ADR 0021 carry webhooks subscribed only to `push` and `pull_request`, so no deploy they run will ever be visible in the cloud. Re-running repo creation does not fix this — that route returns early for a project already at `repo_created`, and hook registration treats GitHub's "already exists" response as success. `POST /projects/{id}/deployment/repair-webhook` (workspace admin) is the migration path: it widens the existing hook's event list in place, leaving its signing secret untouched, and is idempotent.

One network note for production. After a successful deploy the cloud makes a single outbound request to the deployed preview URL, to read whether it permits being embedded — a question no browser can answer for a cross-origin frame. That URL is reported by the project's own workflow, so it is attacker-chosen input from anyone with push access to a project repository. The code refuses to probe any hostname resolving to a loopback, private, link-local, reserved or multicast address and follows no redirects, which blocks the direct request-forgery path. It cannot, on its own, close DNS rebinding between the resolution and the connection. If the cloud runs anywhere with reachable internal services or an instance-metadata endpoint, put its egress behind a proxy that enforces the same public-address rule at the network layer.

The cloud Planner UI (the web app's stage-generation tab, `apps/cloud/app/api/generation.py`) has no BYO-model fallback: `select_model()` (`apps/cloud/app/generation/routing.py`) returns whatever `build_managed_connection()` (`apps/cloud/app/generation/managed.py`) produces from `MANAGED_MODEL_ENABLED` and `MANAGED_MODEL_API_KEY`, and returns nothing at all if either is unset. `apps/cloud/.env.example` ships `MANAGED_MODEL_ENABLED=false` by default, so a deployment that only follows the table above will have a Planner tab that fails closed on every request. Treat `MANAGED_MODEL_ENABLED=true` plus a valid `MANAGED_MODEL_API_KEY` as required, not optional, before telling users the Planner is available — set both explicitly in the Northflank runtime variables alongside the settings above.

Turning on `MANAGED_MODEL_ENABLED` covers the Planner's *generation* path, but the RAG assistant's *retrieval* path needs a second, separate setting: Typhoon is chat-only, so a keyless workspace's content questions (anything grounded in synced documents or code, as opposed to task status or lineage) are answered by `build_managed_embed_connection()` (`apps/cloud/app/generation/managed.py`), which reads `MANAGED_EMBED_BASE_URL`, `MANAGED_EMBED_MODEL`, and `MANAGED_EMBED_API_KEY`. Leave any of those unset and it silently returns `None` — `app/api/assistant.py` then skips retrieval entirely, and every content question comes back with a fluent "I don't have enough information" that is indistinguishable from a working assistant that genuinely doesn't know. The app now logs a startup WARNING when this combination occurs (`MANAGED_MODEL_ENABLED=true` with no embed connection resolved), but don't wait to see it in the logs — set the three `MANAGED_EMBED_*` variables in the Northflank runtime variables alongside `MANAGED_MODEL_*` whenever the managed tier is on. `apps/cloud/.env.example` documents the constraint that matters most when picking a model: `pw_rag_chunks.embedding` is a `vector(embed_dim)` column fixed at migration time (§2.2), so the embedding model's output dimension must equal that `embed_dim` (1536 by default) — most open multilingual encoders (BGE-m3, Jina v3, KaLM-embedding-multilingual) do not fit that, and OpenAI's `text-embedding-3-small`, Google's `gemini-embedding-001` (MRL-truncated to 1536), and `Alibaba-NLP/gte-Qwen2-1.5B-instruct` are known-good options instead.

### 2.5 Scaling constraints — important

Presence, rate-limit, metrics, the RAG embed queue, and the RAG daily token
budget are all **in-process**. Until a shared backplane (e.g. Redis) exists:

- **Replicas = 1.** Do not scale horizontally.
- Northflank routes all traffic to the single instance, so session affinity is a non-issue at 1 instance — but revisit before ever raising the instance count. A rolling deploy briefly overlaps two instances; the `instance_id` alarm below fires once per deploy for that reason.
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

**The alarm.** Nothing in this repository talks to an uptime-monitoring service; wire the following into whichever one you already use (Better Uptime, UptimeRobot, Pingdom, a Northflank health check), polling `/health` every 60 s:

- **Two concurrent polls returning different `instance_id`s ⇒ more than one instance is serving traffic.** Page on it: that is the condition all four components above break under, and it is the closest thing to a replica-count alarm that exists, because **a process cannot count its own peers.** There is no discovery mechanism here, no registry, and nothing the container platform guarantees to set to the current replica count, so the service does not report a `replicas` field rather than report a guess. `instance_id` is minted once per process, which makes "how many replicas?" answerable from outside by comparison alone.
- **`instance_id` changed between two sequential polls ⇒ the single instance restarted.** Not an error by itself (a deploy does this), but it drops every queued embed job and empties every presence room, so an unexplained change is worth an alert.
- **`capacity.queue.depth` non-zero and not decreasing across 3 consecutive polls ⇒ the embed worker is stuck or jobs are being discarded.** A legitimate backfill sweep queues hundreds and drains steadily, so test the trend, not the value. Confirm the cause with `GET /projects/{id}/assistant/index-status`, whose `last_error` distinguishes "still draining" from "thrown away for want of a model connection".
- **`capacity.budget.headroom_fraction` below `0.1` ⇒ the busiest workspace is about to start getting 429s** from the Planner and the assistant, and on the managed tier that number is also the day's spend. Below `0.0`-adjacent values it is already blocked.
- **`capacity.presence.connections` climbing toward `WS_MAX_CONNECTIONS_PER_PROJECT` × active projects** is the only saturation signal presence has; a room at capacity rejects new sockets with close code 1013.

The rate limiter is the one component with no counter of its own: a bucket count measures how many clients have been seen, not how close anything is to a limit, and its multi-instance failure is caught by the `instance_id` check like everything else that degrades quietly.

### 2.6 Verify

```bash
API=https://workspace-api.promptconnext.com    # or https://promptworkspace-api.truthledgers.com
curl -sSf $API/health | jq '{env, schema_version}'   # "production"/"staging", "0005_pw_service_role_grants" (the code's expected version — not proof the DB has it; see §2.2)
curl -si -X OPTIONS -H "Origin: https://workspace.promptconnext.com" -H "Access-Control-Request-Method: GET" $API/health | grep -i '^access-control-allow-origin'
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/webhooks/github   # 400/401 for an unsigned request, not 404
```

### 2.7 Develop vs production values

| | `develop` | `main` |
|---|---|---|
| `APP_ENV` | `staging` | `production` |
| `LOG_LEVEL` | `DEBUG` | `INFO` |
| `SUPABASE_URL` / `SUPABASE_KEY` | develop project | prod project |
| `CORS_ORIGINS`, `WEB_APP_URL` | `https://promptworkspace.truthledgers.com` | `https://workspace.promptconnext.com` |
| `PUBLIC_API_URL` | `https://promptworkspace-api.truthledgers.com` | `https://workspace-api.promptconnext.com` |
| `RAG_KEY_ENCRYPTION_KEY` | develop key | prod key (never the same) |
| `MANAGED_EMBED_*` | a free 1536-dim model if supported, else the prod model | OpenAI `text-embedding-3-small`, `MANAGED_EMBED_DIM=1536` |
| Deploys | auto-deploy from `develop` | first build triggered by hand after the schema and the merge; then optional auto-deploy from `main` |

Never share a Supabase project between environments — migrations and tombstone GC would collide.

#### Auth email (custom SMTP)

Supabase's built-in sender only delivers to members of the Supabase org, so each project needs custom SMTP for confirmations, invitations and password resets: Supabase → Authentication → SMTP Settings. Every value (host, port, user, password, sender name and address) is per-environment provider configuration; nothing in this repo hard-codes a mail provider. Today both environments use Brevo (`smtp-relay.brevo.com:587`) with the `truthledgers.com` sender, until a `promptconnext.com` sender is verified for production. Email templates use `{{ .SiteURL }}`/`{{ .ConfirmationURL }}`, so links follow each project's Site URL.

### 2.8 Web app (`apps/web`) → Vercel

`apps/web` (M8) is a read-only Next.js client of `apps/cloud` — no server-side
secrets, no WebSocket server of its own (presence is a client-side connection
*to* `apps/cloud`), so it deploys as a normal static/SSR Vercel project.

1. Vercel project `promptworkspace-app`: Root Directory `apps/web`, "Include
   files outside Root Directory" on, install command
   `corepack enable && pnpm install --frozen-lockfile --filter @promptworkspace/web...`,
   Production Branch `main`. The `develop` branch is attached to
   `promptworkspace.truthledgers.com` with Preview-scoped env vars; the
   Ignored Build Step builds only `main` and `develop` (plus `feature/trust-outcome` while that temporary stack exists, [§8](#8-trust-test-environment-plan-0029)).
2. Environment variables (Vercel → project → Settings → Environment
   Variables), mirroring `apps/web/.env.example`:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_CLOUD_API_URL` | `https://workspace-api.promptconnext.com` (Preview/`develop`: `https://promptworkspace-api.truthledgers.com`) |
   | `NEXT_PUBLIC_CLOUD_WS_URL` | `wss://workspace-api.promptconnext.com` (develop: `wss://promptworkspace-api.truthledgers.com`) |
   | `NEXT_PUBLIC_AUTH_MODE` | `supabase` |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable/anon key (safe to expose client-side) |

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

### 2.9 Corp app → Vercel

Moved 2026-10-01 to [`PromptConnext/promptconnext-corp-web`](https://github.com/PromptConnext/promptconnext-corp-web), a standalone repo with its own `vercel.json`, `.env.example` and CI. Import that repo in Vercel at its root (no Root Directory override). Its deployment notes live in its README.

---

## 3. Desktop app → build installers

### 3.1 macOS (Apple Silicon) — supported today

Prereqs on the build machine: Node ≥ 24 (its version/arch becomes the app runtime), pnpm, Rust (rustup), Xcode CLT. Full detail in [`BUILD_AND_DISTRIBUTE.md`](./BUILD_AND_DISTRIBUTE.md).

```bash
pnpm install
cd apps/desktop
pnpm tauri build
```

Output: `apps/desktop/src-tauri/target/release/bundle/macos/PromptWorkspace.app` (~192 MB, self-contained engine + bundled Node).

**Produce a DMG for distribution** — add `"dmg"` to bundle targets in `src-tauri/tauri.conf.json`:

```json
"bundle": { "targets": ["app", "dmg"] }
```

Rebuild; the `.dmg` lands in `bundle/dmg/`.

**Unsigned-app reality:** without an Apple Developer account, Gatekeeper blocks downloaded copies. Ship with instructions for testers:

```bash
xattr -dr com.apple.quarantine /Applications/PromptWorkspace.app
```

or right-click → Open → Open. When you get an Apple Developer account later: set `bundle.macOS.signingIdentity` in `tauri.conf.json`, export `APPLE_ID`, `APPLE_PASSWORD` (app-specific) or `APPLE_API_KEY`, and `APPLE_TEAM_ID`, and Tauri signs + notarizes during `tauri build`. Treat signing as a prerequisite for any public (non-tester) distribution.

### 3.2 Windows — via CI (Linux still not supported)

Windows can't be built locally on an M1 (Tauri's MSI/WiX path doesn't run on macOS at all, and the NSIS cross-compile route is experimental) — it ships from `.github/workflows/desktop-build.yml`, a `macos-latest` + `windows-latest` matrix using `tauri-apps/tauri-action`. Trigger with `gh workflow run desktop-build.yml` — the workflow is dispatch-only, so no tag push starts it. Full detail (why CI and not local cross-compile, and the experimental local route for debugging) is in [`DEVELOPMENT.md` — Build target 3](./DEVELOPMENT.md#build-target-3--windows-from-the-m1-use-ci-recommended).

The three app-level gaps this required are closed:

1. `stage:engine` and `scripts/bundle-node.mjs` are platform-aware (`node.exe` on Windows, cross-platform staged-dir cleanup instead of `rm -rf`).
2. `tauri.conf.json` `bundle.targets` includes `"nsis"`.
3. `apps/engine/src/keychain.ts` has a Windows path (DPAPI via PowerShell, user-scoped, no native addon) alongside the macOS `security` CLI path.

`node-pty` native prebuilds are still handled correctly because CI runs the hoisted `pnpm deploy` on the target OS itself (§6/§3.2 of `DEVELOPMENT.md`) — no cross-compilation of the engine is attempted.

**Linux is not yet supported**: no bundle target (`"deb"`/`"appimage"`), no libsecret keychain path, and the build machine would need WebKit dev headers (`libwebkit2gtk-4.1-dev`). List it as "coming soon" on the download page until that work happens.

### 3.3 Versioning

`apps/desktop` is not deployed at present (plan 0011, ADR 0028). If it is built, bump `version` in `apps/desktop/src-tauri/tauri.conf.json` (and keep `apps/desktop/package.json` in sync) first. Use the version in the uploaded filename (below) so URLs are immutable.

---

## 3A. VS Code extension and MCP server

### VS Code extension (`apps/vscode`) → Marketplace + Open VSX

The extension ID is **`promptconnext.promptworkspace`** (`"publisher": "promptconnext"`, name `promptworkspace`). It is a new listing: Marketplace IDs are immutable, so the pre-rename listing (its ID is in tag `pre-promptworkspace-rename`) is deprecated in favour of it (publisher manage page → the old item → Deprecate → "in favour of another extension"), later Unpublished — never Removed, which would reserve the name for ever. The extension has no bundled runtime and spawns no executable, so there is nothing to sign.

```bash
pnpm --dir apps/vscode typecheck
pnpm --dir apps/vscode test
pnpm --filter promptworkspace run package    # → apps/vscode/promptworkspace-<version>.vsix
```

Gate before publishing: install the VSIX with **no setting overrides**, sign in against production, and see your tasks. The four defaults (`promptworkspace.cloudApiUrl`, `cloudWebUrl`, `supabaseUrl`, `supabaseAnonKey`) are copies of `packages/cloud-client/src/defaults.ts`, and that package's `defaults.test.ts` (in CI) fails while either side drifts.

**Release gate: production defaults must be filled.** Until the production Supabase project exists, `supabaseUrl` and `supabaseAnonKey` in `packages/cloud-client/src/defaults.ts` are `__PROD_*` placeholders. CI stays green with them, but packaging does not: `packages/cloud-client/scripts/assert-defaults-filled.mjs` exits non-zero while any placeholder (or an empty value, or a `supabaseUrl` that is not `https://<ref>.supabase.co`) remains. It runs from `vscode:prepublish` in `apps/vscode` (so `pnpm --filter promptworkspace run package` and `vsce publish` both stop) and from `prepack` in `apps/mcp` (so `pnpm pack` stops). Run it by hand with `pnpm --filter @promptworkspace/cloud-client run assert-defaults-filled`. Fill the real values, then copy them into the four `apps/vscode/package.json` defaults; `defaults.test.ts` confirms the copies match. Never bypass the gate: an extension shipped with placeholders points at a URL that does not resolve.

**Publish from Linux or macOS, never Windows.** Packaging on Windows strips the POSIX executable bit from bundled files.

```bash
npx @vscode/vsce publish --packagePath promptworkspace-<version>.vsix    # Microsoft Marketplace
npx ovsx publish promptworkspace-<version>.vsix -p "$OVSX_TOKEN"         # Open VSX (Cursor, Windsurf, VSCodium)
git tag vscode-v<version> && git push origin vscode-v<version>
```

- The extension ID is baked into the sign-in callback URI (`src/auth/signIn.ts::EXTENSION_ID`) and the web app's tests; changing it again breaks in-flight sign-ins.
- Global Azure DevOps PATs retire **2026-12-01**; verify publisher access with `npx @vscode/vsce verify-pat <publisher>` (the `publisher` in `apps/vscode/package.json`) and move to Entra ID (`--azure-credential`) before then.
- **Marketplace Participation Policies §3(b)**: the listing may not promote other IDE offerings. That pitch belongs on the corp site.

Bumping `version` in `apps/vscode/package.json` is the release process — installed extensions auto-update from the registry.

### MCP server (`apps/mcp`) → GitHub Release

`@promptworkspace/mcp`, binary `promptworkspace-mcp`, config dir `promptworkspace-mcp` (XDG, or `%APPDATA%` on Windows), env overrides `PROMPTWORKSPACE_*`. It ships as a GitHub Release, not to npm (yet); users install the tarball with `npm i -g ./promptworkspace-mcp-<version>.tgz` (see `apps/mcp/README.md`). `pnpm pack` runs the same defaults gate as the extension (above) via `prepack`.

```bash
pnpm --filter @promptworkspace/mcp build && (cd apps/mcp && pnpm pack)   # → promptworkspace-mcp-<version>.tgz (files: dist only)
docker run --rm -v "$PWD/apps/mcp:/w" node:22 sh -c 'npm i -g /w/promptworkspace-mcp-<version>.tgz && promptworkspace-mcp --help'
gh release create mcp-v<version> --repo PromptConnext/PromptWorkspace --target main \
  apps/mcp/promptworkspace-mcp-<version>.tgz apps/mcp/dist/index.js
```

**Release tags are product-prefixed** (`vscode-v*`, `mcp-v*`), never bare `v*`.

---

## 4. Publish installers to Cloudflare R2

### 4.1 One-time bucket setup

1. Cloudflare dashboard → **R2 Object Storage** → Create bucket, e.g. `promptworkspace-releases`. Location: automatic.
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
aws s3 cp apps/desktop/src-tauri/target/release/bundle/dmg/PromptWorkspace_${VERSION}_aarch64.dmg \
  s3://promptworkspace-releases/desktop/${VERSION}/PromptWorkspace_${VERSION}_macos-arm64.dmg \
  --profile r2 --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --content-type application/x-apple-diskimage
```

Alternatively with Wrangler: `wrangler r2 object put promptworkspace-releases/desktop/${VERSION}/... --file=...`.

### 4.3 Suggested layout

```
desktop/
  latest.json                        # {"version":"0.0.1","macos-arm64":"https://downloads.../PromptWorkspace_0.0.1_macos-arm64.dmg"}
  0.0.1/
    PromptWorkspace_0.0.1_macos-arm64.dmg
    checksums.txt                    # shasum -a 256 *.dmg
```

Versioned paths are immutable (cache-friendly); `latest.json` is the one mutable pointer a download page or future in-app updater reads. Always publish `checksums.txt` — especially while builds are unsigned.

---

## 5. DNS summary

| Host | Target | Env |
|---|---|---|
| `promptworkspace.truthledgers.com` | CNAME → Vercel (`promptworkspace-app`, branch `develop`) | develop |
| `promptconnext.truthledgers.com` | CNAME → Vercel (`promptconnext-corp-web`, branch `develop`) | develop |
| `promptworkspace-api.truthledgers.com` | CNAME → Northflank `promptworkspace` + verification TXT | develop |
| `promptworkspace-trust.truthledgers.com` | CNAME → Vercel (`promptworkspace-app`, branch `feature/trust-outcome`); temporary, [§8](#8-trust-test-environment-plan-0029) | trust |
| `promptworkspace-trust-api.truthledgers.com` | CNAME → Northflank `promptworkspace-trust` + verification TXT; temporary, [§8](#8-trust-test-environment-plan-0029) | trust |
| `workspace.promptconnext.com` | CNAME → Vercel (`promptworkspace-app`, Production) | main |
| `promptconnext.com` / `www` | A `76.76.21.21` (or Vercel ALIAS) / CNAME → Vercel, `www` 308 → apex | main |
| `workspace-api.promptconnext.com` | CNAME → Northflank `promptworkspace-prod` + verification TXT | main |

Plus each mail domain's SPF/DKIM records exactly as the SMTP provider displays them. CAA, if present, must allow `letsencrypt.org`.

---

## 6. CI/CD

`.github/workflows/ci.yml` runs on every `pull_request` and on `push` to `main` and `develop`, gated by a computed path-diff so an unrelated change never runs an unrelated suite. Jobs: `cloud` (`ruff check .` then `pytest`), `engine`, `web`, `vscode`, `mcp`, `cloud-client`, `rename-gate` (the PromptWorkspace rename gate, `scripts/rename/check.py` plus its fixture tests, unfiltered), and **`ci-required`**, an always-running aggregate that fails if any job it needs failed or was cancelled. Branch protection requires `ci-required` only, because a path-filtered job that was skipped would otherwise count as a missing check.

`.github/workflows/cloud-contract.yml` brings up a local Supabase stack (`supabase start` + `scripts/migrate.py apply`) and runs the `contract` and `rls` suites — nightly, on demand, and on any change under `apps/cloud/app/db/**`, `apps/cloud/migrations/**` or `apps/cloud/tests/{contract,rls}/**`, on PRs and on pushes to `main`/`develop`. It is path-filtered at workflow level, so it cannot be a required check.

Neither workflow deploys: Vercel's git integration and Northflank's per-service build settings do. `desktop-build.yml` is `workflow_dispatch`-only.

**Migrations:** apply manually with `scripts/migrate.py apply --var embed_dim=<N>` (§2.2) before deploying code that needs them, develop first, then production with the identical command.

---

## 7. Production checklist

- [ ] `scripts/migrate.py apply --var embed_dim=<N>` run against the prod pooler URI; `<N>` equals `MANAGED_EMBED_DIM`; `scripts/migrate.py status` against the same URI prints `Pending (0)` with `0003_pw_stage_inputs.sql` through `0005_pw_service_role_grants.sql` under `Applied` (`/health.schema_version` only names the version the code expects, not what the DB has); the service_role privilege check prints `t` (§2.2)
- [ ] `AUTH_MODE=supabase`, `DATA_BACKEND=supabase`, `APP_ENV=production`, `RAG_KEY_ENCRYPTION_KEY` set (the service refuses to boot without it) and backed up offline
- [ ] Secret key set only in the Northflank runtime variables — never in the repo or a client; clients get only the publishable key
- [ ] Instances = 1 (in-process presence/rate-limit state)
- [ ] `CORS_ORIGINS` and `WEB_APP_URL` are the environment's own web origin; `PUBLIC_API_URL` its own API origin
- [ ] Supabase Auth: Site URL and `/**` Redirect URLs for the environment's web origin; custom SMTP set; prod backups on; signup closed once the team has registered (members join by invite)
- [ ] `SENTRY_DSN` set on the cloud service and `NEXT_PUBLIC_SENTRY_DSN` on both Vercel projects (`apps/web`, promptconnext-corp-web) — unset means the SDK never initialises and the instance runs blind; the cloud logs a startup warning to that effect
- [ ] The scrubbing hook is on — `apps/cloud/app/observability.py` is what `sentry_sdk.init()` is called through, not a bare init, and `apps/cloud/tests/test_error_reporting.py` is green. Stack-frame locals, request bodies, `Authorization`/`X-User-Id` headers, log-record arguments, query strings and secret-bearing URL path segments must all be off; the web equivalent is `src/lib/sentry.ts`, covered by `src/lib/sentry.test.ts`
- [ ] The production web bundle contains no `truthledgers`; the staging bundle no `workspace-api.promptconnext.com`
- [ ] VSIX installed with no overrides signs in against production before `vsce publish`

## 8. Trust test environment (plan 0029)

A third, short-lived stack for the agent-native delivery work in [plan 0029](plans/0029-agent-native-delivery.md). It tracks branch `feature/trust-outcome`, never shares a database with staging or production (company ADR 0003, amended 2026-10-04), and is torn down when the branch merges into `develop`.

| Piece | Value |
|---|---|
| Branch | `feature/trust-outcome` |
| Web | `https://promptworkspace-trust.truthledgers.com` (Vercel project `promptworkspace-web`, branch domain) |
| API | `https://promptworkspace-trust-api.truthledgers.com` (Northflank service `promptworkspace-trust` in project `promptworkspace`, 1 instance) |
| Database | Supabase project `promptworkspace-trust` (Free plan, region ap-southeast-1) |
| Extra setting | `REQUIRE_PLAN_APPROVAL=true` |

### 8.1 Provisioning checklist (dashboard steps, in order)

1. **Supabase.** Create project `promptworkspace-trust` (same org as `promptworkspace-develop`, Singapore, Free). Save the DB password. Record `SUPABASE_URL`, the secret key, the publishable key, the JWT secret and the **Session pooler** URI.
   - Auth → URL Configuration: Site URL `https://promptworkspace-trust.truthledgers.com`; Redirect URLs `https://promptworkspace-trust.truthledgers.com/**` and `http://localhost:3000/**`.
   - Auth → SMTP: the same Brevo settings as develop, sender name `PromptWorkspace (trust)`.
2. **Schema, before any deploy.** From `apps/cloud`:
   `python scripts/migrate.py --db-url "$TRUST_POOLER_URL" apply --var embed_dim=1536`, then `python scripts/migrate.py --db-url "$TRUST_POOLER_URL" status` must list `0005_pw_service_role_grants` as applied, and the §2.2 privilege check must print `t`.
3. **Northflank.** In project `promptworkspace`, duplicate service `promptworkspace` as `promptworkspace-trust`: branch `feature/trust-outcome`, same Dockerfile/context/port/health checks, instances 1, autoscaling off. Runtime variables: copy from `promptworkspace`, then change `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_JWT_SECRET`, `CORS_ORIGINS=https://promptworkspace-trust.truthledgers.com`, `WEB_APP_URL=https://promptworkspace-trust.truthledgers.com`, `PUBLIC_API_URL=https://promptworkspace-trust-api.truthledgers.com`, a **new** `RAG_KEY_ENCRYPTION_KEY`, `APP_ENV=trust`, and add `REQUIRE_PLAN_APPROVAL=true`. Custom domain `promptworkspace-trust-api.truthledgers.com`. Enable CI auto-deploy only after step 2.

   `APP_ENV` has to be changed because the copy inherits develop's `staging`, and `/health` would then report `"env": "staging"` for the trust stack. Only the exact value `production` (compared case- and whitespace-insensitively) changes the cloud's behaviour, through its startup guards, so any other label is safe. Beyond that guard `APP_ENV` only labels the stack: the `env` field of `/health` and the `environment` tag on Sentry events, which is what keeps trust errors apart from develop's.

   Copying `promptworkspace`'s runtime variables also copies its managed-model settings, so the trust stack shares develop's managed-model (Typhoon) key and daily token budget. Each service enforces `MANAGED_DAILY_TOKEN_BUDGET` in its own process, so neither sees the other's spend, but both draw on the one upstream key and its quota. Give the trust service its own `MANAGED_MODEL_API_KEY` if quota contention matters.
4. **Vercel** (project `promptworkspace-web`):
   - Settings → Git → Ignored Build Step: add `feature/trust-outcome` to the branches that build. With a custom command: `if [[ "$VERCEL_GIT_COMMIT_REF" =~ ^(main|develop|feature/trust-outcome)$ ]]; then exit 1; else exit 0; fi` (exit 1 means "build").
   - Settings → Environment Variables, scope **Preview**, branch `feature/trust-outcome`: `NEXT_PUBLIC_CLOUD_API_URL=https://promptworkspace-trust-api.truthledgers.com`, `NEXT_PUBLIC_CLOUD_WS_URL=wss://promptworkspace-trust-api.truthledgers.com`, `NEXT_PUBLIC_AUTH_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the trust project's publishable key).
   - Settings → Domains: add `promptworkspace-trust.truthledgers.com` and connect it to Git branch `feature/trust-outcome`.
5. **DNS** (truthledgers.com, proxy off): `promptworkspace-trust` CNAME → the Vercel target; `promptworkspace-trust-api` CNAME → the Northflank target.
6. **Smoke check:** `curl -s https://promptworkspace-trust-api.truthledgers.com/health` reports `schema_version` `0005_pw_service_role_grants` and `"env": "trust"`, and the web origin returns 200.

### 8.2 Teardown

When `feature/trust-outcome` merges into `develop`:

1. Apply migration 0004 to develop's database **before** the merge deploys (§2.2).
2. Revert the temporary branch from the CI push triggers: remove `feature/trust-outcome` from `branches:` under `push` in `.github/workflows/ci.yml` and `.github/workflows/cloud-contract.yml`.
3. Revert the Vercel Ignored Build Step edit (back to `main` and `develop` only), then delete the Vercel branch domain and the Preview env vars scoped to `feature/trust-outcome`.
4. Delete the Northflank service `promptworkspace-trust`.
5. Delete both DNS records (`promptworkspace-trust` and `promptworkspace-trust-api`).
6. Delete the Supabase project `promptworkspace-trust` no sooner than 14 days after the merge. The wait is a grace period: the project holds the test projects, decisions and approvals from the trial, and this is the window to export anything worth keeping. If nothing there is worth recovering, drop it sooner.
