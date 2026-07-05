# Plan — apps/cloud: soft-delete, then auth + workspaces/RLS

**Date:** 2026-07-05 · **Status:** Proposed · **Scope:** `apps/cloud`
**Extends:** ADR 0010 (sync model), architecture §3.1 (task-graph schema)
**Depth:** implementation-ready · **Sequencing:** Milestone 1 (deletes) ships first and stands alone; Milestone 2 (auth + workspaces) builds on it.

This plan turns two documented gaps into concrete, code-level work. It is written to be executed top-to-bottom. File paths, schema DDL, endpoint signatures, and test lists are included.

Current baseline (verified against the code on 2026-07-05):
- Sync is **upsert-only** — no delete propagation.
- Identity is a **stub** (`X-User-Id` header) and access is **owner-only** (`projects.owner_id`).
- Backend talks to Supabase with a **service key** (RLS-bypassing); no RLS policies exist yet.
- Repos: `InMemoryRepository` (tests/dev) and `SupabaseRepository` behind one `Repository` seam.
- Entities: `requirements, spec_documents, tasks, artifacts, agent_runs` (+ `projects`).

---

## Milestone 1 — Tombstone soft-delete

### Problem
Sync is upsert-only, so an entity deleted on one engine is never removed from the cloud or from peers on pull. Under last-write-wins this is a silent convergence hole: the delete simply never travels.

### Decision
Represent deletes as **tombstones**: a nullable `deleted_at` timestamp on every graph entity. A delete is just an upsert that sets `deleted_at`. Tombstones flow through the existing cursor path, so no new endpoint or transport is needed. Two pull modes:

- **Incremental pull** (`?since=` set) returns everything changed after the cursor **including tombstones**, so peers learn of deletions.
- **Bootstrap pull** (no `since`) returns **live rows only** — a fresh client never needs to see long-dead tombstones.

Re-creating an id after deletion is a normal upsert that clears `deleted_at` (LWW by `updated_at` decides the winner, consistent with ADR 0010 §4).

### Changes

**1. Schema — `migrations/0002_soft_delete.sql`** (new)
```sql
-- Add tombstone column to every graph entity. Nullable = live row.
alter table pz_requirements   add column if not exists deleted_at timestamptz;
alter table pz_spec_documents add column if not exists deleted_at timestamptz;
alter table pz_tasks          add column if not exists deleted_at timestamptz;
alter table pz_artifacts      add column if not exists deleted_at timestamptz;
alter table pz_agent_runs     add column if not exists deleted_at timestamptz;

-- Incremental pulls filter by (project_id, updated_at); unchanged.
-- Bootstrap pulls add "deleted_at is null"; partial index keeps them cheap.
create index if not exists idx_pz_requirements_live   on pz_requirements   (project_id) where deleted_at is null;
create index if not exists idx_pz_spec_documents_live on pz_spec_documents (project_id) where deleted_at is null;
create index if not exists idx_pz_tasks_live          on pz_tasks          (project_id) where deleted_at is null;
create index if not exists idx_pz_artifacts_live      on pz_artifacts      (project_id) where deleted_at is null;
create index if not exists idx_pz_agent_runs_live     on pz_agent_runs     (project_id) where deleted_at is null;
```

**2. Models — `app/models/schemas.py`**
Add one field to the shared base so every entity inherits it:
```python
class GraphEntity(BaseModel):
    id: str = Field(default_factory=new_id)
    updated_at: datetime | None = None
    deleted_at: datetime | None = None   # NEW — set = tombstone
```
`ProjectGraph` and `GraphUpsertRequest` need no shape change; tombstones ride the existing per-type lists.

**3. In-memory repo — `app/db/repository.py`**
- `upsert_graph`: unchanged mechanics (it already overwrites and stamps `updated_at`); `deleted_at` is carried through because it's now a model field.
- `get_graph`: when `since is None` (bootstrap), skip rows where `deleted_at is not None`. When `since` is set, keep current behaviour (return everything changed, tombstones included). The cursor still tracks `max(updated_at)` across returned rows.
```python
for entity in store[etype].values():
    if since is None:
        if entity.deleted_at is not None:
            continue                       # bootstrap hides dead rows
    elif entity.updated_at is None or entity.updated_at <= since:
        continue                           # incremental: unchanged rows
    rows.append(copy.deepcopy(entity))
    ...
```

**4. Supabase repo — `app/db/supabase_repository.py`**
- `upsert_graph`: unchanged (upsert of the dumped model now includes `deleted_at`).
- `get_graph`: add `.is_("deleted_at", "null")` when `since is None`; leave the `.gt("updated_at", …)` branch as-is for incremental.

**5. (Optional, deferred) tombstone GC**
Keeping tombstones forever is correct but unbounded. A later job may purge tombstones older than `TOMBSTONE_TTL_DAYS` (default 30) — safe only once every client has pulled past them. Not required for correctness; note it and defer.

### Tests — `tests/test_sync.py` (add)
- `test_delete_propagates_via_incremental_pull` — push entity, capture cursor, push same id with `deleted_at`, incremental pull returns the tombstone.
- `test_bootstrap_pull_hides_deleted` — after delete, a `since`-less pull omits the row.
- `test_recreate_after_delete` — upsert same id without `deleted_at` restores it as live.
- Existing 8 tests must stay green.

### Rollout
Migration 0002 is additive and backward-compatible — old clients that never send `deleted_at` keep working. Ship the schema and the backend together; no client change is required to *deploy*, only to *use* deletes.

### Files touched
`migrations/0002_soft_delete.sql` (new) · `app/models/schemas.py` · `app/db/repository.py` · `app/db/supabase_repository.py` · `tests/test_sync.py` · `README.md` (note the new field + pull semantics).

---

## Milestone 2 — Supabase Auth, workspaces & RLS

Depends on M1 only for migration ordering. Introduces the **workspace** tier requested: Admins create workspaces and invite members; a workspace holds many projects and carries the shared Git configuration for end-to-end dev.

### New hierarchy
```
Workspace (Admin-owned, has Git config)
  └── membership: users with role admin | member
  └── Project ── Project ── Project        (each project.workspace_id → workspace)
          └── requirement → spec → task → artifact → agent-run   (the existing graph)
```
Projects move from `owner_id`-scoped to `workspace_id`-scoped. Access is decided by **workspace membership**, not project ownership.

### Roles
- **admin** — create/rename/delete the workspace, edit Git config, invite/remove members, plus everything a member can do.
- **member** — create projects and read/write the task graph within the workspace.

(A read-only `viewer` role is a trivial later addition; omitted now to keep policy surface small.)

### ⚠️ Decision required before coding — Git credentials vs. ADR 0010 §5
ADR 0010 §5 states **credentials never live in the cloud**. "Workspace Git configuration (repository, provider, credentials)" collides with that. Resolve explicitly; recommended split:
- **Store in cloud (metadata, safe):** repo URL, provider (`github`/`gitlab`/…), default branch, and *which* auth method is used.
- **Do NOT store raw secrets in a plaintext column.** Choose one:
  - **(A, recommended) GitHub/GitLab App installation** — cloud stores an installation/app reference, not a user PAT; server mints short-lived tokens on demand. Cleanest ToS + privacy story.
  - **(B) Encrypted-at-rest PAT** via Supabase Vault / `pgsodium`, decrypted only server-side for git ops. Acceptable but raises the privacy bar ADR 0010 set.
  - **(C) Keep credentials local** — cloud holds only repo URL + provider; the desktop engine performs all git ops with its OS-keychain vault (most faithful to ADR 0010).

The schema below reserves a `git_config jsonb` for the **non-secret** metadata and a nullable `git_credential_ref text` for an *opaque reference* under option A/B — never a raw token. Pick A, B, or C before implementing; this plan assumes **A/C (no raw secret column)**.

### Changes

**1. Schema — `migrations/0003_auth_workspaces.sql`** (new)
```sql
-- Workspaces --------------------------------------------------------------
create table if not exists pz_workspaces (
    id                  uuid primary key default gen_random_uuid(),
    name                text not null,
    created_by          uuid not null,                       -- auth.users.id
    git_config          jsonb not null default '{}'::jsonb,  -- {repo_url, provider, default_branch}
    git_credential_ref  text,                                -- opaque ref (App install id), NEVER a raw token
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- Membership --------------------------------------------------------------
create table if not exists pz_workspace_members (
    workspace_id  uuid not null references pz_workspaces (id) on delete cascade,
    user_id       uuid not null,                             -- auth.users.id
    role          text not null default 'member',            -- 'admin' | 'member'
    invited_by    uuid,
    created_at    timestamptz not null default now(),
    primary key (workspace_id, user_id)
);
create index if not exists idx_pz_members_user on pz_workspace_members (user_id);

-- Invitations -------------------------------------------------------------
create table if not exists pz_invitations (
    id            uuid primary key default gen_random_uuid(),
    workspace_id  uuid not null references pz_workspaces (id) on delete cascade,
    email         text not null,
    role          text not null default 'member',
    token         text not null unique,
    status        text not null default 'pending',           -- pending | accepted | revoked | expired
    invited_by    uuid not null,
    expires_at    timestamptz not null,
    created_at    timestamptz not null default now()
);
create index if not exists idx_pz_invitations_ws on pz_invitations (workspace_id);

-- Projects gain a workspace --------------------------------------------------
alter table pz_projects add column if not exists workspace_id uuid references pz_workspaces (id) on delete cascade;
alter table pz_projects add column if not exists created_by   uuid;   -- was owner_id (text stub); keep owner_id during backfill
create index if not exists idx_pz_projects_workspace on pz_projects (workspace_id);
```

**Backfill (one-off, run inside 0003 or a follow-up script):** for each distinct legacy `owner_id`, create a personal workspace, insert that user as `admin` in `pz_workspace_members`, and set every one of their projects' `workspace_id`. After backfill, `workspace_id` becomes `not null` and `owner_id` is dropped in a later cleanup migration.

**2. RLS — same migration, after tables exist**
Backend switches from the service key to **forwarding the caller's JWT** so Postgres enforces membership (defense in depth beneath the app-layer checks). Helper + policies:
```sql
alter table pz_workspaces        enable row level security;
alter table pz_workspace_members enable row level security;
alter table pz_projects          enable row level security;
alter table pz_requirements      enable row level security;
alter table pz_spec_documents    enable row level security;
alter table pz_tasks             enable row level security;
alter table pz_artifacts         enable row level security;
alter table pz_agent_runs        enable row level security;

-- Membership predicate reused everywhere.
create or replace function pz_is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pz_workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

-- Workspace visible to its members; writable by admins.
create policy pz_ws_read   on pz_workspaces for select using (pz_is_member(id));
create policy pz_ws_write  on pz_workspaces for all
  using  (exists (select 1 from pz_workspace_members m
                  where m.workspace_id = id and m.user_id = auth.uid() and m.role = 'admin'))
  with check (created_by = auth.uid());

-- Projects and every graph table: scoped through the project's workspace.
create policy pz_projects_rw on pz_projects for all
  using (pz_is_member(workspace_id)) with check (pz_is_member(workspace_id));

-- Graph tables (repeat for requirements/spec_documents/tasks/artifacts/agent_runs):
create policy pz_tasks_rw on pz_tasks for all
  using (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)))
  with check (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)));
```

**3. Config — `app/config.py` + `.env.example`**
```python
auth_mode: Literal["stub", "supabase"] = "stub"   # tests keep "stub"
supabase_jwt_secret: str = ""                      # HS256 secret from Supabase project settings
```
`require_supabase()` gains: when `auth_mode == "supabase"`, `supabase_jwt_secret` must be set.

**4. Auth dependency — `app/dependencies.py`**
Replace the stub with JWT validation, keeping the stub path for tests:
```python
def get_current_user(request: Request,
                     authorization: str | None = Header(default=None),
                     x_user_id: str | None = Header(default=None)) -> User:
    settings = request.app.state.settings
    if settings.auth_mode == "stub":
        uid = x_user_id or "dev-user"
        return User(id=uid, email=f"{uid}@promptzone.local")
    # supabase: verify HS256 bearer JWT (pyjwt), aud="authenticated"
    token = (authorization or "").removeprefix("Bearer ").strip()
    try:
        claims = jwt.decode(token, settings.supabase_jwt_secret,
                            algorithms=["HS256"], audience="authenticated")
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid_token")
    return User(id=claims["sub"], email=claims.get("email", ""))
```
Add `PyJWT>=2.8,<3` to `requirements.txt`.

**5. Authorization — replace owner-only checks in `app/api/sync.py`**
`_require_project` becomes a membership check: load the project, then verify `get_current_user` is a member of `project.workspace_id` (403 otherwise). Add a `_require_admin(workspace_id, user)` guard for workspace/invite mutations. Repository gains `get_membership(workspace_id, user_id) -> Role | None`.

**6. New router — `app/api/workspaces.py`**
| Method | Path | Guard | Purpose |
|---|---|---|---|
| POST | `/workspaces` | any authed user (becomes admin) | create workspace + self as admin |
| GET | `/workspaces` | authed | list caller's workspaces |
| GET | `/workspaces/{id}` | member | fetch (incl. git_config) |
| PATCH | `/workspaces/{id}` | admin | rename / set git_config |
| GET | `/workspaces/{id}/members` | member | list members |
| POST | `/workspaces/{id}/invitations` | admin | invite by email (token, expiry) |
| POST | `/invitations/{token}/accept` | authed | join → member row |
| DELETE | `/workspaces/{id}/members/{user_id}` | admin | remove member |

`POST /projects` gains a required `workspace_id` in `ProjectCreate`; creation is gated on membership.

**7. Repository seam — `app/db/repository.py` + both impls**
Add abstract methods: `create_workspace`, `list_workspaces(user_id)`, `get_workspace`, `update_workspace`, `add_member`, `get_membership`, `list_members`, `create_invitation`, `accept_invitation`. Implement in both `InMemoryRepository` (dicts) and `SupabaseRepository` (tables + JWT-scoped client).

**8. JWT-scoped Supabase client**
`SupabaseRepository` must attach the caller's JWT (via PostgREST `Authorization` header / `postgrest.auth(token)`) so RLS applies per request, rather than using the service key for user data. Construct/patch the client per-request or set the token on the shared client before each call.

### Tests — `tests/test_workspaces.py` (new) + updates
- `test_create_workspace_makes_creator_admin`
- `test_member_can_access_projects_in_workspace`
- `test_non_member_cannot_access_workspace_projects` (403)
- `test_only_admin_can_invite_and_edit_git_config`
- `test_invitation_accept_adds_member`
- `test_cross_workspace_isolation`
- `test_jwt_required_when_auth_mode_supabase` (401 on missing/invalid token) — mint a test HS256 token with the configured secret.
- Update `test_sync.py`/`conftest.py`: keep `auth_mode="stub"` so existing graph tests use `X-User-Id`; add a workspace fixture since `POST /projects` now needs `workspace_id`.

### Rollout order
1. Ship migration 0003 (tables + `projects.workspace_id` nullable) and the **backfill**.
2. Deploy backend with `auth_mode` still `stub`, workspace endpoints live, `workspace_id` optional — verify.
3. Enable RLS + flip `auth_mode=supabase` + JWT-scoped client together (RLS and real identity must land in the same cutover).
4. Cleanup migration: `workspace_id not null`, drop legacy `owner_id`.

### Files touched
`migrations/0003_auth_workspaces.sql` (new) · `app/config.py` · `.env.example` · `app/dependencies.py` · `app/api/sync.py` · `app/api/workspaces.py` (new) · `app/models/schemas.py` (Workspace/Member/Invitation models, `ProjectCreate.workspace_id`, `Project.workspace_id`) · `app/db/repository.py` · `app/db/supabase_repository.py` · `requirements.txt` (PyJWT) · `tests/test_workspaces.py` (new) · `tests/conftest.py` · `README.md`.

---

## Sequencing summary
1. **M1 soft-delete** — self-contained, additive, unblocks correct convergence. Ship first.
2. **M2 auth + workspaces + RLS** — larger; gated cutover (RLS + JWT together). The Git-credential decision (A/B/C) must be made before M2 coding starts.

## Open decisions to confirm
- Git credential handling: **A (App install) / B (encrypted) / C (local-only)** — plan assumes no raw secret in the cloud.
- Whether a read-only `viewer` role is needed at launch (currently omitted).
- Tombstone GC / retention window (M1 defers; default proposed 30 days).
