"""Supabase-backed repository.

Persists the task graph to Postgres via the Supabase client. Table names are
prefixed `pz_` and match the migrations under `migrations/`. The `supabase`
package is imported lazily so the rest of the app runs without it installed.

Conflict policy: field-level merge with declared ownership (M3). The pure merge
engine lives in `app/db/merge.py`; this repo reads the stored row, merges, and
writes the result back.

Auth: two clients, and which one a call uses is decided by the table it
names, not by the call site (`_table` below). The seven graph tables in
`_SERVICE_ONLY_TABLES` always go through the service-role client, because
migration 0031 revoked them from `authenticated` and `anon` outright — the
server is their only writer (plan 0014, Option A). Everything else goes
through `_client`, which `for_user` swaps onto the caller's own JWT so
Postgres RLS really does scope those tables per request.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.db.merge import _as_dt, merge_entity
from app.db.merge import incoming_dump as _incoming_dump
from app.db.merge import unwritten_fields as _unwritten_fields
from app.db.repository import CrossProjectWrite, Repository, TrackerAccountConflict
from app.models.schemas import (
    ENTITY_TYPES,
    FIELD_AUTHORITY,
    FIELD_DEFAULTS,
    Artifact,
    ArtifactKind,
    AssignedTask,
    CodeChunkHit,
    Deployment,
    DeploymentConfig,
    DeploymentState,
    Document,
    GenerationRun,
    GraphEntity,
    GraphUpsertRequest,
    Invitation,
    InvitationStatus,
    ModelConnection,
    PolicyScope,
    Project,
    ProjectGraph,
    PullRequest,
    RagChunkHit,
    RepoWebhook,
    Requirement,
    Role,
    SpecDocument,
    StageDocument,
    Task,
    TaskLink,
    TaskStatus,
    Workspace,
    WorkspaceIntegration,
    WorkspaceMember,
    new_id,
    utcnow,
)


def _pg_filter_value(value: str) -> str:
    """Quote a value for use inside a composed PostgREST filter expression.

    Plain `.eq()`/`.gt()` calls take a value the client encodes for us, but an
    `or=(...)` group is one string whose commas and parentheses are grammar.
    A client-supplied `after_id` must not be able to reach that grammar, so it
    goes in double quotes with `"` and `\\` escaped — which is also what makes a
    timestamp's own punctuation safe.
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


_TABLE = {
    "requirements": "pz_requirements",
    "spec_documents": "pz_spec_documents",
    "tasks": "pz_tasks",
    "artifacts": "pz_artifacts",
    "agent_runs": "pz_agent_runs",
    "discussions": "pz_discussions",
}
_PROJECTS = "pz_projects"
_WORKSPACES = "pz_workspaces"
_MEMBERS = "pz_workspace_members"
_INVITATIONS = "pz_invitations"
_TASK_LINKS = "pz_task_links"
_MODEL_CONNECTIONS = "pz_workspace_model_connections"
_RAG_CHUNKS = "pz_rag_chunks"
_RAG_MATCH_RPC = "pz_rag_match_chunks"
_PULL_REQUESTS = "pz_pull_requests"
_CODE_CHUNKS = "pz_code_chunks"
_CODE_MATCH_RPC = "pz_code_match_chunks"
_DOCUMENTS = "pz_documents"
_GENERATION_RUNS = "pz_generation_runs"
_STAGE_DOCUMENTS = "pz_stage_documents"
_REPO_WEBHOOKS = "pz_repo_webhooks"
_WORKSPACE_INTEGRATIONS = "pz_workspace_integrations"
_DEPLOYMENTS = "pz_deployments"
_DEPLOYMENT_TASKS = "pz_deployment_tasks"
# Migration 0033. The only writer of _DEPLOYMENT_TASKS: the replace and the
# state stamp are one transaction, and the "already frozen" test happens under
# a row lock rather than in this process between two round trips.
_FREEZE_DEPLOYMENT_TASKS_RPC = "pz_freeze_deployment_tasks"

# The seven tables migration 0031 revoked from `authenticated` and `anon`
# (plan 0014, Option A). `authenticated` can no longer touch them at all, so
# every call against one must carry the service-role key or fail with
# `permission denied for table ...` — including calls made on behalf of a
# signed-in user, which is every graph write in production.
#
# pz_discussions belongs here for the same reason as the other six, though
# plan 0014's matrix didn't enumerate it: plan 0015's rules that a comment is
# an attributed statement — nobody may post as somebody else
# (discussion_author_forbidden) or overwrite another member's
# (discussion_forbidden) — live in app/api/_guards.py and nowhere else, while
# 0011_discussions.sql granted `authenticated` full DML behind a
# membership-only policy. Same bypass class, same fix.
#
# Membership and role are still enforced, by app/api/_guards.py and
# app/api/sync.py, before any of these methods is reached. What changes is
# that they are now the *only* enforcement, which is the trade Option A makes
# explicit: the rules stop being half-expressed in SQL as a membership test
# that never matched what the API actually required.
#
# Keyed by table name on purpose. The alternative — picking a client at each
# of the 85 call sites, or per method — makes correctness a thing every
# future method has to remember. Here the routing follows from the name the
# call already passes, so a new method reaching a graph table gets the right
# client without knowing this rule exists.
_SERVICE_ONLY_TABLES = frozenset(
    {
        "pz_requirements",
        "pz_spec_documents",
        "pz_tasks",
        "pz_artifacts",
        "pz_agent_runs",
        "pz_stage_documents",
        "pz_discussions",
        # Not graph tables, but the same posture for the same reason. Migration
        # 0032 hands `authenticated` a column-level SELECT on
        # pz_workspace_integrations' non-secret columns and nothing else, so the
        # server must reach it — including to write it, and including to read
        # `webhook_secret_ref` — on the service-role client. pz_task_links is
        # revoked outright by the same migration, because its `account_key` is
        # now a tenant boundary the webhook routes on and its only policy tested
        # workspace membership: a member could otherwise plant a row naming
        # another tenant's account and squat their (provider, account_key,
        # external_key) triple.
        "pz_workspace_integrations",
        "pz_task_links",
    }
)


class SupabaseRepository(Repository):
    backend_name = "supabase"

    def __init__(self, url: str, key: str) -> None:
        from supabase import create_client  # lazy import

        self._url = url
        self._key = key
        self._client = create_client(url, key)
        # This instance is built from `key`, the base SUPABASE_KEY, which is a
        # service-role key in production (app/main.py::_build_repository). So
        # on the shared instance the two clients are the same object; they
        # diverge only in the copy `for_user` returns.
        self._service_client = self._client

    def for_user(self, token: str) -> SupabaseRepository:
        """Return a *new* repository whose PostgREST calls carry the caller's
        JWT so RLS applies per request — for every table except the seven in
        `_SERVICE_ONLY_TABLES`, which keep the service-role client.

        The carve-out is not an optimisation. Migration 0031 left
        `authenticated` with no privilege at all on those tables, so a scoped
        client reaching one gets `permission denied for table ...`, not a
        narrower view. Scoping stays real, and still worth having, for the
        tables outside that set — pz_workspaces, pz_workspace_members,
        pz_projects, pz_invitations, pz_documents and the rest — where RLS at
        least enforces workspace membership, and on the two membership tables
        the admin rule too.

        Must not mutate `self._client` in place: `app.state.repository` is one
        shared instance across all concurrent requests (see
        app/dependencies.py::get_repository, which calls this per-request) —
        an in-place `.postgrest.auth(token)` would let one request's identity
        leak into a concurrent request's queries. This was previously dead
        code (never called from any route) and had this exact bug; found and
        fixed while verifying apps/cloud against a real local Supabase
        instance (docs/plans/0004) for the first time. The same reasoning
        applies to `_service_client`: the scoped copy points at *this*
        instance's unscoped client rather than building a second one, so no
        token is ever attached to the object graph writes go through.
        """
        scoped = SupabaseRepository(self._url, self._key)
        scoped._client.postgrest.auth(token)
        scoped._service_client = self._service_client
        return scoped

    def _table(self, name: str):
        """PostgREST query builder for `name`, on whichever client that table
        is reachable from. The single place the scoped/service decision is
        made — see `_SERVICE_ONLY_TABLES`."""
        client = self._service_client if name in _SERVICE_ONLY_TABLES else self._client
        return client.table(name)

    # -- workspaces ------------------------------------------------------- #
    def create_workspace(
        self, name: str, created_by: str, created_by_email: str | None = None
    ) -> Workspace:
        ws = Workspace(name=name, created_by=created_by)
        # `returning="minimal"`: Postgres subjects INSERT...RETURNING to the
        # table's SELECT policy too, and `pz_ws_read` requires membership —
        # which doesn't exist yet (add_member runs next). The insert itself
        # is fine (WITH CHECK only needs created_by = auth.uid()); asking
        # Postgres to hand the row back is what RLS was rejecting. The
        # caller already has `ws` locally, so nothing is lost by not asking.
        # Found by running this against a real local Supabase instance
        # (docs/plans/0004) — the in-memory backend's tests never exercise
        # RLS and couldn't have caught this.
        self._table(_WORKSPACES).insert(_dump(ws), returning="minimal").execute()
        self.add_member(
            ws.id, created_by, Role.admin, invited_by=created_by, email=created_by_email
        )
        return ws

    def get_workspace(self, workspace_id: str) -> Workspace | None:
        res = self._table(_WORKSPACES).select("*").eq("id", workspace_id).limit(1).execute()
        rows = res.data or []
        return Workspace(**rows[0]) if rows else None

    def list_workspaces(self, user_id: str) -> list[Workspace]:
        mem = self._table(_MEMBERS).select("workspace_id").eq("user_id", user_id).execute()
        ids = [m["workspace_id"] for m in (mem.data or [])]
        if not ids:
            return []
        res = self._table(_WORKSPACES).select("*").in_("id", ids).execute()
        return [Workspace(**row) for row in (res.data or [])]

    def update_workspace(
        self,
        workspace_id: str,
        *,
        name: str | None = None,
        git_config: dict | None = None,
        integration_config: dict | None = None,
        rag_index_pmo_discussions: bool | None = None,
    ) -> Workspace:
        patch: dict = {"updated_at": utcnow().isoformat()}
        if name is not None:
            patch["name"] = name
        if git_config is not None:
            patch["git_config"] = git_config
        if integration_config is not None:
            patch["integration_config"] = integration_config
        if rag_index_pmo_discussions is not None:
            patch["rag_index_pmo_discussions"] = rag_index_pmo_discussions
        self._table(_WORKSPACES).update(patch).eq("id", workspace_id).execute()
        ws = self.get_workspace(workspace_id)
        if ws is None:
            raise KeyError(workspace_id)
        return ws

    def upsert_repo_webhook(self, webhook: RepoWebhook) -> RepoWebhook:
        self._table(_REPO_WEBHOOKS).upsert(
            _dump(webhook), on_conflict="repo_full_name", returning="minimal"
        ).execute()
        return webhook

    def create_repo_webhook_if_absent(self, webhook: RepoWebhook) -> tuple[RepoWebhook, bool]:
        # PostgreSQL serializes competing INSERT ... ON CONFLICT DO NOTHING
        # statements on the primary key. Read after it so both callers use the
        # first stored secret rather than racing to overwrite it with upsert.
        res = self._table(_REPO_WEBHOOKS).upsert(
            _dump(webhook),
            on_conflict="repo_full_name",
            ignore_duplicates=True,
            returning="representation",
        ).execute()
        if res.data:
            return RepoWebhook(**res.data[0]), True
        stored = self.get_repo_webhook(webhook.repo_full_name)
        if stored is None:
            raise RuntimeError("repo webhook binding disappeared after insert")
        return stored, False

    def claim_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        res = (
            self._table(_REPO_WEBHOOKS)
            .update({"registration_owner": owner}, returning="representation")
            .eq("repo_full_name", webhook.repo_full_name)
            .eq("project_id", webhook.project_id)
            .eq("workspace_id", webhook.workspace_id)
            .eq("secret_ref", webhook.secret_ref)
            .eq("registration_state", "pending")
            .is_("registration_owner", "null")
            .execute()
        )
        return bool(res.data)

    def release_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        res = (
            self._table(_REPO_WEBHOOKS)
            .update({"registration_owner": None}, returning="representation")
            .eq("repo_full_name", webhook.repo_full_name)
            .eq("secret_ref", webhook.secret_ref)
            .eq("registration_state", "pending")
            .eq("registration_owner", owner)
            .execute()
        )
        return bool(res.data)

    def confirm_pending_repo_webhook(self, webhook: RepoWebhook, owner: str) -> bool:
        res = (
            self._table(_REPO_WEBHOOKS)
            .update(
                {"registration_state": "confirmed", "registration_owner": None},
                returning="representation",
            )
            .eq("repo_full_name", webhook.repo_full_name)
            .eq("secret_ref", webhook.secret_ref)
            .eq("registration_state", "pending")
            .eq("registration_owner", owner)
            .execute()
        )
        return bool(res.data)

    def delete_repo_webhook_if_matches(self, webhook: RepoWebhook, owner: str) -> bool:
        # Match the binding identity and its unique ciphertext so a delayed
        # cleanup cannot delete a newer or another project's binding.
        res = (
            self._table(_REPO_WEBHOOKS)
            .delete(returning="representation")
            .eq("repo_full_name", webhook.repo_full_name)
            .eq("project_id", webhook.project_id)
            .eq("workspace_id", webhook.workspace_id)
            .eq("secret_ref", webhook.secret_ref)
            .eq("registration_state", "pending")
            .eq("registration_owner", owner)
            .execute()
        )
        return bool(res.data)

    def get_repo_webhook(self, repo_full_name: str) -> RepoWebhook | None:
        res = (
            self._table(_REPO_WEBHOOKS)
            .select("*")
            .eq("repo_full_name", repo_full_name)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return RepoWebhook(**rows[0]) if rows else None

    def get_membership(self, workspace_id: str, user_id: str) -> Role | None:
        res = (
            self._table(_MEMBERS)
            .select("role")
            .eq("workspace_id", workspace_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return Role(rows[0]["role"]) if rows else None

    def list_members(self, workspace_id: str) -> list[WorkspaceMember]:
        res = self._table(_MEMBERS).select("*").eq("workspace_id", workspace_id).execute()
        return [WorkspaceMember(**row) for row in (res.data or [])]

    def add_member(
        self,
        workspace_id: str,
        user_id: str,
        role: Role,
        invited_by: str | None = None,
        email: str | None = None,
    ) -> WorkspaceMember:
        member = WorkspaceMember(
            workspace_id=workspace_id,
            user_id=user_id,
            role=role,
            invited_by=invited_by,
            email=email,
        )
        # returning="minimal": same RLS-vs-RETURNING issue as create_workspace
        # above — the SELECT policy (pz_members_read) can't see a just-added
        # member for RETURNING's benefit in every case (e.g. the bootstrap
        # add), and the caller already has `member` locally.
        self._table(_MEMBERS).upsert(
            _dump(member), on_conflict="workspace_id,user_id", returning="minimal"
        ).execute()
        return member

    def remove_member(self, workspace_id: str, user_id: str) -> None:
        self._table(_MEMBERS).delete().eq("workspace_id", workspace_id).eq(
            "user_id", user_id
        ).execute()

    def create_invitation(self, invitation: Invitation) -> Invitation:
        self._table(_INVITATIONS).insert(_dump(invitation), returning="minimal").execute()
        return invitation

    def get_invitation(self, token: str) -> Invitation | None:
        res = self._table(_INVITATIONS).select("*").eq("token", token).limit(1).execute()
        rows = res.data or []
        return Invitation(**rows[0]) if rows else None

    def accept_invitation(self, token: str, user_id: str) -> WorkspaceMember:
        inv = self.get_invitation(token)
        if inv is None:
            raise KeyError("invitation_not_found")
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        if inv.expires_at <= utcnow():
            self._table(_INVITATIONS).update({"status": "expired"}).eq(
                "token", token
            ).execute()
            raise ValueError("invitation_expired")
        self._table(_INVITATIONS).update({"status": "accepted"}).eq("token", token).execute()
        return self.add_member(
            inv.workspace_id, user_id, inv.role, invited_by=inv.invited_by, email=inv.email
        )

    # -- projects --------------------------------------------------------- #
    def create_project(
        self,
        workspace_id: str,
        created_by: str,
        name: str,
        *,
        repo_url: str | None = None,
        repo_default_branch: str | None = None,
        repo_id: int | None = None,
    ) -> Project:
        project = Project(
            name=name,
            workspace_id=workspace_id,
            owner_id=created_by,
            repo_url=repo_url,
            repo_default_branch=repo_default_branch,
            repo_id=repo_id,
        )
        self._table(_PROJECTS).insert(_dump(project), returning="minimal").execute()
        return project

    def get_project(self, project_id: str) -> Project | None:
        res = self._table(_PROJECTS).select("*").eq("id", project_id).limit(1).execute()
        rows = res.data or []
        return Project(**rows[0]) if rows else None

    def find_project_by_repo_id(self, repo_id: int) -> Project | None:
        res = self._table(_PROJECTS).select("*").eq("repo_id", repo_id).limit(1).execute()
        rows = res.data or []
        return Project(**rows[0]) if rows else None

    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project:
        patch = {"lifecycle_status": status, "updated_at": utcnow().isoformat()}
        self._table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def update_project_repo(
        self, project_id: str, repo_url: str, repo_id: int, default_branch: str
    ) -> Project:
        patch = {
            "repo_url": repo_url,
            "repo_id": repo_id,
            "repo_default_branch": default_branch,
            "updated_at": utcnow().isoformat(),
        }
        self._table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def update_project_policy_scope(self, project_id: str, scope: PolicyScope | None) -> Project:
        patch = {
            "policy_scope": scope.model_dump(mode="json") if scope is not None else None,
            "updated_at": utcnow().isoformat(),
        }
        self._table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def update_project_deployment_config(
        self, project_id: str, config: DeploymentConfig | None
    ) -> Project:
        patch = {
            "deployment_config": config.model_dump(mode="json") if config is not None else None,
            "updated_at": utcnow().isoformat(),
        }
        self._table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def update_project_deployment_state(self, project_id: str, state: DeploymentState) -> Project:
        patch = {
            "deployment_state": state.model_dump(mode="json"),
            "updated_at": utcnow().isoformat(),
        }
        self._table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def upsert_deployment(self, deployment: Deployment) -> Deployment:
        """Upsert on the (project_id, external_key) unique constraint from
        migration 0026 — one deploy reports several times, and each report
        must land on the same row."""
        existing = self._get_deployment(deployment.project_id, deployment.external_key)
        if existing is not None:
            # attribution_state/attributed_at are owned by
            # pz_freeze_deployment_tasks, never by the delivery this row was
            # built from. Carrying them forward is what stops a redelivery
            # from writing the model default over a frozen row (plan 0024 M2).
            deployment = deployment.model_copy(
                update={
                    "id": existing.id,
                    "created_at": existing.created_at,
                    "updated_at": utcnow(),
                    "attribution_state": existing.attribution_state,
                    "attributed_at": existing.attributed_at,
                }
            )
        self._table(_DEPLOYMENTS).upsert(
            _dump(deployment), on_conflict="project_id,external_key"
        ).execute()
        return deployment

    def _get_deployment(self, project_id: str, external_key: str) -> Deployment | None:
        res = (
            self._table(_DEPLOYMENTS)
            .select("*")
            .eq("project_id", project_id)
            .eq("external_key", external_key)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return Deployment(**rows[0]) if rows else None

    def list_deployments(self, project_id: str, limit: int = 10) -> list[Deployment]:
        res = (
            self._table(_DEPLOYMENTS)
            .select("*")
            .eq("project_id", project_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [Deployment(**row) for row in (res.data or [])]

    def get_latest_deployment(self, project_id: str) -> Deployment | None:
        rows = self.list_deployments(project_id, limit=1)
        return rows[0] if rows else None

    def freeze_deployment_tasks(
        self, deployment_id: str, task_ids: list[str], now: datetime
    ) -> bool:
        # Exactly one round trip, and never a bare delete. The delete, the
        # insert and the state stamp happen inside pz_freeze_deployment_tasks
        # (migration 0033) so they cannot come apart: the previous shape
        # issued the delete and the insert as two PostgREST calls, and a
        # failure between them erased the record of what shipped rather than
        # leaving the stale-but-true one in place.
        #
        # The "already frozen" test is inside the function too, under a `for
        # update` row lock — not here. Checking it in Python would reintroduce
        # the race the lock exists to close, since two concurrent deliveries
        # of the same terminal event would both read 'uncomputed' before
        # either wrote.
        #
        # `now` is unused: the function stamps attributed_at with the
        # database's own now(), which is the clock the rest of the row is
        # written against. The parameter stays in the signature because the
        # in-memory adapter has no such clock and the contract suite drives
        # both through one interface.
        res = self._client.rpc(
            _FREEZE_DEPLOYMENT_TASKS_RPC,
            {"p_deployment_id": deployment_id, "p_task_ids": list(task_ids)},
        ).execute()
        return bool(res.data)

    def clear_deployment_attribution(self, deployment_id: str) -> bool:
        res = (
            self._table(_DEPLOYMENTS)
            .update({"attribution_state": "uncomputed", "attributed_at": None})
            .eq("id", deployment_id)
            .execute()
        )
        return bool(res.data)

    def list_deployment_tasks(self, deployment_id: str) -> list[str]:
        res = (
            self._table(_DEPLOYMENT_TASKS)
            .select("task_id,position")
            .eq("deployment_id", deployment_id)
            .order("position")
            .execute()
        )
        return [row["task_id"] for row in (res.data or [])]

    def list_stale_deployments(self, older_than: datetime, limit: int = 50) -> list[Deployment]:
        res = (
            self._table(_DEPLOYMENTS)
            .select("*")
            .not_.in_("state", ["live", "failed", "inactive"])
            .lt("updated_at", older_than.isoformat())
            .order("updated_at")
            .limit(limit)
            .execute()
        )
        return [Deployment(**row) for row in (res.data or [])]

    def list_projects(self, user_id: str) -> list[Project]:
        mem = self._table(_MEMBERS).select("workspace_id").eq("user_id", user_id).execute()
        ids = [m["workspace_id"] for m in (mem.data or [])]
        if not ids:
            return []
        res = self._table(_PROJECTS).select("*").in_("workspace_id", ids).execute()
        return [Project(**row) for row in (res.data or [])]

    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]:
        res = self._table(_PROJECTS).select("*").eq("workspace_id", workspace_id).execute()
        return [Project(**row) for row in (res.data or [])]

    def list_assigned_tasks(
        self,
        user_id: str,
        workspace_id: str | None = None,
        statuses: list[TaskStatus] | None = None,
        limit: int = 200,
    ) -> list[AssignedTask]:
        # Membership first: the workspace set bounds everything below, and it
        # is also the guard — an assignment outlives a membership removal, so
        # the assigned_user_id filter alone would leak a removed member's rows.
        mem = self._table(_MEMBERS).select("workspace_id").eq("user_id", user_id).execute()
        ws_ids = {m["workspace_id"] for m in (mem.data or [])}
        if workspace_id is not None:
            ws_ids &= {workspace_id}
        if not ws_ids:
            return []

        q = (
            self._table(_TABLE["tasks"])
            .select("*")
            .eq("assigned_user_id", user_id)
            .is_("deleted_at", "null")
        )
        if statuses:
            q = q.in_("status", [s.value for s in statuses])
        rows = (q.limit(limit).execute().data) or []
        if not rows:
            return []

        project_ids = {r["project_id"] for r in rows}
        pres = self._table(_PROJECTS).select("*").in_("id", list(project_ids)).execute()
        projects = {
            p["id"]: Project(**p)
            for p in (pres.data or [])
            if p["workspace_id"] in ws_ids
        }
        if not projects:
            return []
        wres = (
            self._table(_WORKSPACES)
            .select("id,name")
            .in_("id", list({p.workspace_id for p in projects.values()}))
            .execute()
        )
        ws_names = {w["id"]: w["name"] for w in (wres.data or [])}

        out: list[AssignedTask] = []
        for row in rows:
            project = projects.get(row["project_id"])
            if project is None:
                continue
            out.append(
                AssignedTask(
                    task=Task(**row),
                    project_id=project.id,
                    project_name=project.name,
                    workspace_id=project.workspace_id,
                    workspace_name=ws_names.get(project.workspace_id, ""),
                    repo_url=project.repo_url,
                )
            )
        out.sort(key=lambda a: (a.project_name, a.task.feature_tag or "", a.task.id))
        return out

    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        query = self._table(_INVITATIONS).select("*").eq("workspace_id", workspace_id)
        if status is not None:
            query = query.eq("status", status.value)
        res = query.execute()
        return [Invitation(**row) for row in (res.data or [])]

    def list_invitations_for_email(
        self, email: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        target = email.strip().lower()
        # `ilike` treats % and _ as wildcards, so an address containing them
        # would over-match; the Python re-filter below makes the comparison
        # exact regardless.
        query = self._table(_INVITATIONS).select("*").ilike("email", target)
        if status is not None:
            query = query.eq("status", status.value)
        res = query.execute()
        rows = [Invitation(**row) for row in (res.data or [])]
        return [i for i in rows if i.email.strip().lower() == target]

    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation:
        res = (
            self._table(_INVITATIONS)
            .select("*")
            .eq("id", invitation_id)
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        if not rows:
            raise KeyError("invitation_not_found")
        inv = Invitation(**rows[0])
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        self._table(_INVITATIONS).update({"status": "revoked"}).eq(
            "id", invitation_id
        ).execute()
        inv.status = InvitationStatus.revoked
        return inv

    # -- graph ------------------------------------------------------------ #
    def upsert_graph(
        self,
        project_id: str,
        payload: GraphUpsertRequest,
        source: str = "pz",
        seed_fields: frozenset[str] = frozenset(),
    ) -> tuple[dict[str, int], dict[str, list[str]]]:
        counts: dict[str, int] = {}
        conflicts: dict[str, list[str]] = {}
        now = utcnow()
        # Pass 1: read every stored row *and* refuse the whole write if an id
        # belongs to another project. The lookup is by id alone because that is
        # what the upsert below collides on — scoping this read to the project
        # without the refusal would be worse, not better: the merge would take
        # its creation branch and the upsert would then overwrite the other
        # project's row wholesale, `project_id` included. Rows are cached here so
        # the validation costs no extra round trip (plan 0015, review round 2).
        stored_rows: dict[tuple[str, str], dict | None] = {}
        for etype in ENTITY_TYPES:
            for item in getattr(payload, etype):
                row = self._fetch_row(etype, item.id)
                if row is not None and row.get("project_id") != project_id:
                    raise CrossProjectWrite(etype, item.id, row.get("project_id"))
                stored_rows[(etype, item.id)] = row
        for etype in ENTITY_TYPES:
            items = getattr(payload, etype)
            if not items:
                continue
            authority = FIELD_AUTHORITY.get(etype, {})
            defaults = FIELD_DEFAULTS.get(etype, {})
            rows = []
            for item in items:
                stored = stored_rows[(etype, item.id)]
                incoming = _incoming_dump(item)
                merged, dropped = merge_entity(
                    stored,
                    incoming,
                    authority,
                    source,
                    now,
                    defaults,
                    _unwritten_fields(item),
                    seed_fields,
                )
                merged["project_id"] = project_id
                rows.append(merged)
                if dropped:
                    conflicts[item.id] = dropped
            self._table(_TABLE[etype]).upsert(rows, returning="minimal").execute()
            counts[etype] = len(rows)
        if counts:
            self._table(_PROJECTS).update({"updated_at": now.isoformat()}).eq(
                "id", project_id
            ).execute()
        return counts, conflicts

    def _fetch_row(self, etype: str, entity_id: str) -> dict | None:
        """The row for this id, from *any* project — deliberately unscoped, since
        the id is the primary key an upsert collides on. Every caller compares
        `project_id` itself and refuses a foreign row (`upsert_graph`,
        `assign_task`, `set_task_status`); none may assume otherwise."""
        res = self._table(_TABLE[etype]).select("*").eq("id", entity_id).limit(1).execute()
        rows = res.data or []
        return rows[0] if rows else None

    def get_graph(
        self,
        project_id: str,
        since: datetime | None = None,
        limit: int | None = None,
        after_ts: datetime | None = None,
        after_id: str | None = None,
    ) -> ProjectGraph:
        project = self.get_project(project_id)
        if project is None:
            raise KeyError(project_id)
        graph = ProjectGraph(project=project)

        # Gather candidates across all entity types, then order globally by
        # (updated_at, id) so a `limit` yields a stable keyset page. Mirrors
        # InMemoryRepository.get_graph; the contract both implement is stated on
        # Repository.get_graph.
        candidates: list[tuple[datetime, str, str, GraphEntity]] = []
        for etype, model in ENTITY_TYPES.items():
            query = self._table(_TABLE[etype]).select("*").eq("project_id", project_id)
            if since is not None:
                # Incremental pull: everything changed, tombstones included.
                query = query.gt("updated_at", since.isoformat())
            else:
                # Bootstrap pull: live rows only.
                query = query.is_("deleted_at", "null")
            if after_ts is not None:
                # Keyset lower bound, exclusive, pushed into SQL *in full*. An
                # inclusive bound refined in Python after Postgres has applied
                # the limit can return a page made up entirely of rows the
                # client already holds — an empty page, reported as drained,
                # with unseen rows waiting behind it (plan 0013).
                ts = _pg_filter_value(after_ts.isoformat())
                if after_id is None:
                    query = query.gt("updated_at", after_ts.isoformat())
                else:
                    query = query.or_(
                        f"updated_at.gt.{ts},"
                        f"and(updated_at.eq.{ts},id.gt.{_pg_filter_value(after_id)})"
                    )
            query = query.order("updated_at").order("id")
            if limit is not None:
                # Per-table over-fetch bound, not the page size: the merged page
                # can never need more than `limit` rows from one table, and the
                # +1 is what tells `has_more` apart from drained when a single
                # table holds exactly a page's worth of matching rows.
                query = query.limit(limit + 1)
            res = query.execute()
            for row in res.data or []:
                entity = model(**row)
                if entity.updated_at is None:
                    continue
                # The same exclusive bound as the push-down above, so the merge
                # is correct on its own terms rather than trusting the filter.
                if after_ts is not None:
                    if entity.updated_at < after_ts:
                        continue
                    if entity.updated_at == after_ts and (
                        after_id is None or entity.id <= after_id
                    ):
                        continue
                candidates.append((entity.updated_at, entity.id, etype, entity))

        candidates.sort(key=lambda c: (c[0], c[1]))
        truncated = limit is not None and len(candidates) > limit
        if limit is not None:
            candidates = candidates[:limit]

        rows_by_type: dict[str, list] = {etype: [] for etype in ENTITY_TYPES}
        last: tuple[datetime, str] | None = None
        for ts_value, eid, etype, entity in candidates:
            rows_by_type[etype].append(entity)
            last = (ts_value, eid)
        for etype in ENTITY_TYPES:
            setattr(graph, etype, rows_by_type[etype])

        graph.cursor = last[0] if last else (after_ts if after_ts else since)
        if truncated and last:
            graph.next_id = last[1]
            graph.has_more = True
        return graph

    def changes_head(
        self, project_id: str, since: datetime | None = None
    ) -> tuple[datetime | None, dict[str, int]]:
        counts: dict[str, int] = {}
        max_cursor: datetime | None = None
        for etype in ENTITY_TYPES:
            table = self._table(_TABLE[etype])
            # Head cursor: newest updated_at for the project.
            head = (
                table.select("updated_at")
                .eq("project_id", project_id)
                .order("updated_at", desc=True)
                .limit(1)
                .execute()
            )
            rows = head.data or []
            if rows and rows[0].get("updated_at"):
                cur = _as_dt(rows[0]["updated_at"])
                if cur and (max_cursor is None or cur > max_cursor):
                    max_cursor = cur
            # Changed count since the cursor (head-only, no row bodies).
            q = table.select("id", count="exact").eq("project_id", project_id)
            if since is not None:
                q = q.gt("updated_at", since.isoformat())
            else:
                q = q.is_("deleted_at", "null")
            res = q.limit(1).execute()
            if res.count:
                counts[etype] = res.count
        return max_cursor, counts

    def get_task(self, project_id: str, task_id: str) -> Task | None:
        res = (
            self._table(_TABLE["tasks"])
            .select("*")
            .eq("project_id", project_id)
            .eq("id", task_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return Task(**rows[0]) if rows else None

    def assign_task(
        self, project_id: str, task_id: str, assigned_user_id: str | None, now: datetime
    ) -> Task:
        stored = self._fetch_row("tasks", task_id)
        if stored is None or stored.get("project_id") != project_id:
            raise KeyError(task_id)
        versions = dict(stored.get("field_versions") or {})
        versions["assigned_user_id"] = {"updated_at": now.isoformat(), "source": "pz"}
        self._table(_TABLE["tasks"]).update(
            {
                "assigned_user_id": assigned_user_id,
                "field_versions": versions,
                "updated_at": now.isoformat(),
            }
        ).eq("id", task_id).eq("project_id", project_id).execute()
        return self.get_task(project_id, task_id)  # type: ignore[return-value]

    def set_task_status(
        self, project_id: str, task_id: str, status: TaskStatus, now: datetime
    ) -> Task:
        stored = self._fetch_row("tasks", task_id)
        if stored is None or stored.get("project_id") != project_id:
            raise KeyError(task_id)
        versions = dict(stored.get("field_versions") or {})
        versions["status"] = {"updated_at": now.isoformat(), "source": "pz"}
        self._table(_TABLE["tasks"]).update(
            {
                "status": status.value,
                "field_versions": versions,
                "updated_at": now.isoformat(),
            }
        ).eq("id", task_id).eq("project_id", project_id).execute()
        return self.get_task(project_id, task_id)  # type: ignore[return-value]

    def upsert_task_artifact(
        self,
        project_id: str,
        task_id: str,
        uri: str,
        commit_sha: str | None,
        kind: ArtifactKind,
        now: datetime,
    ) -> Artifact:
        # Select-then-insert reads racy, and is: the authoritative guard is the
        # partial unique index on (task_id, commit_sha) from migration 0025.
        # This lookup exists to return the existing row on the common replay
        # path rather than to prevent the duplicate.
        if commit_sha is not None:
            res = (
                self._table(_TABLE["artifacts"])
                .select("*")
                .eq("project_id", project_id)
                .eq("task_id", task_id)
                .eq("commit_sha", commit_sha)
                .is_("deleted_at", "null")
                .limit(1)
                .execute()
            )
            rows = res.data or []
            if rows:
                return Artifact(**rows[0])
        artifact = Artifact(
            project_id=project_id,
            task_id=task_id,
            kind=kind,
            uri=uri,
            commit_sha=commit_sha,
            updated_at=now,
        )
        self._table(_TABLE["artifacts"]).insert(
            artifact.model_dump(mode="json")
        ).execute()
        return artifact

    def get_node(
        self, project_id: str, node_type: str, node_id: str
    ) -> GraphEntity | PullRequest | Document | None:
        if node_type == "pull_requests":
            res = (
                self._table(_PULL_REQUESTS)
                .select("*")
                .eq("project_id", project_id)
                .eq("id", node_id)
                .limit(1)
                .execute()
            )
            rows = res.data or []
            return PullRequest(**rows[0]) if rows else None
        if node_type == "documents":
            return self.get_document(project_id, node_id)
        if node_type == "stage_documents":
            res = (
                self._table(_STAGE_DOCUMENTS)
                .select("*")
                .eq("project_id", project_id)
                .eq("id", node_id)
                .limit(1)
                .execute()
            )
            rows = res.data or []
            return StageDocument(**rows[0]) if rows else None
        model = ENTITY_TYPES[node_type]
        res = (
            self._table(_TABLE[node_type])
            .select("*")
            .eq("project_id", project_id)
            .eq("id", node_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return model(**rows[0]) if rows else None

    # -- external-tracker links (M5) -------------------------------------- #
    def upsert_task_link(self, link: TaskLink) -> TaskLink:
        self._table(_TASK_LINKS).upsert(
            _dump(link),
            # Migration 0032's primary key. Three columns, because an external
            # key is unique only within a provider account.
            on_conflict="provider,account_key,external_key",
            returning="minimal",
        ).execute()
        return link

    def get_task_link(self, task_id: str, provider: str) -> TaskLink | None:
        res = (
            self._table(_TASK_LINKS)
            .select("*")
            .eq("task_id", task_id)
            .eq("provider", provider)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return TaskLink(**rows[0]) if rows else None

    def find_task_link_by_key(
        self, provider: str, account_key: str, external_key: str
    ) -> TaskLink | None:
        res = (
            self._table(_TASK_LINKS)
            .select("*")
            .eq("provider", provider)
            .eq("account_key", account_key)
            .eq("external_key", external_key)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return TaskLink(**rows[0]) if rows else None

    # -- tracker account bindings (plan 0019) ------------------------------ #
    def upsert_workspace_integration(
        self, integration: WorkspaceIntegration
    ) -> WorkspaceIntegration:
        # Checked before the write rather than relying on catching the unique
        # violation: supabase-py surfaces a constraint error as an opaque
        # APIError, and turning that back into a specific 409 would mean
        # pattern-matching a Postgres message. The constraint is still the
        # authority — it is what makes a race lose loudly instead of silently.
        existing = self.find_workspace_integration_by_account(
            integration.provider, integration.account_key
        )
        if existing is not None and existing.workspace_id != integration.workspace_id:
            raise TrackerAccountConflict(integration.provider, integration.account_key)
        self._table(_WORKSPACE_INTEGRATIONS).upsert(
            _dump(integration), on_conflict="workspace_id,provider", returning="minimal"
        ).execute()
        return integration

    def get_workspace_integration(
        self, workspace_id: str, provider: str
    ) -> WorkspaceIntegration | None:
        res = (
            self._table(_WORKSPACE_INTEGRATIONS)
            .select("*")
            .eq("workspace_id", workspace_id)
            .eq("provider", provider)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return WorkspaceIntegration(**rows[0]) if rows else None

    def find_workspace_integration_by_account(
        self, provider: str, account_key: str
    ) -> WorkspaceIntegration | None:
        if not account_key:
            return None
        res = (
            self._table(_WORKSPACE_INTEGRATIONS)
            .select("*")
            .eq("provider", provider)
            .eq("account_key", account_key)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return WorkspaceIntegration(**rows[0]) if rows else None

    # -- maintenance -------------------------------------------------------- #
    def purge_expired_tombstones(self, ttl_days: int) -> dict[str, int]:
        cutoff = (utcnow() - timedelta(days=ttl_days)).isoformat()
        counts: dict[str, int] = {}
        for etype in ENTITY_TYPES:
            res = (
                self._table(_TABLE[etype])
                .delete()
                .lte("deleted_at", cutoff)
                .not_.is_("deleted_at", "null")
                .execute()
            )
            purged_rows = res.data or []
            if purged_rows:
                counts[etype] = len(purged_rows)
                for row in purged_rows:  # M9: chunks die with the tombstone
                    self.delete_rag_chunks_for_node(row["id"])
        return counts

    # -- RAG assistant v1 (M9) --------------------------------------------- #
    def get_model_connection(self, workspace_id: str) -> ModelConnection | None:
        res = (
            self._table(_MODEL_CONNECTIONS)
            .select("*")
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return ModelConnection(**rows[0]) if rows else None

    def upsert_model_connection(
        self,
        *,
        workspace_id: str,
        provider: str,
        base_url: str,
        model: str,
        embed_model: str,
        embed_dim: int,
        secret_ref: str,
        daily_token_budget: int,
        created_by: str,
    ) -> ModelConnection:
        existing = self.get_model_connection(workspace_id)
        conn = ModelConnection(
            workspace_id=workspace_id,
            provider=provider,
            base_url=base_url,
            model=model,
            embed_model=embed_model,
            embed_dim=embed_dim,
            secret_ref=secret_ref,
            daily_token_budget=daily_token_budget,
            created_by=created_by,
            created_at=existing.created_at if existing else utcnow(),
            updated_at=utcnow(),
        )
        self._table(_MODEL_CONNECTIONS).upsert(
            _dump(conn), on_conflict="workspace_id", returning="minimal"
        ).execute()
        return conn

    def upsert_rag_chunks(
        self,
        workspace_id: str,
        project_id: str,
        node_type: str,
        node_id: str,
        chunks: list[str],
        embeddings: list[list[float]],
        embed_model: str = "",
        embed_dim: int = 0,
    ) -> None:
        # Replace wholesale so a shrinking node doesn't leave stale trailing
        # chunks (e.g. index 5 survives after a re-embed only produces 3).
        self._table(_RAG_CHUNKS).delete().eq("node_id", node_id).execute()
        if not chunks:
            return
        rows = [
            {
                "workspace_id": workspace_id,
                "project_id": project_id,
                "node_type": node_type,
                "node_id": node_id,
                "chunk_index": idx,
                "content": content,
                "embedding": embedding,
                "embed_model": embed_model,
                "embed_dim": embed_dim,
                "updated_at": utcnow().isoformat(),
            }
            for idx, (content, embedding) in enumerate(zip(chunks, embeddings, strict=True))
        ]
        self._table(_RAG_CHUNKS).insert(rows, returning="minimal").execute()

    def delete_rag_chunks_for_node(self, node_id: str) -> int:
        res = self._table(_RAG_CHUNKS).delete().eq("node_id", node_id).execute()
        return len(res.data or [])

    def get_project_embed_model(self, workspace_id: str, project_id: str) -> str | None:
        res = (
            self._table(_RAG_CHUNKS)
            .select("embed_model")
            .eq("workspace_id", workspace_id)
            .eq("project_id", project_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return rows[0]["embed_model"] if rows else None

    def get_project_embed_dim(self, workspace_id: str, project_id: str) -> int | None:
        res = (
            self._table(_RAG_CHUNKS)
            .select("embed_dim")
            .eq("workspace_id", workspace_id)
            .eq("project_id", project_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return rows[0]["embed_dim"] if rows else None

    def count_project_rag_chunks(self, workspace_id: str, project_id: str) -> int:
        res = (
            self._table(_RAG_CHUNKS)
            .select("id", count="exact")
            .eq("workspace_id", workspace_id)
            .eq("project_id", project_id)
            .limit(1)
            .execute()
        )
        return res.count or 0

    def vector_search(
        self,
        workspace_id: str,
        project_id: str,
        query_embedding: list[float],
        top_k: int = 8,
    ) -> list[RagChunkHit]:
        # pz_rag_match_chunks takes the (workspace_id, project_id) predicate as
        # explicit RPC args — membership-scoped before similarity (ADR 0011),
        # independent of whether this client carries a caller JWT or the
        # service-role key.
        res = self._client.rpc(
            _RAG_MATCH_RPC,
            {
                "p_workspace_id": workspace_id,
                "p_project_id": project_id,
                "p_query_embedding": query_embedding,
                "p_match_count": top_k,
            },
        ).execute()
        return [RagChunkHit(**row) for row in (res.data or [])]

    # -- Git-host integration (M11) ---------------------------------------- #
    def upsert_pull_request(self, pr: PullRequest) -> PullRequest:
        self._table(_PULL_REQUESTS).upsert(
            _dump(pr), on_conflict="id", returning="minimal"
        ).execute()
        return pr

    def upsert_code_chunks(
        self,
        workspace_id: str,
        project_id: str,
        repo: str,
        path: str,
        sha: str,
        line_ranges: list[tuple[int, int]],
        embeddings: list[list[float]],
    ) -> None:
        # Replace wholesale, same rationale as upsert_rag_chunks: a shrinking
        # file shouldn't leave stale trailing chunks, and a new `sha`
        # supersedes the old one for this path.
        self._table(_CODE_CHUNKS).delete().eq("project_id", project_id).eq("repo", repo).eq(
            "path", path
        ).execute()
        if not line_ranges:
            return
        rows = [
            {
                "workspace_id": workspace_id,
                "project_id": project_id,
                "repo": repo,
                "path": path,
                "sha": sha,
                "start_line": start,
                "end_line": end,
                "chunk_index": idx,
                "embedding": embedding,
                "updated_at": utcnow().isoformat(),
            }
            for idx, ((start, end), embedding) in enumerate(
                zip(line_ranges, embeddings, strict=True)
            )
        ]
        self._table(_CODE_CHUNKS).insert(rows, returning="minimal").execute()

    def delete_code_chunks_for_path(self, project_id: str, repo: str, path: str) -> int:
        res = (
            self._table(_CODE_CHUNKS)
            .delete()
            .eq("project_id", project_id)
            .eq("repo", repo)
            .eq("path", path)
            .execute()
        )
        return len(res.data or [])

    def code_vector_search(
        self,
        workspace_id: str,
        project_id: str,
        query_embedding: list[float],
        top_k: int = 8,
    ) -> list[CodeChunkHit]:
        res = self._client.rpc(
            _CODE_MATCH_RPC,
            {
                "p_workspace_id": workspace_id,
                "p_project_id": project_id,
                "p_query_embedding": query_embedding,
                "p_match_count": top_k,
            },
        ).execute()
        return [CodeChunkHit(**row) for row in (res.data or [])]

    # -- Documents knowledge base (M0) --------------------------------------- #
    def create_document(self, document: Document) -> Document:
        self._table(_DOCUMENTS).insert(_dump(document), returning="minimal").execute()
        return document

    def get_document(self, project_id: str, document_id: str) -> Document | None:
        res = (
            self._table(_DOCUMENTS)
            .select("*")
            .eq("project_id", project_id)
            .eq("id", document_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return Document(**rows[0]) if rows else None

    def list_documents(self, project_id: str) -> list[Document]:
        res = self._table(_DOCUMENTS).select("*").eq("project_id", project_id).execute()
        return [Document(**row) for row in (res.data or [])]

    def update_document_extraction(
        self,
        project_id: str,
        document_id: str,
        *,
        status: str,
        extract_method: str | None,
        extracted_text: str | None,
    ) -> Document:
        patch = {
            "status": status,
            "extract_method": extract_method,
            "extracted_text": extracted_text,
            "updated_at": utcnow().isoformat(),
        }
        self._table(_DOCUMENTS).update(patch).eq("project_id", project_id).eq(
            "id", document_id
        ).execute()
        doc = self.get_document(project_id, document_id)
        if doc is None:
            raise KeyError("document_not_found")
        return doc

    # -- Generation (M1) ------------------------------------------------------ #
    def get_latest_requirement(self, project_id: str) -> Requirement | None:
        res = (
            self._table(_TABLE["requirements"])
            .select("*")
            .eq("project_id", project_id)
            .is_("deleted_at", "null")
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return Requirement(**rows[0]) if rows else None

    def get_latest_spec_document(self, project_id: str) -> SpecDocument | None:
        res = (
            self._table(_TABLE["spec_documents"])
            .select("*")
            .eq("project_id", project_id)
            .is_("deleted_at", "null")
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return SpecDocument(**rows[0]) if rows else None

    def create_generation_run(self, run: GenerationRun) -> GenerationRun:
        self._table(_GENERATION_RUNS).insert(_dump(run), returning="minimal").execute()
        return run

    def update_generation_run(
        self,
        run_id: str,
        *,
        status: str,
        prompt_tokens: int,
        completion_tokens: int,
    ) -> GenerationRun:
        patch = {
            "status": status,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        }
        res = self._table(_GENERATION_RUNS).update(patch).eq("id", run_id).execute()
        rows = res.data or []
        if not rows:
            raise KeyError("generation_run_not_found")
        return GenerationRun(**rows[0])

    def get_stage_document(self, project_id: str, stage: str) -> StageDocument | None:
        res = (
            self._table(_STAGE_DOCUMENTS)
            .select("*")
            .eq("project_id", project_id)
            .eq("stage", stage)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return StageDocument(**rows[0]) if rows else None

    def upsert_stage_document(
        self, project_id: str, workspace_id: str, stage: str, content: str, user_id: str
    ) -> StageDocument:
        existing = self.get_stage_document(project_id, stage)
        doc = StageDocument(
            id=existing.id if existing else new_id(),
            workspace_id=workspace_id,
            project_id=project_id,
            stage=stage,
            content=content,
            created_by=existing.created_by if existing else user_id,
        )
        self._table(_STAGE_DOCUMENTS).upsert(
            _dump(doc), on_conflict="project_id,stage"
        ).execute()
        return doc


def _dump(model) -> dict:
    """JSON-safe dict for Supabase (datetimes -> ISO strings, enums -> values)."""
    return model.model_dump(mode="json")
