"""Reusable RAG enqueue sweeps, shared by the per-project reindex endpoint
(app/api/assistant.py::reindex_project) and workspace-wide backfill (fired
after a model connection is created — same file, `set_model_connection`).

A sweep has three parts, mirroring the three places content lives:
  1. graph entities (requirements, spec_documents, tasks, pull_requests,
     discussions) — pulled via the same bootstrap `get_graph` reindex used
     to.
  2. the four stage documents (constitution/specify/plan/tasks).
  3. uploaded documents (the PRD) — added in 3ed9bf3 after a project's PRD
     was found permanently unindexed: documents.py enqueues on upload, but
     that only embeds if a model connection resolved *at upload time*. When
     none did, app/rag/queue.py's `_process_job` silently dropped the job
     (no model connection => discarded, not deferred) and there was no way
     back short of re-uploading the file. This module exists so that gap —
     and the workspace-wide version of it, jobs dropped for every project
     because no connection existed *yet* — has exactly one code path to fix,
     not two that can drift apart.

This lives in app/rag/ (not app/api/) so both app/api/assistant.py and
app/api/workspaces.py can import it without either importing the other.
"""

from __future__ import annotations

from typing import Any

from app.db.repository import Repository
from app.models.schemas import Project
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

# None of these are GraphEntity members of ProjectGraph:
# - pull_requests: GitHub is the source of truth (M11).
# - documents / stage_documents: swept explicitly, they have their own
#   stores rather than living on the graph.
_GRAPH_SKIP_NODE_TYPES = ("pull_requests", "documents", "stage_documents")
_STAGE_NAMES = ("constitution", "specify", "plan", "tasks")


def enqueue_project_backfill(app: Any, repo: Repository, project: Project) -> int:
    """Sweep one project's existing content into the embed queue.

    Enqueueing is cheap and non-blocking — the worker drains in-process —
    so no batching/rate-limiting is applied here.
    """
    enqueued = 0

    graph = repo.get_graph(project.id)  # bootstrap pull: live rows only
    for node_type in RAG_NODE_TYPES:
        if node_type in _GRAPH_SKIP_NODE_TYPES:
            continue
        for item in getattr(graph, node_type):
            enqueue(app, EmbedJob(project.workspace_id, project.id, node_type, item.id))
            enqueued += 1

    for stage in _STAGE_NAMES:
        stage_doc = repo.get_stage_document(project.id, stage)
        if stage_doc is not None:
            enqueue(
                app,
                EmbedJob(project.workspace_id, project.id, "stage_documents", stage_doc.id),
            )
            enqueued += 1

    for document in repo.list_documents(project.id):
        enqueue(
            app,
            EmbedJob(project.workspace_id, project.id, "documents", document.id),
        )
        enqueued += 1

    return enqueued


def enqueue_workspace_backfill(app: Any, repo: Repository, workspace_id: str) -> int:
    """Fan out `enqueue_project_backfill` over every project in a workspace.

    Used after a workspace model connection is (re)configured, so content
    that was unindexable before the connection existed — every job silently
    dropped by app/rag/queue.py's "no model connection" branch — becomes
    retrievable without an admin having to press reindex per project.
    """
    enqueued = 0
    for project in repo.list_projects_by_workspace(workspace_id):
        enqueued += enqueue_project_backfill(app, repo, project)
    return enqueued
