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

Migrations are plain SQL in `apps/cloud/migrations/`, applied in order:

```bash
cd apps/cloud
for f in migrations/00*.sql; do
  psql -v ON_ERROR_STOP=1 "$SUPABASE_DB_URL" -f "$f" || { echo "migration failed: $f" >&2; break; }
done
```

`SUPABASE_DB_URL` is the direct Postgres connection string (Supabase → Settings → Database). Migration 0003 installs the RLS policies that back workspace membership — do not skip it. (The glob is `00*.sql`, not `000*.sql` — migration numbers passed 0009 long ago, and the tighter pattern silently stops matching anything from 0010 on.)

**Migration 0023 is not part of that loop — run it by hand, in its numeric place.** It replaces the embedding column's fixed `vector(1536)` width with a deploy-time parameter (there is no `1536` baked into the schema anymore), and doing so is destructive: any already-embedded `pz_rag_chunks`/`pz_code_chunks` rows are deleted, because a vector computed at one width cannot be reinterpreted at another. Apply everything up to 0022 with the loop above, stop, then run 0023 with the width your embedding model actually produces (e.g. 1024 for BGE-m3 or Jina v3, 896 for KaLM-embedding-multilingual v2.5):

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v embed_dim=1024 -f migrations/0023_configurable_embed_dim.sql
```

before resuming the loop for anything numbered after it. There is deliberately no default for `embed_dim` — omitting it aborts the script (with `-v ON_ERROR_STOP=1`, a nonzero exit) rather than silently reapplying the 1536 ceiling this migration exists to remove. **After it runs, reindex before the assistant can ground content again**: `POST /workspaces/{id}/assistant/reindex` (or per-project `POST /projects/{id}/assistant/reindex`). Until that completes, content/mixed chat questions degrade to the existing "no indexed content" ungrounded path (`app/api/assistant.py`) rather than erroring — nothing is silently wrong, but nothing is grounded either. A workspace's model connection (`POST /workspaces/{id}/model-connection`) also needs its own `embed_dim` set to the same number; a mismatch there now 409s with `embed_dim_mismatch` instead of failing at query time against the vector column.

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

Railway injects `PORT` automatically; the Dockerfile already honors it.

The cloud Planner UI (the web app's stage-generation tab, `apps/cloud/app/api/generation.py`) has no BYO-model fallback: `select_model()` (`apps/cloud/app/generation/routing.py`) returns whatever `build_managed_connection()` (`apps/cloud/app/generation/managed.py`) produces from `MANAGED_MODEL_ENABLED` and `MANAGED_MODEL_API_KEY`, and returns nothing at all if either is unset. `apps/cloud/.env.example` ships `MANAGED_MODEL_ENABLED=false` by default, so a deployment that only follows the table above will have a Planner tab that fails closed on every request. Treat `MANAGED_MODEL_ENABLED=true` plus a valid `MANAGED_MODEL_API_KEY` as required, not optional, before telling users the Planner is available — set both explicitly in Railway's Variables alongside the settings above.

Turning on `MANAGED_MODEL_ENABLED` covers the Planner's *generation* path, but the RAG assistant's *retrieval* path needs a second, separate setting: Typhoon is chat-only, so a keyless workspace's content questions (anything grounded in synced documents or code, as opposed to task status or lineage) are answered by `build_managed_embed_connection()` (`apps/cloud/app/generation/managed.py`), which reads `MANAGED_EMBED_BASE_URL`, `MANAGED_EMBED_MODEL`, and `MANAGED_EMBED_API_KEY`. Leave any of those unset and it silently returns `None` — `app/api/assistant.py` then skips retrieval entirely, and every content question comes back with a fluent "I don't have enough information" that is indistinguishable from a working assistant that genuinely doesn't know. The app now logs a startup WARNING when this combination occurs (`MANAGED_MODEL_ENABLED=true` with no embed connection resolved), but don't wait to see it in the logs — set the three `MANAGED_EMBED_*` variables in Railway's Variables alongside `MANAGED_MODEL_*` whenever the managed tier is on. `apps/cloud/.env.example` documents the constraint that matters most when picking a model: `pz_rag_chunks.embedding` is a fixed `vector(1536)` column, so the embedding model's output dimension must be exactly 1536 — most open multilingual encoders (BGE-m3, Jina v3, KaLM-embedding-multilingual) do not fit that, and OpenAI's `text-embedding-3-small`, Google's `gemini-embedding-001` (MRL-truncated to 1536), and `Alibaba-NLP/gte-Qwen2-1.5B-instruct` are known-good options instead.

### 2.5 Scaling constraints — important

Presence, rate-limit, metrics, the RAG embed queue, and the RAG daily token
budget are all **in-process**. Until a shared backplane (e.g. Redis) exists:

- **Replicas = 1.** Do not scale horizontally.
- Railway routes all traffic to the single replica, so session affinity is a non-issue at 1 instance — but revisit before ever raising the replica count.
- Vertical scaling (more memory/CPU on the one instance) is the only safe lever.

### 2.6 Verify

```bash
curl https://<service>.up.railway.app/health     # includes schema_version from migrations
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

**Migrations:** keep applying manually via `psql` before deploying code that needs them; automate later with a pre-deploy job.

---

## 7. Production checklist

- [ ] Supabase migrations applied in order (0001 → latest), `schema_version` on `/health` matches — including 0023 by hand with `-v embed_dim=<N>` (§2.2), followed by a reindex
- [ ] `AUTH_MODE=supabase`, `DATA_BACKEND=supabase`, `APP_ENV=production`
- [ ] service_role key set only in Railway variables — never in the repo or client
- [ ] Replicas = 1 (in-process presence/rate-limit state)
- [ ] `CORS_ORIGINS` includes the packaged app origin, excludes wildcards
- [ ] DMG uploaded to versioned R2 path + `checksums.txt` + `latest.json` updated
- [ ] Download page includes the Gatekeeper workaround note (until signing exists)
- [ ] Version bumped in `tauri.conf.json` and tagged in git
