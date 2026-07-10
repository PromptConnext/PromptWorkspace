"""Repository layer — the data-access seam.

Two implementations share one interface:
  * InMemoryRepository  — no external deps; used for tests and local dev.
  * SupabaseRepository  — persists to Postgres via the Supabase client.

Keeping this seam means the Sync API never talks to Supabase directly, so the
whole backend is runnable and testable without credentials.
"""

from __future__ import annotations

import abc
import copy
from datetime import datetime, timedelta

from app.models.schemas import (
    ENTITY_TYPES,
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


class Repository(abc.ABC):
    backend_name: str = "abstract"

    # -- workspaces ------------------------------------------------------- #
    @abc.abstractmethod
    def create_workspace(self, name: str, created_by: str) -> Workspace:
        """Create a workspace and add the creator as its first admin."""

    @abc.abstractmethod
    def get_workspace(self, workspace_id: str) -> Workspace | None: ...

    @abc.abstractmethod
    def list_workspaces(self, user_id: str) -> list[Workspace]:
        """Workspaces the user is a member of."""

    @abc.abstractmethod
    def update_workspace(
        self, workspace_id: str, *, name: str | None = None, git_config: dict | None = None
    ) -> Workspace: ...

    @abc.abstractmethod
    def get_membership(self, workspace_id: str, user_id: str) -> Role | None: ...

    @abc.abstractmethod
    def list_members(self, workspace_id: str) -> list[WorkspaceMember]: ...

    @abc.abstractmethod
    def add_member(
        self, workspace_id: str, user_id: str, role: Role, invited_by: str | None = None
    ) -> WorkspaceMember: ...

    @abc.abstractmethod
    def remove_member(self, workspace_id: str, user_id: str) -> None: ...

    @abc.abstractmethod
    def create_invitation(self, invitation: Invitation) -> Invitation: ...

    @abc.abstractmethod
    def get_invitation(self, token: str) -> Invitation | None: ...

    @abc.abstractmethod
    def accept_invitation(self, token: str, user_id: str) -> WorkspaceMember:
        """Consume a pending, unexpired invitation and add the user as a member."""

    # -- projects --------------------------------------------------------- #
    @abc.abstractmethod
    def create_project(self, workspace_id: str, created_by: str, name: str) -> Project: ...

    @abc.abstractmethod
    def get_project(self, project_id: str) -> Project | None: ...

    @abc.abstractmethod
    def list_projects(self, user_id: str) -> list[Project]:
        """Projects across every workspace the user is a member of."""

    @abc.abstractmethod
    def upsert_graph(
        self, project_id: str, payload: GraphUpsertRequest, source: str = "pz"
    ) -> dict[str, int]: ...

    @abc.abstractmethod
    def get_graph(
        self, project_id: str, since: datetime | None = None, limit: int | None = None
    ) -> ProjectGraph: ...

    @abc.abstractmethod
    def purge_expired_tombstones(self, ttl_days: int) -> dict[str, int]:
        """Hard-delete rows tombstoned (`deleted_at` set) longer than `ttl_days`
        ago. Never touches live rows or recent tombstones. Returns per-entity
        purge counts. See docs/plans/0001-cloud-deletes-and-auth.md (M1 GC)."""


class InMemoryRepository(Repository):
    """Process-local store. State is lost on restart — dev/test only."""

    backend_name = "memory"

    def __init__(self) -> None:
        self._projects: dict[str, Project] = {}
        # project_id -> entity_type -> entity_id -> entity instance
        self._graph: dict[str, dict[str, dict[str, object]]] = {}
        self._workspaces: dict[str, Workspace] = {}
        # workspace_id -> user_id -> WorkspaceMember
        self._members: dict[str, dict[str, WorkspaceMember]] = {}
        # token -> Invitation
        self._invitations: dict[str, Invitation] = {}

    # -- workspaces ------------------------------------------------------- #
    def create_workspace(self, name: str, created_by: str) -> Workspace:
        ws = Workspace(name=name, created_by=created_by)
        self._workspaces[ws.id] = ws
        self._members[ws.id] = {}
        self.add_member(ws.id, created_by, Role.admin, invited_by=created_by)
        return ws

    def get_workspace(self, workspace_id: str) -> Workspace | None:
        return self._workspaces.get(workspace_id)

    def list_workspaces(self, user_id: str) -> list[Workspace]:
        return [
            ws
            for ws in self._workspaces.values()
            if user_id in self._members.get(ws.id, {})
        ]

    def update_workspace(
        self, workspace_id: str, *, name: str | None = None, git_config: dict | None = None
    ) -> Workspace:
        ws = self._workspaces[workspace_id]
        if name is not None:
            ws.name = name
        if git_config is not None:
            ws.git_config = git_config
        ws.updated_at = utcnow()
        return ws

    def get_membership(self, workspace_id: str, user_id: str) -> Role | None:
        member = self._members.get(workspace_id, {}).get(user_id)
        return member.role if member else None

    def list_members(self, workspace_id: str) -> list[WorkspaceMember]:
        return list(self._members.get(workspace_id, {}).values())

    def add_member(
        self, workspace_id: str, user_id: str, role: Role, invited_by: str | None = None
    ) -> WorkspaceMember:
        member = WorkspaceMember(
            workspace_id=workspace_id, user_id=user_id, role=role, invited_by=invited_by
        )
        self._members.setdefault(workspace_id, {})[user_id] = member
        return member

    def remove_member(self, workspace_id: str, user_id: str) -> None:
        self._members.get(workspace_id, {}).pop(user_id, None)

    def create_invitation(self, invitation: Invitation) -> Invitation:
        self._invitations[invitation.token] = invitation
        return invitation

    def get_invitation(self, token: str) -> Invitation | None:
        return self._invitations.get(token)

    def accept_invitation(self, token: str, user_id: str) -> WorkspaceMember:
        inv = self._invitations.get(token)
        if inv is None:
            raise KeyError("invitation_not_found")
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        if inv.expires_at <= utcnow():
            inv.status = InvitationStatus.expired
            raise ValueError("invitation_expired")
        inv.status = InvitationStatus.accepted
        return self.add_member(inv.workspace_id, user_id, inv.role, invited_by=inv.invited_by)

    # -- projects --------------------------------------------------------- #
    def create_project(self, workspace_id: str, created_by: str, name: str) -> Project:
        project = Project(name=name, workspace_id=workspace_id, owner_id=created_by)
        self._projects[project.id] = project
        self._graph[project.id] = {etype: {} for etype in ENTITY_TYPES}
        return project

    def get_project(self, project_id: str) -> Project | None:
        return self._projects.get(project_id)

    def list_projects(self, user_id: str) -> list[Project]:
        member_ws = {
            ws_id for ws_id, members in self._members.items() if user_id in members
        }
        return [p for p in self._projects.values() if p.workspace_id in member_ws]

    # -- graph ------------------------------------------------------------ #
    def upsert_graph(
        self, project_id: str, payload: GraphUpsertRequest, source: str = "pz"
    ) -> dict[str, int]:
        store = self._graph[project_id]
        counts: dict[str, int] = {}
        for etype in ENTITY_TYPES:
            items = getattr(payload, etype)
            if not items:
                continue
            for item in items:
                entity = copy.deepcopy(item)
                entity.updated_at = utcnow()  # server owns the cursor timestamp
                store[etype][entity.id] = entity
            counts[etype] = len(items)
        # touch the project so its updated_at advances too
        if counts and (project := self._projects.get(project_id)):
            project.updated_at = utcnow()
        return counts

    def get_graph(
        self, project_id: str, since: datetime | None = None, limit: int | None = None
    ) -> ProjectGraph:
        project = self._projects[project_id]
        store = self._graph[project_id]
        graph = ProjectGraph(project=project)
        max_cursor: datetime | None = None
        for etype in ENTITY_TYPES:
            rows = []
            for entity in store[etype].values():
                if since is None:
                    if entity.deleted_at is not None:
                        continue  # bootstrap pull: hide dead rows
                elif entity.updated_at is None or entity.updated_at <= since:
                    continue  # incremental pull: unchanged rows (tombstones included)
                rows.append(copy.deepcopy(entity))
                if entity.updated_at and (max_cursor is None or entity.updated_at > max_cursor):
                    max_cursor = entity.updated_at
            setattr(graph, etype, rows)
        graph.cursor = max_cursor
        return graph

    # -- maintenance -------------------------------------------------------- #
    def purge_expired_tombstones(self, ttl_days: int) -> dict[str, int]:
        cutoff = utcnow() - timedelta(days=ttl_days)
        counts: dict[str, int] = {}
        for project_id, store in self._graph.items():
            for etype in ENTITY_TYPES:
                expired_ids = [
                    eid
                    for eid, entity in store[etype].items()
                    if entity.deleted_at is not None and entity.deleted_at <= cutoff
                ]
                for eid in expired_ids:
                    del store[etype][eid]
                if expired_ids:
                    counts[etype] = counts.get(etype, 0) + len(expired_ids)
        return counts
