"""Supabase-backed repository.

Persists the task graph to Postgres via the Supabase client. Table names are
prefixed `pz_` and match the migrations under `migrations/`. The `supabase`
package is imported lazily so the rest of the app runs without it installed.

Conflict policy: field-level merge with declared ownership (M3). The pure merge
engine lives in `app/db/merge.py`; this repo reads the stored row, merges, and
writes the result back.

Auth: the backend may run with a Supabase service key (RLS-bypassing) with
app-layer membership checks as the primary guard, or attach the caller's JWT
per request (`for_user`) so Postgres RLS applies as defense in depth.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.db.merge import _as_dt, merge_entity
from app.db.merge import incoming_dump as _incoming_dump
from app.db.repository import Repository
from app.models.schemas import (
    ENTITY_TYPES,
    FIELD_AUTHORITY,
    CodeChunkHit,
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
    Workspace,
    WorkspaceMember,
    new_id,
    utcnow,
)

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


class SupabaseRepository(Repository):
    backend_name = "supabase"

    def __init__(self, url: str, key: str) -> None:
        from supabase import create_client  # lazy import

        self._url = url
        self._key = key
        self._client = create_client(url, key)

    def for_user(self, token: str) -> SupabaseRepository:
        """Return a *new* repository whose PostgREST calls carry the caller's
        JWT so RLS applies per request.

        Must not mutate `self._client` in place: `app.state.repository` is one
        shared instance across all concurrent requests (see
        app/dependencies.py::get_repository, which calls this per-request) —
        an in-place `.postgrest.auth(token)` would let one request's identity
        leak into a concurrent request's queries. This was previously dead
        code (never called from any route) and had this exact bug; found and
        fixed while verifying apps/cloud against a real local Supabase
        instance (docs/plans/0004) for the first time.
        """
        scoped = SupabaseRepository(self._url, self._key)
        scoped._client.postgrest.auth(token)
        return scoped

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
        self._client.table(_WORKSPACES).insert(_dump(ws), returning="minimal").execute()
        self.add_member(
            ws.id, created_by, Role.admin, invited_by=created_by, email=created_by_email
        )
        return ws

    def get_workspace(self, workspace_id: str) -> Workspace | None:
        res = self._client.table(_WORKSPACES).select("*").eq("id", workspace_id).limit(1).execute()
        rows = res.data or []
        return Workspace(**rows[0]) if rows else None

    def list_workspaces(self, user_id: str) -> list[Workspace]:
        mem = self._client.table(_MEMBERS).select("workspace_id").eq("user_id", user_id).execute()
        ids = [m["workspace_id"] for m in (mem.data or [])]
        if not ids:
            return []
        res = self._client.table(_WORKSPACES).select("*").in_("id", ids).execute()
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
        self._client.table(_WORKSPACES).update(patch).eq("id", workspace_id).execute()
        ws = self.get_workspace(workspace_id)
        if ws is None:
            raise KeyError(workspace_id)
        return ws

    def upsert_repo_webhook(self, webhook: RepoWebhook) -> RepoWebhook:
        self._client.table(_REPO_WEBHOOKS).upsert(
            _dump(webhook), on_conflict="repo_full_name", returning="minimal"
        ).execute()
        return webhook

    def get_repo_webhook(self, repo_full_name: str) -> RepoWebhook | None:
        res = (
            self._client.table(_REPO_WEBHOOKS)
            .select("*")
            .eq("repo_full_name", repo_full_name)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return RepoWebhook(**rows[0]) if rows else None

    def get_membership(self, workspace_id: str, user_id: str) -> Role | None:
        res = (
            self._client.table(_MEMBERS)
            .select("role")
            .eq("workspace_id", workspace_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return Role(rows[0]["role"]) if rows else None

    def list_members(self, workspace_id: str) -> list[WorkspaceMember]:
        res = self._client.table(_MEMBERS).select("*").eq("workspace_id", workspace_id).execute()
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
        self._client.table(_MEMBERS).upsert(
            _dump(member), on_conflict="workspace_id,user_id", returning="minimal"
        ).execute()
        return member

    def remove_member(self, workspace_id: str, user_id: str) -> None:
        self._client.table(_MEMBERS).delete().eq("workspace_id", workspace_id).eq(
            "user_id", user_id
        ).execute()

    def create_invitation(self, invitation: Invitation) -> Invitation:
        self._client.table(_INVITATIONS).insert(_dump(invitation), returning="minimal").execute()
        return invitation

    def get_invitation(self, token: str) -> Invitation | None:
        res = self._client.table(_INVITATIONS).select("*").eq("token", token).limit(1).execute()
        rows = res.data or []
        return Invitation(**rows[0]) if rows else None

    def accept_invitation(self, token: str, user_id: str) -> WorkspaceMember:
        inv = self.get_invitation(token)
        if inv is None:
            raise KeyError("invitation_not_found")
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        if inv.expires_at <= utcnow():
            self._client.table(_INVITATIONS).update({"status": "expired"}).eq(
                "token", token
            ).execute()
            raise ValueError("invitation_expired")
        self._client.table(_INVITATIONS).update({"status": "accepted"}).eq("token", token).execute()
        return self.add_member(
            inv.workspace_id, user_id, inv.role, invited_by=inv.invited_by, email=inv.email
        )

    # -- projects --------------------------------------------------------- #
    def create_project(self, workspace_id: str, created_by: str, name: str) -> Project:
        project = Project(name=name, workspace_id=workspace_id, owner_id=created_by)
        self._client.table(_PROJECTS).insert(_dump(project), returning="minimal").execute()
        return project

    def get_project(self, project_id: str) -> Project | None:
        res = self._client.table(_PROJECTS).select("*").eq("id", project_id).limit(1).execute()
        rows = res.data or []
        return Project(**rows[0]) if rows else None

    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project:
        patch = {"lifecycle_status": status, "updated_at": utcnow().isoformat()}
        self._client.table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def update_project_repo(
        self, project_id: str, repo_url: str, default_branch: str
    ) -> Project:
        patch = {
            "repo_url": repo_url,
            "repo_default_branch": default_branch,
            "updated_at": utcnow().isoformat(),
        }
        self._client.table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def update_project_policy_scope(self, project_id: str, scope: PolicyScope | None) -> Project:
        patch = {
            "policy_scope": scope.model_dump(mode="json") if scope is not None else None,
            "updated_at": utcnow().isoformat(),
        }
        self._client.table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project

    def list_projects(self, user_id: str) -> list[Project]:
        mem = self._client.table(_MEMBERS).select("workspace_id").eq("user_id", user_id).execute()
        ids = [m["workspace_id"] for m in (mem.data or [])]
        if not ids:
            return []
        res = self._client.table(_PROJECTS).select("*").in_("workspace_id", ids).execute()
        return [Project(**row) for row in (res.data or [])]

    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]:
        res = self._client.table(_PROJECTS).select("*").eq("workspace_id", workspace_id).execute()
        return [Project(**row) for row in (res.data or [])]

    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        query = self._client.table(_INVITATIONS).select("*").eq("workspace_id", workspace_id)
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
        query = self._client.table(_INVITATIONS).select("*").ilike("email", target)
        if status is not None:
            query = query.eq("status", status.value)
        res = query.execute()
        rows = [Invitation(**row) for row in (res.data or [])]
        return [i for i in rows if i.email.strip().lower() == target]

    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation:
        res = (
            self._client.table(_INVITATIONS)
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
        self._client.table(_INVITATIONS).update({"status": "revoked"}).eq(
            "id", invitation_id
        ).execute()
        inv.status = InvitationStatus.revoked
        return inv

    # -- graph ------------------------------------------------------------ #
    def upsert_graph(
        self, project_id: str, payload: GraphUpsertRequest, source: str = "pz"
    ) -> tuple[dict[str, int], dict[str, list[str]]]:
        counts: dict[str, int] = {}
        conflicts: dict[str, list[str]] = {}
        now = utcnow()
        for etype in ENTITY_TYPES:
            items = getattr(payload, etype)
            if not items:
                continue
            authority = FIELD_AUTHORITY.get(etype, {})
            rows = []
            for item in items:
                stored = self._fetch_row(etype, item.id)
                incoming = _incoming_dump(item)
                merged, dropped = merge_entity(stored, incoming, authority, source, now)
                merged["project_id"] = project_id
                rows.append(merged)
                if dropped:
                    conflicts[item.id] = dropped
            self._client.table(_TABLE[etype]).upsert(rows, returning="minimal").execute()
            counts[etype] = len(rows)
        if counts:
            self._client.table(_PROJECTS).update({"updated_at": now.isoformat()}).eq(
                "id", project_id
            ).execute()
        return counts, conflicts

    def _fetch_row(self, etype: str, entity_id: str) -> dict | None:
        res = self._client.table(_TABLE[etype]).select("*").eq("id", entity_id).limit(1).execute()
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
        max_cursor: datetime | None = None
        for etype, model in ENTITY_TYPES.items():
            query = self._client.table(_TABLE[etype]).select("*").eq("project_id", project_id)
            if since is not None:
                # Incremental pull: everything changed, tombstones included.
                query = query.gt("updated_at", since.isoformat())
            else:
                # Bootstrap pull: live rows only.
                query = query.is_("deleted_at", "null")
            # Keyset lower bound for pagination continuation.
            if after_ts is not None:
                query = query.gte("updated_at", after_ts.isoformat())
            query = query.order("updated_at").order("id")
            if limit is not None:
                query = query.limit(limit)
            res = query.execute()
            rows = [model(**row) for row in (res.data or [])]
            if after_ts is not None and after_id is not None:
                rows = [
                    r for r in rows if r.updated_at and (r.updated_at > after_ts or r.id > after_id)
                ]
            setattr(graph, etype, rows)
            for row in rows:
                if row.updated_at and (max_cursor is None or row.updated_at > max_cursor):
                    max_cursor = row.updated_at
        graph.cursor = max_cursor
        return graph

    def changes_head(
        self, project_id: str, since: datetime | None = None
    ) -> tuple[datetime | None, dict[str, int]]:
        counts: dict[str, int] = {}
        max_cursor: datetime | None = None
        for etype in ENTITY_TYPES:
            table = self._client.table(_TABLE[etype])
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
            self._client.table(_TABLE["tasks"])
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
        self._client.table(_TABLE["tasks"]).update(
            {
                "assigned_user_id": assigned_user_id,
                "field_versions": versions,
                "updated_at": now.isoformat(),
            }
        ).eq("id", task_id).eq("project_id", project_id).execute()
        return self.get_task(project_id, task_id)  # type: ignore[return-value]

    def get_node(
        self, project_id: str, node_type: str, node_id: str
    ) -> GraphEntity | PullRequest | Document | None:
        if node_type == "pull_requests":
            res = (
                self._client.table(_PULL_REQUESTS)
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
                self._client.table(_STAGE_DOCUMENTS)
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
            self._client.table(_TABLE[node_type])
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
        self._client.table(_TASK_LINKS).upsert(
            _dump(link), on_conflict="provider,external_key", returning="minimal"
        ).execute()
        return link

    def get_task_link(self, task_id: str, provider: str) -> TaskLink | None:
        res = (
            self._client.table(_TASK_LINKS)
            .select("*")
            .eq("task_id", task_id)
            .eq("provider", provider)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return TaskLink(**rows[0]) if rows else None

    def find_task_link_by_key(self, provider: str, external_key: str) -> TaskLink | None:
        res = (
            self._client.table(_TASK_LINKS)
            .select("*")
            .eq("provider", provider)
            .eq("external_key", external_key)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return TaskLink(**rows[0]) if rows else None

    # -- maintenance -------------------------------------------------------- #
    def purge_expired_tombstones(self, ttl_days: int) -> dict[str, int]:
        cutoff = (utcnow() - timedelta(days=ttl_days)).isoformat()
        counts: dict[str, int] = {}
        for etype in ENTITY_TYPES:
            res = (
                self._client.table(_TABLE[etype])
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
            self._client.table(_MODEL_CONNECTIONS)
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
        self._client.table(_MODEL_CONNECTIONS).upsert(
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
        self._client.table(_RAG_CHUNKS).delete().eq("node_id", node_id).execute()
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
        self._client.table(_RAG_CHUNKS).insert(rows, returning="minimal").execute()

    def delete_rag_chunks_for_node(self, node_id: str) -> int:
        res = self._client.table(_RAG_CHUNKS).delete().eq("node_id", node_id).execute()
        return len(res.data or [])

    def get_project_embed_model(self, workspace_id: str, project_id: str) -> str | None:
        res = (
            self._client.table(_RAG_CHUNKS)
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
            self._client.table(_RAG_CHUNKS)
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
            self._client.table(_RAG_CHUNKS)
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
        self._client.table(_PULL_REQUESTS).upsert(
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
        self._client.table(_CODE_CHUNKS).delete().eq("project_id", project_id).eq("repo", repo).eq(
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
        self._client.table(_CODE_CHUNKS).insert(rows, returning="minimal").execute()

    def delete_code_chunks_for_path(self, project_id: str, repo: str, path: str) -> int:
        res = (
            self._client.table(_CODE_CHUNKS)
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
        self._client.table(_DOCUMENTS).insert(_dump(document), returning="minimal").execute()
        return document

    def get_document(self, project_id: str, document_id: str) -> Document | None:
        res = (
            self._client.table(_DOCUMENTS)
            .select("*")
            .eq("project_id", project_id)
            .eq("id", document_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return Document(**rows[0]) if rows else None

    def list_documents(self, project_id: str) -> list[Document]:
        res = self._client.table(_DOCUMENTS).select("*").eq("project_id", project_id).execute()
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
        self._client.table(_DOCUMENTS).update(patch).eq("project_id", project_id).eq(
            "id", document_id
        ).execute()
        doc = self.get_document(project_id, document_id)
        if doc is None:
            raise KeyError("document_not_found")
        return doc

    # -- Generation (M1) ------------------------------------------------------ #
    def get_latest_requirement(self, project_id: str) -> Requirement | None:
        res = (
            self._client.table(_TABLE["requirements"])
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
            self._client.table(_TABLE["spec_documents"])
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
        self._client.table(_GENERATION_RUNS).insert(_dump(run), returning="minimal").execute()
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
        res = self._client.table(_GENERATION_RUNS).update(patch).eq("id", run_id).execute()
        rows = res.data or []
        if not rows:
            raise KeyError("generation_run_not_found")
        return GenerationRun(**rows[0])

    def get_stage_document(self, project_id: str, stage: str) -> StageDocument | None:
        res = (
            self._client.table(_STAGE_DOCUMENTS)
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
        self._client.table(_STAGE_DOCUMENTS).upsert(
            _dump(doc), on_conflict="project_id,stage"
        ).execute()
        return doc


def _dump(model) -> dict:
    """JSON-safe dict for Supabase (datetimes -> ISO strings, enums -> values)."""
    return model.model_dump(mode="json")
