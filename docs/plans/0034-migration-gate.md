# 0034: Migration gate, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Draft, 2026-10-25. Branch `feature/migration-gate`, cut from `feature/trust-outcome` at `83a66a9`; merges back into `feature/trust-outcome`.

**Goal:** The service never takes traffic while its database is behind its code, and the platform can apply pending migrations itself before it starts. Nobody has to remember a deploy-order step.

**Why now:** On 2026-10-25 trust ran the merged plan 0033 code while its database was still at migration 0010. `/health` reported `0013_pw_latest_receipt_at` because it reads the newest migration file in the image, not the database, and the API failed with `column pw_artifacts.agent does not exist`. The migration history already uses a baseline (`0001` ledger, `0002` schema, additive files after) and `migrate.py` records every run in `pw_schema_migrations`. What was missing is any comparison of code to ledger and any deploy-time apply.

**Architecture:** A narrow SQL function exposes the applied filenames (not checksums) to `service_role`, because the ledger table itself is deliberately unreadable over the REST API. A pure module compares the image's migration files to that list. A new `GET /ready` returns 503 when positive evidence shows the database is behind; `/health` stays 200 and reports the same state, because the platform's liveness probe also hits `/health` and a 503 there would restart-loop the container. A CI rule keeps migrations additive so applying them automatically stays safe. An opt-in container entrypoint applies pending migrations before uvicorn starts.

**Tech Stack:** FastAPI + pytest (`apps/cloud`), Postgres function via `scripts/migrate.py`, `psql` in the image, GitHub Actions.

## Global Constraints

- Every change lands with a test that fails first. Cloud tests hermetic (`DATA_BACKEND=memory`). Any new `Repository` method is implemented on `InMemoryRepository` and `SupabaseRepository` and pinned in `tests/contract/`.
- `ruff check .` clean, line length 100.
- The gate blocks only on positive evidence. A missing function, a memory backend or any error reading the ledger yields state `unknown`, which `/ready` reports as ready and logs once at WARNING. Deploying the gate itself must never be blocked by the gate's own migration.
- `/health` always returns 200. Only `/ready` returns 503.
- The ledger is exposed as filenames only. No checksums, no timestamps, no `applied_by`.
- Migration `0015` is idempotent, `security definer`, `set search_path = public`, execute revoked from `public`, `anon`, `authenticated` and granted to `service_role`, header in the style of `0013`.
- The Dockerfile's last line stays a `CMD [...]` JSON array, because `tests/test_container_shutdown.py` parses it. The entrypoint script must `exec "$@"`.
- Auto-apply is opt-in (`MIGRATE_ON_START=true`), needs `DATABASE_URL`, and fails the container (non-zero exit before uvicorn) rather than serving on a half-applied database.
- Docs are prose-forward; dates absolute.

## Review Focus

1. A `/ready` that returns 503 forever because the ledger lists a filename the image does not ship (database ahead of code, as during a rollback): the gate treats extra applied files as fine. Task 2 pins it (`database ahead of code is ok`).
2. A database whose ledger rows predate the squash (`adopted` rows, baseline files only): the comparison is by filename set difference, never by position. Task 2 pins it (`pending is computed by set difference`).
3. The health route is hit every few seconds by probes: the ledger read is cached for 15 s and a failing read is cached too, so a down database cannot turn every probe into an RPC. Task 2 pins it (`ledger read is cached`).
4. A migration containing `DROP COLUMN` hidden in a comment or a string must not fail the additive rule, and one hidden in real SQL must. Task 3 pins both.
5. `MIGRATE_ON_START=true` with no `DATABASE_URL` exits non-zero with a message naming the variable. Task 4 pins it with a shell-level test.

---

## Task 1: Expose applied migration filenames

**Files:**
- Create: `apps/cloud/migrations/0015_pw_applied_migrations.sql`
- Modify: `apps/cloud/app/db/repository.py` (abstract + memory), `apps/cloud/app/db/supabase_repository.py`
- Test: `apps/cloud/tests/contract/test_applied_migrations.py`, `apps/cloud/tests/test_delivery_store_adapter.py` (extend its `_TableClient` fake)

**Interfaces:**
- Produces: `Repository.applied_migrations() -> list[str] | None`. Memory returns `None` (no ledger). Supabase calls `rpc("pw_applied_migrations", {})` and returns the sorted filenames; returns `None` when the function is missing (reuse `_missing_function`) and also on any other exception, after one `logger.warning`.
- SQL: `create or replace function pw_applied_migrations() returns setof text language sql stable security definer set search_path = public as $$ select filename from pw_schema_migrations order by filename $$;` plus the revoke and grant above.

- [ ] **Step 1: Failing tests.** Contract `test_memory_backend_has_no_ledger` (`applied_migrations() is None` on the memory param); adapter tests with the fake client: rpc returns rows → sorted list; rpc raises `APIError` code `PGRST202` → `None`; rpc raises a generic exception → `None` and a warning is logged (`caplog`).
- [ ] **Step 2: Fail. Step 3: Implement** the migration, the abstract method, both adapters. Step 4: PASS, `ruff check .`. Commit `feat(cloud): applied_migrations() reads the ledger through a narrow function`.

## Task 2: Readiness gate

**Files:**
- Create: `apps/cloud/app/schema_gate.py`
- Modify: `apps/cloud/app/api/health.py`, `apps/cloud/app/main.py` (state hook only if needed), `apps/cloud/app/ratelimit.py` / `app/requestlog.py` (whatever exempts `/health` from rate limiting or access logging also exempts `/ready`)
- Test: `apps/cloud/tests/test_schema_gate.py`, `apps/cloud/tests/test_health_ready.py`

**Interfaces:**
- Produces: `SchemaStatus(state: Literal["ok", "behind", "unknown"], pending: list[str], applied_latest: str | None, code_latest: str)` (frozen dataclass); `evaluate(code_files: list[str], applied: list[str] | None) -> SchemaStatus` (pure; `None` → unknown; any code file missing from `applied` → behind with `pending` sorted; otherwise ok; files applied but absent from the image are ignored); `read_status(app) -> SchemaStatus` caches the result on `app.state` for 15 s using `repo.applied_migrations()` and the image's `*.sql` stems (`code_files` are stems with `.sql` re-added so they match ledger filenames).
- `GET /health` adds `"schema": {"state", "pending", "applied_latest"}` and keeps `schema_version`. `GET /ready` returns the same body with status 200 for ok and unknown, 503 with `"status": "schema_behind"` for behind.

- [ ] **Step 1: Failing tests.** Pure: `ok when all code files are applied`; `behind lists pending sorted`; `database ahead of code is ok`; `pending is computed by set difference` (ledger with baseline-only rows and 0001/0002 present); `unknown when ledger unavailable`. Route: memory backend `/ready` is 200 with state unknown; with `app.state.repository` monkeypatched so `applied_migrations()` returns a list missing the newest file, `/ready` is 503 and `/health` is 200 with the same pending list; `ledger read is cached` (two requests inside 15 s call `applied_migrations` once; use a fake clock injected through the module's `_now` function); a raising `applied_migrations` is cached as unknown too.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: PASS, ruff. Commit** `feat(cloud): /ready refuses traffic while the database is behind the code`.

## Task 3: Additive-migration CI rule

**Files:**
- Create: `scripts/migrations/check_additive.py`, `scripts/migrations/test_check_additive.py`
- Modify: `.github/workflows/ci.yml` (run both in the cloud job or the cheap `rename-gate`-style job; follow whichever the file already uses for stdlib-only checks, and make sure a change under `apps/cloud/migrations/` triggers it)

**Interfaces:**
- Produces: `find_destructive(sql: str) -> list[str]` returning the offending statement kinds after stripping `--` comments, `/* */` comments and quoted strings and dollar-quoted bodies of literals only where unambiguous (a `$$ ... $$` function body is real SQL and is scanned). Kinds: `drop table`, `drop column`, `drop schema`, `drop type`, `drop function`, `truncate`, `rename`, `alter column type`. `-- migration-gate: allow-destructive <reason of at least 10 characters>` anywhere in the file waives it. CLI scans every `apps/cloud/migrations/*.sql` with a numeric prefix above 2 and exits 1 listing file and kind.

- [ ] **Step 1: Failing tests.** `drop column in real sql is flagged`; `drop column in a line comment is ignored`; `drop column in a block comment is ignored`; `drop column inside a string literal is ignored`; `drop constraint and drop not null are allowed`; `create or replace function is allowed`; `allow marker with reason waives`; `allow marker without a reason does not`; `rename and alter type are flagged`; and `all repository migrations above 0002 pass` (runs the CLI over the real directory).
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: PASS. Commit** `ci: migrations after the baseline must be additive`.

## Task 4: Opt-in apply on start, docs, close

**Files:**
- Create: `apps/cloud/docker-entrypoint.sh`, `apps/cloud/tests/test_entrypoint.py`
- Modify: `apps/cloud/Dockerfile`, `docs/DEPLOYMENT.md`, `CLAUDE.md` (one sentence in the Cloud section), this plan

**Interfaces:**
- `docker-entrypoint.sh` (POSIX sh): when `MIGRATE_ON_START` is `true`, require `DATABASE_URL` (else print `MIGRATE_ON_START=true needs DATABASE_URL` to stderr and exit 1), run `python scripts/migrate.py apply` adding `--var embed_dim=$MANAGED_EMBED_DIM` when that variable is set, exit with its status on failure; then `exec "$@"`.
- Dockerfile: `apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*`; `COPY scripts ./scripts`; `COPY docker-entrypoint.sh /usr/local/bin/`; `ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]`; the final line stays the existing `CMD [...]`.

- [ ] **Step 1: Failing tests** in `test_entrypoint.py` using `subprocess` with a temporary `PATH` containing a stub `python` that records its argv: `MIGRATE_ON_START unset runs the command untouched`; `true without DATABASE_URL exits 1 naming the variable` (Review Focus 5); `true runs migrate.py apply with embed_dim when set`; `a failing migrate.py stops before the command runs`; `the final CMD line of the Dockerfile still parses as JSON`.
- [ ] **Step 2: Fail. Step 3: Implement.**
- [ ] **Step 4: Docs.** `docs/DEPLOYMENT.md`: replace the statement that `/health.schema_version` never reads the database with the new behaviour; add a "Migration gate" subsection: point the Northflank readiness probe at `/ready` and leave liveness on `/health`; `MIGRATE_ON_START=true` plus `DATABASE_URL` (a secret) to apply on start; the rule that every migration is additive and lands first, with code tolerating a missing new column for one release; the CI rule and its `allow-destructive` marker; the migration-history paragraph names `0015`; checklist and smoke-check `schema_version` → `0015_pw_applied_migrations`. `CLAUDE.md`: one sentence. Plan Status → "Implemented 2026-10-25"; tick all steps above.
- [ ] **Step 5: Run the whole cloud suite and `ruff check .`; commit** `feat(cloud): opt-in migrate on start; migration gate documented`.

## Deferred

None. Platform settings (the readiness path, `MIGRATE_ON_START`, `DATABASE_URL`) are the operator's to set on Northflank and are listed in the DEPLOYMENT.md subsection.
