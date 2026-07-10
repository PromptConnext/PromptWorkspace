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

from app.db.merge import merge_entity
from app.db.repository import Repository
from app.models.schemas import (
    ENTITY_TYPES,
    FIELD_AUTHORITY,
    GraphUpsertRequest,
    Invitation,
    InvitationStatus,
    Project,
    ProjectGraph,
    Role,
    Workspace,
    WorkspaceMember,
    utcnow,
)

_TABLE = {
    "requirements": "pz_requirements",
    "spec_documents": "pz_spec_documents",
    "tasks": "pz_tasks",
    "artifacts": "pz_artifacts",
    "agent_runs": "pz_agent_runs",
}
_PROJECTS = "pz_projects"
_WORKSPACES = "pz_workspaces"
_MEMBERS = "pz_workspace_members"
_INVITATIONS = "pz_invitations"


class SupabaseRepository(Repository):
    backend_name = "supabase"

    def __init__(self, url: str, key: str) -> None:
        from supabase import create_client  # lazy import

        self._client = create_client(url, key)

    def for_user(self, token: str) -> "SupabaseRepository":
        """Return a view whose PostgREST calls carry the caller's JWT so RLS
        applies per request. Shares the underlying connection pool."""
        self._client.postgrest.auth(token)
        return self

    # -- workspaces ------------------------------------------------------- #
    def create_workspace(self, name: str, created_by: str) -> Workspace:
        ws = Workspace(name=name, created_by=created_by)
        self._client.table(_WORKSPACES).insert(_dump(ws)).execute()
        self.add_member(ws.id, created_by, Role.admin, invited_by=created_by)
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
        self, workspace_id: str, *, name: str | None = None, git_config: dict | None = None
    ) -> Workspace:
        patch: dict = {"updated_at": utcnow().isoformat()}
        if name is not None:
            patch["name"] = name
        if git_config is not None:
            patch["git_config"] = git_config
        self._client.table(_WORKSPACES).update(patch).eq("id", workspace_id).execute()
        ws = self.get_workspace(workspace_id)
        if ws is None:
            raise KeyError(workspace_id)
        return ws

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
        self, workspace_id: str, user_id: str, role: Role, invited_by: str | None = None
    ) -> WorkspaceMember:
        member = WorkspaceMember(
            workspace_id=workspace_id, user_id=user_id, role=role, invited_by=invited_by
        )
        self._client.table(_MEMBERS).upsert(
            _dump(member), on_conflict="workspace_id,user_id"
        ).execute()
        return member

    def remove_member(self, workspace_id: str, user_id: str) -> None:
        self._client.table(_MEMBERS).delete().eq("workspace_id", workspace_id).eq(
            "user_id", user_id
        ).execute()

    def create_invitation(self, invitation: Invitation) -> Invitation:
        self._client.table(_INVITATIONS).insert(_dump(invitation)).execute()
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
        self._client.table(_INVITATIONS).update({"status": "accepted"}).eq(
            "token", token
        ).execute()
        return self.add_member(inv.workspace_id, user_id, inv.role, invited_by=inv.invited_by)

    # -- projects --------------------------------------------------------- #
    def create_project(self, workspace_id: str, created_by: str, name: str) -> Project:
        project = Project(name=name, workspace_id=workspace_id, owner_id=created_by)
        self._client.table(_PROJECTS).insert(_dump(project)).execute()
        return project

    def get_project(self, project_id: str) -> Project | None:
        res = self._client.table(_PROJECTS).select("*").eq("id", project_id).limit(1).execute()
        rows = res.data or []
        return Project(**rows[0]) if rows else None

    def list_projects(self, user_id: str) -> list[Project]:
        mem = self._client.table(_MEMBERS).select("workspace_id").eq("user_id", user_id).execute()
        ids = [m["workspace_id"] for m in (mem.data or [])]
        if not ids:
            return []
        res = self._client.table(_PROJECTS).select("*").in_("workspace_id", ids).execute()
        return [Project(**row) for row in (res.data or [])]

    # -- graph ------------------------------------------------------------ #
    def upsert_graph(
        self, project_id: str, payload: GraphUpsertRequest, source: str = "pz"
    ) -> dict[str, int]:
        counts: dict[str, int] = {}
        now = utcnow()
        for etype in ENTITY_TYPES:
            items = getattr(payload, etype)
            if not items:
                continue
            authority = FIELD_AUTHORITY.get(etype, {})
            rows = []
            for item in items:
                stored = self._fetch_row(etype, item.id)
                incoming = _dump(item)
                merged = merge_entity(stored, incoming, authority, source, now)
                merged["project_id"] = project_id
                rows.append(merged)
            self._client.table(_TABLE[etype]).upsert(rows).execute()
            counts[etype] = len(rows)
        if counts:
            self._client.table(_PROJECTS).update({"updated_at": now.isoformat()}).eq(
                "id", project_id
            ).execute()
        return counts

    def _fetch_row(self, etype: str, entity_id: str) -> dict | None:
        res = self._client.table(_TABLE[etype]).select("*").eq("id", entity_id).limit(1).execute()
        rows = res.data or []
        return rows[0] if rows else None

    def get_graph(
        self, project_id: str, since: datetime | None = None, limit: int | None = None
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
            query = query.order("updated_at").order("id")
            if limit is not None:
                query = query.limit(limit)
            res = query.execute()
            rows = [model(**row) for row in (res.data or [])]
            setattr(graph, etype, rows)
            for row in rows:
                if row.updated_at and (max_cursor is None or row.updated_at > max_cursor):
                    max_cursor = row.updated_at
        graph.cursor = max_cursor
        return graph

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
            purged = len(res.data or [])
            if purged:
                counts[etype] = purged
        return counts


def _dump(model) -> dict:
    """JSON-safe dict for Supabase (datetimes -> ISO strings, enums -> values)."""
    return model.model_dump(mode="json")
