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
    Project,
    ProjectGraph,
    utcnow,
)


class Repository(abc.ABC):
    backend_name: str = "abstract"

    @abc.abstractmethod
    def create_project(self, owner_id: str, name: str) -> Project: ...

    @abc.abstractmethod
    def get_project(self, project_id: str) -> Project | None: ...

    @abc.abstractmethod
    def list_projects(self, owner_id: str) -> list[Project]: ...

    @abc.abstractmethod
    def upsert_graph(self, project_id: str, payload: GraphUpsertRequest) -> dict[str, int]: ...

    @abc.abstractmethod
    def get_graph(self, project_id: str, since: datetime | None = None) -> ProjectGraph: ...

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

    # -- projects --------------------------------------------------------- #
    def create_project(self, owner_id: str, name: str) -> Project:
        project = Project(name=name, owner_id=owner_id)
        self._projects[project.id] = project
        self._graph[project.id] = {etype: {} for etype in ENTITY_TYPES}
        return project

    def get_project(self, project_id: str) -> Project | None:
        return self._projects.get(project_id)

    def list_projects(self, owner_id: str) -> list[Project]:
        return [p for p in self._projects.values() if p.owner_id == owner_id]

    # -- graph ------------------------------------------------------------ #
    def upsert_graph(self, project_id: str, payload: GraphUpsertRequest) -> dict[str, int]:
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

    def get_graph(self, project_id: str, since: datetime | None = None) -> ProjectGraph:
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
