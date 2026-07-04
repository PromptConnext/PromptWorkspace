"""Supabase-backed repository.

Persists the task graph to Postgres via the Supabase client. Table names are
prefixed `pz_` and match migrations/0001_init.sql. The `supabase` package is
imported lazily so the rest of the app runs without it installed.

Conflict policy for this milestone: last-write-wins by server `updated_at`.
Per-field ownership (PromptZone owns AI fields; external trackers own PMO
fields) is a later refinement — see the task-management memo.
"""

from __future__ import annotations

from datetime import datetime

from app.models.schemas import (
    ENTITY_TYPES,
    GraphUpsertRequest,
    Project,
    ProjectGraph,
    utcnow,
)
from app.db.repository import Repository

_TABLE = {
    "requirements": "pz_requirements",
    "spec_documents": "pz_spec_documents",
    "tasks": "pz_tasks",
    "artifacts": "pz_artifacts",
    "agent_runs": "pz_agent_runs",
}
_PROJECTS = "pz_projects"


class SupabaseRepository(Repository):
    backend_name = "supabase"

    def __init__(self, url: str, key: str) -> None:
        from supabase import create_client  # lazy import

        self._client = create_client(url, key)

    # -- projects --------------------------------------------------------- #
    def create_project(self, owner_id: str, name: str) -> Project:
        project = Project(name=name, owner_id=owner_id)
        self._client.table(_PROJECTS).insert(_dump(project)).execute()
        return project

    def get_project(self, project_id: str) -> Project | None:
        res = self._client.table(_PROJECTS).select("*").eq("id", project_id).limit(1).execute()
        rows = res.data or []
        return Project(**rows[0]) if rows else None

    def list_projects(self, owner_id: str) -> list[Project]:
        res = self._client.table(_PROJECTS).select("*").eq("owner_id", owner_id).execute()
        return [Project(**row) for row in (res.data or [])]

    # -- graph ------------------------------------------------------------ #
    def upsert_graph(self, project_id: str, payload: GraphUpsertRequest) -> dict[str, int]:
        counts: dict[str, int] = {}
        for etype in ENTITY_TYPES:
            items = getattr(payload, etype)
            if not items:
                continue
            rows = []
            for item in items:
                item.updated_at = utcnow()
                data = _dump(item)
                data["project_id"] = project_id
                rows.append(data)
            self._client.table(_TABLE[etype]).upsert(rows).execute()
            counts[etype] = len(rows)
        if counts:
            self._client.table(_PROJECTS).update({"updated_at": utcnow().isoformat()}).eq(
                "id", project_id
            ).execute()
        return counts

    def get_graph(self, project_id: str, since: datetime | None = None) -> ProjectGraph:
        project = self.get_project(project_id)
        if project is None:
            raise KeyError(project_id)
        graph = ProjectGraph(project=project)
        max_cursor: datetime | None = None
        for etype, model in ENTITY_TYPES.items():
            query = self._client.table(_TABLE[etype]).select("*").eq("project_id", project_id)
            if since is not None:
                query = query.gt("updated_at", since.isoformat())
            res = query.execute()
            rows = [model(**row) for row in (res.data or [])]
            setattr(graph, etype, rows)
            for row in rows:
                if row.updated_at and (max_cursor is None or row.updated_at > max_cursor):
                    max_cursor = row.updated_at
        graph.cursor = max_cursor
        return graph


def _dump(model) -> dict:
    """JSON-safe dict for Supabase (datetimes -> ISO strings, enums -> values)."""
    return model.model_dump(mode="json")
