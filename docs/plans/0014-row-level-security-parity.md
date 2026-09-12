# Plan 0014 — Make row-level security match the API

**Date:** 2026-09-12 · **Status:** Ready for implementation

[Finding 2](../cloud-codebase-review-2026-09-06.md) of the cloud codebase review is the specification this plan implements: `app/api/_guards.py` documents Postgres row-level security as a second, independent enforcement of the same rules the API applies — admin-only plan authoring, task ownership, admin-only verification. It is not. Every policy governing the graph tables tests membership only (`pz_is_member`), and `migrations/0006_grants.sql` hands the underlying `INSERT`/`UPDATE`/`DELETE` privileges to `authenticated` outright. In any deployment that exposes Supabase's PostgREST data API to a signed-in browser session, a plain member can open that API directly and write what `app/api/sync.py`'s routes refuse to let them write. [Finding 1](../cloud-codebase-review-2026-09-06.md), which shows the API's own `push_graph` route bypasses these same rules, is the sibling defect and belongs to a separate plan, `0015-full-graph-write-permissions.md` — together they establish that today nothing below the two dedicated routes (`assign_task`, `set_task_status`) enforces admin-only authoring or task ownership at all.

## The gap, as a matrix

| Operation | What the route requires | What the policy requires |
|---|---|---|
| Author a `constitution` or `plan` stage document | Workspace **admin** — `require_stage_access` / `ADMIN_ONLY_STAGES` (`apps/cloud/app/api/_guards.py:39-45`), enforced by `POST /projects/{id}/generate/{stage}` (`apps/cloud/app/api/generation.py:99`) and `PATCH /projects/{id}/stage-documents/{stage}` (`apps/cloud/app/api/stage_documents.py:73`) | Any workspace **member** — `pz_stage_documents_write` tests only `pz_is_member(workspace_id)` (`apps/cloud/migrations/0019_stage_documents.sql:26-28`); full CRUD granted to `authenticated` at `migrations/0019_stage_documents.sql:29` |
| Set a task's status to `verified` | Workspace **admin** — a member whose task it is may report other statuses but gets `403 verified_requires_admin` (`apps/cloud/app/api/sync.py:593-600`) | Any workspace **member** — `pz_tasks_rw` tests only `pz_is_member(...)` (`apps/cloud/migrations/0003_auth_workspaces.sql:130-135`); full CRUD granted at `migrations/0006_grants.sql:12-23` (`pz_tasks` on line 16) |
| Assign a task to another member | Workspace **admin**, or self-assign/self-unassign (`apps/cloud/app/api/sync.py:550-554`) | Same `pz_tasks_rw` policy and grant as above — no ownership predicate exists at the row level |
| Mutate requirement/spec/task/artifact/agent-run rows via the full graph push | Workspace **member** only — `require_project` (`apps/cloud/app/api/sync.py:624`); this route itself carries none of the three rules above (Finding 1) | Workspace **member** only — the same `pz_is_member` policy loop across all five graph tables (`migrations/0003_auth_workspaces.sql:123-137`) |

The fourth row is not a coincidence to celebrate: the API and the database agree on `push_graph` because neither restricts it. Fixing Finding 1 alone makes the API's own surface consistent, but a client that goes around it — straight to PostgREST with a member's JWT — still reaches today's `push_graph` behavior on every table, permanently, because that is what the policy grants. Finding 1 narrows what the *server* will forward; only this plan narrows what *Postgres* will accept.

## The prior decision this forces

The real question behind Finding 2 is whether a client is ever allowed to talk to Postgres directly for these tables, or whether the API is the only legitimate writer and the database's job is to survive a misbehaving or compromised API process rather than a well-behaved client bypassing it. Two coherent answers exist; simply rewriting the guards' comment without changing either layer (addressed as the do-nothing baseline folded into M3) throws away real protection and is not one of them.

**Option A — revoke direct write access; the server is the only writer.** Precedent already exists: `migrations/0020_repo_webhooks.sql` puts `pz_repo_webhooks` under RLS with no policy at all and `revoke all on pz_repo_webhooks from authenticated`, reasoning "the webhook route runs unauthenticated... on the service key... there is nothing here a member needs"; `migrations/0021_repo_webhooks_anon_revoke.sql` closes the same table's `anon` grant for the identical reason. The five graph tables differ from that precedent in one respect: `apps/cloud/app/dependencies.py:103-122` (`get_repository`) hands every `auth_mode="supabase"` request a repository scoped to *the caller's own JWT* — `SupabaseRepository.for_user` (`apps/cloud/app/db/supabase_repository.py:96-110`) swaps the PostgREST client onto the caller's token "so RLS applies per request" — so production graph writes today really do execute as `authenticated`, not as the service role. Revoking the grant therefore is not a pure database change; it must ship with stopping graph-table operations from routing through `for_user`'s scoped client (falling back to the unscoped, service-role-keyed instance the same function already uses for unauthenticated callers, per its own docstring at `dependencies.py:111-114`: "those need the base SUPABASE_KEY's own privileges (a service-role key)"). Once that is true, `app/api/_guards.py`'s admin/ownership checks become the sole enforcement, matching how `InMemoryRepository` already behaves and how `push_graph`'s webhook and GC-loop callers already run.

**Option B — express the API's rules as Postgres policies and functions.** Add role- and ownership-aware predicates: a `pz_is_admin`-gated `with check` on `pz_stage_documents` for `stage in ('constitution','plan')`, and on `pz_tasks` a predicate rejecting a non-admin's write unless `assigned_user_id = auth.uid()` (or the assignment target) and rejecting `status = 'verified'` outright for non-admins. This keeps RLS as real defense-in-depth against a compromised API process, not only a misused client.

**Recommendation: Option A.** `apps/web/src` has no consumer of Supabase's data API for these tables at all — `apps/web/src/lib/auth.tsx` imports `@supabase/supabase-js` (the project's only dependency on it; `apps/desktop`, `apps/engine`, and `apps/vscode` don't carry the package) and calls only `client.auth.getSession()` / `onAuthStateChange()` to manage the browser session; every graph read and write goes through `apiFetch` in `apps/web/src/lib/api.ts` against `apps/cloud`, exactly as CLAUDE.md documents ("no Next.js API routes... `lib/api.ts` is the single client"). Revocation therefore costs nothing for any real client today — it only removes a capability nothing uses. Option B would stand up a *third* copy of rules already duplicated once between `app/models/schemas.py`'s `FIELD_AUTHORITY`/`ADMIN_ONLY_STAGES` and `apps/web/src/lib/fieldAuthority.ts` (a pairing plan 0009 already had to call out to keep in lockstep) — this time in SQL, unable to share the self-assign/self-unassign branching in `sync.py:550-554` without re-deriving it, and free to drift silently the next time a rule like `verified_requires_admin` changes in Python only. Matching the grant to what the API already does in practice is cheaper and less prone to silent divergence than re-encoding the rules a second time.

## M1 — Establish what actually holds today

Before changing anything, record the current policy and grant surface for the graph tables in one place so the change under M2 can be reviewed against a known baseline, not against recollection. Run, against the target Supabase project (or `supabase db diff` locally):

```sql
select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('pz_requirements','pz_spec_documents','pz_tasks',
                     'pz_artifacts','pz_agent_runs','pz_stage_documents')
order by tablename, policyname;

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_name in ('pz_requirements','pz_spec_documents','pz_tasks',
                      'pz_artifacts','pz_agent_runs','pz_stage_documents')
  and grantee in ('authenticated','anon')
order by table_name, grantee, privilege_type;
```

Paste both result sets into the PR that ships M2, so the diff is reviewable as "grant went from X to Y" rather than "grants changed, trust me." This is intentionally read-only — it changes no schema and blocks nothing else.

## M2 — Implement the chosen option

The current migration high-water mark is `apps/cloud/migrations/0027_deployment_tasks.sql`; this plan's migration is numbered 0028 (new file, `apps/cloud/migrations/`), following `migrations/0020_repo_webhooks.sql`'s pattern:

```sql
-- 0028 — graph tables become service-only writes (cloud codebase review,
-- finding 2). The API's admin/ownership rules (app/api/_guards.py,
-- app/api/sync.py's assign_task/set_task_status, app/api/generation.py's
-- ADMIN_ONLY_STAGES gate) are the sole enforcement for these tables; RLS no
-- longer needs to re-express them because no client writes here except the
-- server, which now always uses its service-role client for these tables
-- (apps/cloud/app/dependencies.py::get_repository, apps/cloud/app/db/
-- supabase_repository.py — the for_user()-scoped client is no longer used
-- for this set). Precedent: migrations/0020_repo_webhooks.sql.
revoke all on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents
from authenticated;

revoke all on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents
from anon;
```

This migration must land in the same deploy as the `get_repository`/`SupabaseRepository` change under Option A — landing the revoke alone, ahead of that code change, would make every authenticated production write to these six tables fail with `permission denied for table ...` the moment a real request used `for_user`'s scoped client, exactly the failure mode `migrations/0006_grants.sql`'s own history warns about. The RLS policies from `migrations/0003_auth_workspaces.sql` and `migrations/0019_stage_documents.sql` can stay in place unmodified: with the grant gone, Postgres denies every non-service role before it reaches policy evaluation at all (the base-GRANT-before-RLS ordering `migrations/0006_grants.sql`'s own comment explains), so the now-unreachable `pz_is_member`-only policies are harmless rather than misleading.

## M3 — Correct the guards' claim

Whatever ships, the comment at the top of `apps/cloud/app/api/_guards.py:1-5` currently reads:

```python
"""Shared authorization guards: workspace membership & admin role.

App-layer checks are the primary access control; when the backend forwards the
caller's JWT to Supabase, RLS enforces the same rules a second time.
"""
```

That last sentence is the false claim Finding 2 identifies — RLS never enforced the admin-only or ownership rules this module defines; it only enforced membership, and after M2 it does not run for these tables at all. Replace it with:

```python
"""Shared authorization guards: workspace membership & admin role.

These checks are the only enforcement of admin-only stage authoring, task
ownership, and admin-only verification (0014-row-level-security-parity.md).
Postgres RLS on the graph tables was previously assumed to re-check the same
rules; it never did — it tested workspace membership only — and as of
migration 0028 the `authenticated` role has no grant on those tables at all,
so this module is not "primary" among layers that also enforce these rules.
It is the entire enforcement.
"""
```

`apps/cloud/app/dependencies.py:107-109`'s `get_repository` docstring makes the same now-inaccurate "defense in depth" claim about RLS for the graph tables specifically; update it in the same change to say those tables' repository calls always use the service-role client, and that per-request JWT scoping remains in effect only for tables outside this set (workspaces, members, projects) where it is still real.

## M4 — Prove it

`apps/cloud/tests/conftest.py:15` pins `os.environ["DATA_BACKEND"] = "memory"` for the entire suite, and `InMemoryRepository` has no concept of a Postgres grant or an RLS policy — nothing in `pytest` today can fail if M2's migration is wrong, because nothing in the suite ever executes SQL. Validating this plan needs a real Supabase instance and two real JWTs (one workspace admin, one plain member), which the current harness cannot produce.

The smallest harness that would actually test this is not the general repository-contract suite `0020-repository-contract-suite.md` describes — that plan owns the *shared* `InMemoryRepository`/`SupabaseRepository` behavioral contract (pagination, membership, concurrent updates) against a disposable Supabase project, and M4 should not duplicate that infrastructure. What it needs is narrower: a standalone script (or a `pytest` module excluded from the default `memory`-backed run, gated on `SUPABASE_URL`/`SUPABASE_KEY` pointing at a disposable local `supabase start` instance) that signs two users up through Supabase Auth, adds one as `admin` and one as `member` via `pz_workspace_members`, then issues raw PostgREST calls with each JWT directly against `pz_tasks` and `pz_stage_documents` — bypassing `apps/cloud` entirely — asserting every write is rejected post-M2 (`42501`/`permission denied`) where pre-M2 the member's direct `update ... set status = 'verified'` would have silently succeeded. That last assertion is what this plan exists to make true, and it is also one no amount of testing `app/api/sync.py` in-process could catch, because the vulnerability was never reachable through the app's own router in the first place.
