# PromptConnext Web

Collaborative, read-only web workspace (plan 0005, Milestone M8). Lets a
stakeholder without a desktop install sign in, accept a workspace invitation,
and browse the same requirement → spec → task → artifact → agent-run graph,
task board, and progress roll-ups that `apps/cloud` serves to the desktop app.

Authoring stays on desktop; this app only reads from `apps/cloud`'s existing
membership-scoped endpoints — no new backend code.

## Stack

Next.js (App Router) + TypeScript + Tailwind. All data-bearing pages are
client components: the auth token (Supabase session or stub user id) only
ever exists in the browser, so there's no server-side credential to render
with, and no Next.js API routes proxy anything.

## Local dev — no Supabase needed

Run `apps/cloud` with the in-memory backend and stub auth (mirrors its own
quick start):

```bash
cd apps/cloud
source .venv/bin/activate  # after `python -m venv .venv && pip install -r requirements.txt`
DATA_BACKEND=memory AUTH_MODE=stub CORS_ORIGINS=http://localhost:3000 \
  uvicorn app.main:app --reload --port 8080
```

In another terminal:

```bash
cd apps/web
cp .env.example .env.local   # NEXT_PUBLIC_AUTH_MODE=stub by default
pnpm install
pnpm dev
# open http://localhost:3000
```

Sign in with any user id (e.g. `alice`) — stub mode accepts anything, no
password. Create a workspace/project/invitation via `apps/cloud`'s
`/docs` (Swagger UI at `http://localhost:8080/docs`) or the desktop app, then
browse it in the web app. Open a second browser profile/tab as a different
stub user id to see the presence roster update live.

## Running against real Supabase

Set in `.env.local`:

```bash
NEXT_PUBLIC_AUTH_MODE=supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
NEXT_PUBLIC_CLOUD_API_URL=https://<your-cloud-deployment>
NEXT_PUBLIC_CLOUD_WS_URL=wss://<your-cloud-deployment>
```

`apps/cloud` must be running with `AUTH_MODE=supabase` and its `CORS_ORIGINS`
must include this app's origin (see `docs/DEPLOYMENT.md` §2.4).

## Build

```bash
pnpm build   # next build
pnpm typecheck
```

## Deploy

Static/SSR — no WebSocket or single-instance constraints on this app itself
(presence is a client-side WebSocket *to* `apps/cloud`, not hosted here), so
it's a good fit for Vercel. Set the same env vars as above in the Vercel
project, and add the deployed origin to `apps/cloud`'s `CORS_ORIGINS`.
