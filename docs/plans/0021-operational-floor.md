# Plan 0021 — The operational floor

**Date:** 2026-09-12 · **Status:** M1 implemented 2026-09-21 (`.github/workflows/ci.yml`: cloud, engine, web, vscode, mcp, corp, pz-cloud jobs, path-filtered) · M2 implemented 2026-09-21 (Sentry across cloud/web/corp, no DSN configured yet, mandatory secret scrubbing verified by two rounds of adversarial security review) · M3 implemented 2026-09-21 (`apps/cloud/app/requestlog.py`: `X-Request-Id` middleware, stdlib JSON log formatter, `EmbedJob.request_id` into the embed worker; `apiFetch` mints one per call; the id is also a Sentry tag) · M4–M5 open · **Source:** [product vision §3.4](../product-vision-2026-09-12.md)

PromptConnext is a hosted service holding real customer data — workspaces, task graphs, discussions, encrypted model keys and GitHub PATs — and it has no continuous integration for the four apps that matter, no error tracking, no tracing and no metrics beyond four counters on a health endpoint. The only automation in the repository builds desktop shells that [plan 0011](./0011-desktop-decision-gate.md) may be about to delete.

None of what follows is a rewrite. Every app already has a working test command, every command runs in seconds, and the cloud suite is hermetic by construction. What is missing is the thing that runs them.

---

## 1. The honest inventory

Measured on this working tree (warm caches, Apple Silicon). CI runners will be slower, and on a cold runner the `pnpm install` dominates every JS job.

| App | Test | Typecheck | Lint | Automated today | Measured |
|---|---|---|---|---|---|
| `apps/cloud` | `pytest` (608 tests) | — (no mypy) | `ruff check .` | none | 17.6 s tests, <1 s lint |
| `apps/engine` | `node --test test/*.test.ts` (63 tests, 4 skipped) | `tsc --noEmit` | none configured | none | 2.9 s tests, 1.5 s typecheck |
| `apps/web` | `vitest run` (286 tests, 32 files) | `tsc --noEmit` | none configured | none | 21.0 s tests, 1.8 s typecheck |
| `apps/vscode` | `node --test test/unit/*.test.ts` (79 tests) + a `pretest` feature-detection check | `tsc --noEmit` | none configured | none | 0.3 s tests, 0.9 s typecheck, 0.2 s esbuild |
| `apps/corp` | **no test framework at all** | `tsc --noEmit` | `eslint .` | none | 1.9 s typecheck, 4.0 s lint |

Three things the table understates. `apps/corp` has no test script, no test file and no runner in its devDependencies — the only app with nothing to run — yet is the *only* app with an ESLint config (`apps/corp/eslint.config.mjs`); the other three JS apps have neither a lint script nor a config, so linting them would be new tooling rather than new automation, and is out of scope here. The cloud suite needs no services at all: `apps/cloud/tests/conftest.py:9` sets `PZ_DISABLE_ENV_FILE=1` and pins the memory backend, so `pytest` is one `pip install -r requirements.txt` away from green on any runner.

And — the finding that justifies the whole plan — **`apps/web`'s suite is not green on this tree**: 33 of 286 tests fail across `TaskBoard.test.tsx`, `Planner.test.tsx`, `WorkspaceGate.test.tsx` and `DiscussionThread.test.tsx`, every one with `Cannot read properties of null (reading 'useMemo')` raised from `@dnd-kit/core` or `@radix-ui/react-select`. The cause is two React instances: `apps/web/node_modules/react` is a physical 19.2.8 directory, while the lockfile pins 19.2.7 everywhere and the hoisted packages resolve that copy from the store. The lockfile is self-consistent, so a `--frozen-lockfile` install should not reproduce it — which is exactly the point. Nobody knew, because nothing runs.

---

## Milestone 1 — Continuous integration, cheapest first

Add one workflow, `ci.yml`, under `.github/workflows/`, triggered on `pull_request` and on `push` to `main`. One job per app, each gated by a `paths` filter so a marketing-copy change never runs the Python suite. Use the same pinned-SHA action style the existing workflows already use (`.github/workflows/desktop-build.yml:19`–`:24`).

**cloud** — filter `apps/cloud/**`. `ubuntu-latest`, Python 3.11 (the version `.github/workflows/desktop-theia-build.yml:40` already pins), `pip install -r requirements.txt`, then from `apps/cloud` run `ruff check .` before `pytest` — the lint is sub-second and its failures are the cheapest to read.

**engine** — filter `apps/engine/**`. Node 24 (a hard floor for `node:sqlite` and native TS), `pnpm install --frozen-lockfile --filter @promptconnext/engine...`, then `pnpm --dir apps/engine typecheck` and `pnpm --dir apps/engine test`.

**web** — filter `apps/web/**`. Node 22, `pnpm install --frozen-lockfile --filter @promptconnext/web...`, then `pnpm --dir apps/web typecheck` and `pnpm --dir apps/web test`. **This job's first run is the arbiter of the React-duplication finding above.** If a frozen install is green, land the job and move on; if it reproduces, the fix belongs here and not in a later milestone — add an explicit `resolve.dedupe: ["react", "react-dom"]` to `apps/web/vitest.config.ts`, leaving the root `pnpm.packageExtensions` pins that `pnpm-workspace.yaml` warns about intact.

**vscode** — filter `apps/vscode/**`. Node 22, then `typecheck`, `test` (its `pretest` hook runs the feature-detection check automatically) and `build`, so a VSIX that cannot be bundled fails here rather than at publish time.

**corp** — filter `apps/corp/**`. Node 22, then `typecheck` and `lint`. No test job: adding a runner belongs with the pricing-page rewrite in vision §3.5.

Two deliberate omissions. `next build` is out of scope for both Next apps — each reads `NEXT_PUBLIC_*` values at build time (`apps/corp/src/lib/site.ts:13` is the pattern), so a build job needs environment wiring typechecking does not, and Vercel already builds both on every push. And no deploy step: `docs/DEPLOYMENT.md:403` already sketches `railway up` behind a manual approval, which is a second plan.

**Which desktop workflows survive.** Superseded by [ADR 0028](../decisions/0028-desktop-repurposed-for-business-users.md) (2026-09-21): `apps/desktop` is no longer being deleted, only `apps/desktop-theia` is. So `.github/workflows/desktop-theia-build.yml` and `.github/workflows/theia-spike-windows.yml` (150 lines) go, replaced by `ci.yml`'s five jobs — the Theia workflow builds an app with no product interface, and the authenticity gap plan 0011 §3 documents is the same reason regardless of `apps/desktop`'s fate. `.github/workflows/desktop-build.yml` (the Tauri matrix, 148 lines) **stays**, running alongside `ci.yml` rather than being replaced by it, until a follow-up plan defines what `apps/desktop` becomes and this file changes with it. Run the contract suite from [plan 0020](./0020-repository-contract-suite.md) as a **second step inside the cloud job**, not a separate workflow, so one path filter governs both.

---

## Milestone 2 — Error tracking

The question is narrow: *did that request fail for a real user?* Nothing answers it. There is no Sentry, OpenTelemetry, Prometheus or equivalent anywhere under `apps/` — a grep for all four returns nothing, and `apps/cloud/requirements.txt` carries no observability dependency.

Adopt one error reporter across three surfaces: the FastAPI service, `apps/web` and `apps/corp`. Initialise it in the cloud from `lifespan`, alongside the logging setup at `apps/cloud/app/main.py:100`, reading a DSN and an environment name added to `Settings` in `apps/cloud/app/config.py` in the existing declarative style. Follow `require_production_safety` (`apps/cloud/app/config.py:223`) for the startup guard: with `app_env == "production"` and no DSN configured, that method should return a warning — running a hosted instance blind is an operational fault, like the managed-embeddings warning at `apps/cloud/app/main.py:152`. A warning, not a raise; the hard refusal at `apps/cloud/app/config.py:232` is reserved for an auth bypass.

**What must never be captured is the load-bearing part of this milestone.** Source code never rests in this system by design (ADR 0011 — `CodeChunk` has no content field), and that guarantee is enforced today by one local variable: `apps/cloud/app/rag/queue.py:291` binds the full text of a customer's source file into a frame of `_process_job`, transiently, to chunk and embed it. A reporter with default local-variable capture would ship that frame to a third party on any exception below it, silently converting a documented architectural promise into a breach. So: **disable local-variable capture globally**, and add a scrubbing hook dropping at minimum the decrypted model keys at `apps/cloud/app/rag/queue.py:242` and `:301`, the workspace GitHub PAT returned by `resolve_token` (`apps/cloud/app/integrations/github_auth.py:39`), every `Authorization` and `X-User-Id` header, the bearer-suffix rate-limit key built at `apps/cloud/app/ratelimit.py:86`, and uploaded document bodies. Send `user_id` and `workspace_id` as tags — they make a report actionable and are already ours. On the two Next apps, enable browser and server reporting with the same header scrub; `apps/web`'s single egress point is `apiFetch` at `apps/web/src/lib/api.ts:36`, so one wrapper there covers every cloud call it makes.

---

## Milestone 3 — Structured request logging, before tracing

A structured logger already exists, but in the wrong process: `apps/engine/src/logger.ts:19` emits one JSON object per line with a timestamp, level, message and arbitrary metadata. The cloud has only `logging.basicConfig` with the format string at `apps/cloud/app/main.py:102` — plain text, no request context, no access log of its own (the only middleware registered is CORS and the rate limiter, `apps/cloud/app/main.py:225` and `:233`).

The minimum useful step is a **request identifier that survives the whole path**. Add a small ASGI middleware that reads an `X-Request-Id` header or mints a UUID, binds it to a `contextvar`, echoes it on the response, and installs a logging filter so every record carries it. Have `apiFetch` generate one per call and send it, so a customer reporting "it failed at 14:32" hands you a value you can grep. Then carry it into the background worker: `EmbedJob` in `apps/cloud/app/rag/queue.py` is a frozen dataclass, so an optional `request_id` field stamped at the `enqueue()` call sites is a few lines, and it makes the one genuinely asynchronous path — `apps/cloud/app/rag/queue.py:92`'s `asyncio.Queue`, drained by `embed_worker_loop` — traceable back to the request that filled it. Switch `basicConfig` to a JSON formatter at the same time so Railway's log search can filter on the field.

**Defer full distributed tracing.** OpenTelemetry pays for itself across a service mesh; this is one container talking to Postgres and two HTTP APIs. A request id plus structured lines answers the questions an operator actually has at this size, costs one middleware and one dataclass field, and adds no dependency, collector or sampling decision. Revisit when a second service exists.

---

## Milestone 4 — The single-instance ceiling, named not fixed

Four in-process components cap the cloud at one container, and each already says so in its own docstring.

**Presence** (`apps/cloud/app/ws/manager.py:6`) holds `project_id -> {socket: Presence}` in one process. With two replicas, two users on the same project connected to different ones simply do not see each other — a wrong answer, not an error.

**Rate limiting** (`apps/cloud/app/ratelimit.py:8`) is a per-identity token bucket over `/sync`, `/api/webhooks` and `/desktop-auth` (`apps/cloud/app/ratelimit.py:25`). Split across N replicas, every client's effective limit becomes N times the configured one — quietly, and only toward less protection.

**The daily token budget** (`apps/cloud/app/rag/budget.py:3`) is the repository's only spend control, and it is a dict keyed by workspace. Split it and the managed-Typhoon bill multiplies by the replica count; the same applies to the global managed limiter at `apps/cloud/app/main.py:168`.

**The embed queue** (`apps/cloud/app/rag/queue.py:26`) is an `asyncio.Queue` plus per-project in-flight counters. A second instance sees only its own share, so the `pending_jobs` and `last_error` fields the index-status panel reads become a coin flip, and a job enqueued on one replica is invisible to the other.

**The budget breaks first**, because its failure costs money rather than fidelity. Presence is second — user-visible, and therefore reported. The rate limiter and the queue degrade silently and need the alarm below to be noticed at all. A shared backplane, when genuinely needed, follows that order: budget and managed limiter first (a shared counter), then presence (pub/sub fan-out), then the request limiter, then the queue — which by then wants a real job broker, not a Redis list.

**This plan does not introduce Redis, and the review deliberately declined to recommend it merely because these components exist.** Each is a documented v1 trade-off, and a single container is the right shape for the current load. This milestone delivers a documented limit and an alarm, not an architecture change: extend the counters at `apps/cloud/app/main.py:116` — already surfaced at `apps/cloud/app/api/health.py:25` — with presence room count, queue depth and budget headroom, and wire an uptime check that alerts when the replica count leaves 1 or queue depth stays non-zero across consecutive polls. The alarm turns a docstring comment into something an operator finds out about.

---

## Milestone 5 — Make the deployment docs true

Whatever ships, `docs/DEPLOYMENT.md` has to match it. Three named sections change.

**§2.5 Scaling constraints** (`docs/DEPLOYMENT.md:151`) already lists all four components and already says "Replicas = 1" at `docs/DEPLOYMENT.md:156`. Keep the constraint; add the M4 alarm and the ordering above, so the section says what to watch and what to fix first, not only what not to do.

**§6 CI/CD recommendations** (`docs/DEPLOYMENT.md:399`) is written in the future tense and is wrong the moment M1 lands. Rewrite it to describe `ci.yml` as shipped — the five jobs, their path filters, and the contract suite running inside the cloud job — keeping the deploy-on-approval sketch at `docs/DEPLOYMENT.md:403` marked as not yet built.

**§7 Production checklist** (`docs/DEPLOYMENT.md:411`) keeps its replica line at `docs/DEPLOYMENT.md:417` and gains two: the error-reporter DSN is configured for the target environment, and the scrubbing hook is on. A checklist item is this repository's only mechanism for "you cannot forget this."

---

## Sequencing and cost

M1 first, unconditionally: it protects every later milestone and the suites already exist. M2 next, because a hosted service with no observability fails silently. M3 after that, since a request id is only worth having once errors are captured somewhere to attach it to. M4 and M5 are counters and documentation and can land alongside either.

Honestly costed: **M1 is a day** — five jobs running commands that already work, plus the `apps/web` React-duplication triage, the one genuine unknown, which could itself be half a day. **M2 is a week**, and almost none of it is the SDK install: the scrubbing rules are a security review of every path touching source code, a decrypted key or a PAT, and getting that wrong is worse than having no error tracking at all. **M3 is two days.** **M4 is a day.** **M5 is an afternoon**, and belongs in the same pull request as whichever milestone changed the thing it documents rather than saved up.
