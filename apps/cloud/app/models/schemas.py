"""Pydantic models for the AI-native task graph and the Sync API.

The task graph is PromptZone's moat: every entity ties a business requirement all
the way down to the AI agent run that produced code for it. See
docs/promptzone-platform-architecture.md (section 3.1).

IMPORTANT: model *credentials* never live in the cloud. `ModelConnection` here is
metadata-only (role/provider/mode) — no keys — and is not part of this first
milestone's sync payload.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Enums
# --------------------------------------------------------------------------- #
class OnboardingState(str, Enum):
    not_started = "not_started"
    in_progress = "in_progress"
    satisfied = "satisfied"


class StageStatus(str, Enum):
    locked = "locked"
    active = "active"
    approved = "approved"


class RequirementStatus(str, Enum):
    draft = "draft"
    approved = "approved"


class SpecStatus(str, Enum):
    draft = "draft"
    approved = "approved"


class TaskStatus(str, Enum):
    todo = "todo"
    in_progress = "in_progress"
    implemented = "implemented"
    verified = "verified"


class ArtifactKind(str, Enum):
    code = "code"
    pr = "pr"
    doc = "doc"


class AgentRunStatus(str, Enum):
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class Role(str, Enum):
    admin = "admin"
    member = "member"


class InvitationStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    revoked = "revoked"
    expired = "expired"


# --------------------------------------------------------------------------- #
# Graph entities
# --------------------------------------------------------------------------- #
class GraphEntity(BaseModel):
    """Base for every syncable entity.

    `updated_at` is server-managed: clients may send it, but the server always
    overwrites it on write so it can serve as a reliable incremental-pull cursor.

    `deleted_at` is a tombstone: a delete is just an upsert that sets this
    field. Bootstrap pulls (no `since`) hide tombstoned rows; incremental
    pulls (`since` set) include them so peers learn of the deletion. See
    docs/plans/0001-cloud-deletes-and-auth.md (Milestone 1).
    """

    id: str = Field(default_factory=new_id)
    updated_at: datetime | None = None
    deleted_at: datetime | None = None
    # Per-field {field: {updated_at, source}} for conflict-safe field-level
    # merges (M3). Empty map = behaves as row-level LWW until first scoped write.
    field_versions: dict = Field(default_factory=dict)


class AcceptanceCriterion(BaseModel):
    # Stored as {text: str}[] to match Ideva Kit's shape — the card renderer
    # reads `criterion.text`. Do NOT flatten to plain strings.
    text: str


class Requirement(GraphEntity):
    project_id: str
    title: str
    description: str = ""
    status: RequirementStatus = RequirementStatus.draft


class SpecDocument(GraphEntity):
    project_id: str
    requirement_id: str
    content: str = ""
    version: int = 1
    status: SpecStatus = SpecStatus.draft
    approved_by: str | None = None


class Task(GraphEntity):
    project_id: str
    spec_id: str | None = None
    title: str
    status: TaskStatus = TaskStatus.todo
    feature_tag: str | None = None
    acceptance_criteria: list[AcceptanceCriterion] = Field(default_factory=list)
    # PMO fields, populated by the external-tracker mirror (M5).
    assignee: str | None = None
    sprint: str | None = None


class Artifact(GraphEntity):
    project_id: str
    task_id: str
    kind: ArtifactKind = ArtifactKind.code
    uri: str
    commit_sha: str | None = None


class AgentRun(GraphEntity):
    project_id: str
    task_id: str
    model_role: str = "code"  # plan | code | thai | other
    action: str = ""
    status: AgentRunStatus = AgentRunStatus.running
    evidence: dict = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Workspaces, membership & invitations (M2)
# --------------------------------------------------------------------------- #
# A workspace is the access-control tier: it owns projects and carries the
# shared (non-secret) Git configuration. Access is by membership, not project
# ownership. Per ADR 0010 §5 the cloud stores only Git *metadata* here
# (repo_url / provider / default_branch) — never a raw credential (Option C).
class WorkspaceCreate(BaseModel):
    name: str


class WorkspaceUpdate(BaseModel):
    name: str | None = None
    git_config: dict | None = None


class Workspace(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    created_by: str
    git_config: dict = Field(default_factory=dict)
    # Per-provider external-tracker settings (non-secret): base_url, project_key,
    # status_map. See app/integrations. Secrets come from the server env, never
    # this row (ADR 0010 §5).
    integration_config: dict = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class WorkspaceMember(BaseModel):
    workspace_id: str
    user_id: str
    role: Role = Role.member
    invited_by: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


class InvitationCreate(BaseModel):
    email: str
    role: Role = Role.member


class Invitation(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    email: str
    role: Role = Role.member
    token: str = Field(default_factory=new_id)
    status: InvitationStatus = InvitationStatus.pending
    invited_by: str
    expires_at: datetime
    created_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# External-tracker links (M5)
# --------------------------------------------------------------------------- #
class TaskLink(BaseModel):
    """Maps a PromptZone task to its mirror in an external tracker."""

    task_id: str
    project_id: str
    provider: str  # "jira" | "clickup"
    external_key: str  # e.g. Jira issue key "PZ-42"
    external_url: str = ""
    updated_at: datetime = Field(default_factory=utcnow)


class JiraIntegrationConfig(BaseModel):
    """Non-secret Jira settings stored on the workspace. The API token +
    webhook secret live in the server env, never here (ADR 0010 §5)."""

    base_url: str  # https://your-org.atlassian.net
    project_key: str  # "PZ"
    # PromptZone TaskStatus value -> Jira status name used in transitions.
    status_map: dict[str, str] = Field(
        default_factory=lambda: {
            "todo": "To Do",
            "in_progress": "In Progress",
            "implemented": "In Review",
            "verified": "Done",
        }
    )


# --------------------------------------------------------------------------- #
# Project
# --------------------------------------------------------------------------- #
class ProjectCreate(BaseModel):
    name: str
    workspace_id: str


class Project(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    workspace_id: str
    # created_by is the acting user at creation; owner_id is retained as an
    # alias for backward compatibility with pre-workspace clients/tests.
    owner_id: str
    onboarding_state: OnboardingState = OnboardingState.not_started
    stage_state: dict[str, StageStatus] = Field(
        default_factory=lambda: {
            "scope": StageStatus.active,
            "spec": StageStatus.locked,
            "skill": StageStatus.locked,
        }
    )
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Sync payloads
# --------------------------------------------------------------------------- #
# Entity-type name -> model, used by the repository upsert loop and tests.
ENTITY_TYPES: dict[str, type[GraphEntity]] = {
    "requirements": Requirement,
    "spec_documents": SpecDocument,
    "tasks": Task,
    "artifacts": Artifact,
    "agent_runs": AgentRun,
}


# Per-field authority domains (M3). A field is one of:
#   "pz"     — PromptZone-authoritative (AI-native: agent evidence, spec lineage)
#   "pmo"    — external-tracker-authoritative (assignee/sprint/human priority)
#   "shared" — low-contention free text; row-level LWW is acceptable
# Fields absent from an entity's map default to "pz" (the moat stays local).
FIELD_AUTHORITY: dict[str, dict[str, str]] = {
    "tasks": {
        "title": "shared",
        "status": "pz",
        "acceptance_criteria": "pz",
        "feature_tag": "pmo",
        "assignee": "pmo",
        "sprint": "pmo",
    },
    "requirements": {"title": "shared", "description": "shared", "status": "pz"},
    "spec_documents": {"content": "pz", "status": "pz", "version": "pz"},
    "artifacts": {"uri": "pz", "commit_sha": "pz", "kind": "pz"},
    "agent_runs": {"action": "pz", "status": "pz", "evidence": "pz"},
}


class GraphUpsertRequest(BaseModel):
    """A delta (or full snapshot) pushed by the local engine. All lists optional."""

    requirements: list[Requirement] = Field(default_factory=list)
    spec_documents: list[SpecDocument] = Field(default_factory=list)
    tasks: list[Task] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    agent_runs: list[AgentRun] = Field(default_factory=list)
    # Which authority domain is writing. The engine pushes "pz"; the Jira/
    # ClickUp webhook path pushes "pmo". Governs field-level merge (M3).
    source: Literal["pz", "pmo"] = "pz"


class GraphUpsertResponse(BaseModel):
    upserted: dict[str, int]
    cursor: datetime | None = None


class ChangesHead(BaseModel):
    """Lightweight sync head: lets a client cheaply decide whether to pull.

    `cursor` is the max updated_at across the project's entities (or the value
    of `since` when nothing changed). `counts` is per-entity changed rows since
    `since`. `has_changes` is the fast-path flag — when False the client can
    skip a full pull entirely.
    """

    cursor: datetime | None = None
    counts: dict[str, int] = Field(default_factory=dict)
    has_changes: bool = False


class ProjectGraph(BaseModel):
    """Full (or incremental, when `since` is provided) view of a project's graph."""

    project: Project
    requirements: list[Requirement] = Field(default_factory=list)
    spec_documents: list[SpecDocument] = Field(default_factory=list)
    tasks: list[Task] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    agent_runs: list[AgentRun] = Field(default_factory=list)
    cursor: datetime | None = None
    # Keyset continuation (M7): when a `limit` truncates the page, the client
    # re-pulls with since=cursor & after_id=next_id. None means fully drained.
    next_id: str | None = None
    has_more: bool = False


# --------------------------------------------------------------------------- #
# RAG assistant v1 (M9)
# --------------------------------------------------------------------------- #
class ModelConnectionCreate(BaseModel):
    """Admin-supplied, workspace-BYO chat + embedding model. `api_key` is
    encrypted to a `secret_ref` on write (app/secrets.py) and never stored or
    echoed back in plaintext."""

    provider: str
    base_url: str
    model: str
    embed_model: str
    embed_dim: int = 1536
    api_key: str
    daily_token_budget: int = 200_000


class ModelConnection(BaseModel):
    """Internal representation, includes `secret_ref` — never returned by an
    API route; routes serialize `ModelConnectionOut` instead."""

    workspace_id: str
    provider: str
    base_url: str
    model: str
    embed_model: str
    embed_dim: int = 1536
    secret_ref: str
    daily_token_budget: int = 200_000
    created_by: str
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ModelConnectionOut(BaseModel):
    workspace_id: str
    provider: str
    base_url: str
    model: str
    embed_model: str
    embed_dim: int
    daily_token_budget: int
    created_at: datetime
    updated_at: datetime


class RagChunk(BaseModel):
    """A stored, embedded chunk. `embedding` never leaves the repository
    layer — retrieval returns `RagChunkHit`, which drops it."""

    workspace_id: str
    project_id: str
    node_type: str
    node_id: str
    chunk_index: int
    content: str
    embedding: list[float]
    updated_at: datetime = Field(default_factory=utcnow)


class RagChunkHit(BaseModel):
    node_type: str
    node_id: str
    chunk_index: int
    content: str
    score: float


class Citation(BaseModel):
    node_type: str
    node_id: str
    chunk_index: int
    # "vector" — a retrieved embedding chunk (M9). "graph" — a whole-node
    # reference from an exact graph walk (M10); chunk_index is meaningless
    # for these and is always 0.
    source: Literal["vector", "graph"] = "vector"


class ChatRequest(BaseModel):
    question: str


# --------------------------------------------------------------------------- #
# Graph-aware retrieval (M10)
# --------------------------------------------------------------------------- #
class LineageAgentRun(BaseModel):
    id: str
    status: AgentRunStatus


class LineageFacts(BaseModel):
    """Exact facts computed by a graph walk (app/rag/lineage.py) — not model
    output. Sent to the client as its own SSE event ahead of the narrated
    answer, so status/progress questions carry data a test can assert on
    directly rather than parsing model prose."""

    scope: Literal["requirement", "task", "project"]
    node_type: str | None = None
    node_id: str | None = None
    title: str
    status: str | None = None
    specs_total: int = 0
    tasks_total: int = 0
    tasks_done: int = 0
    task_status_counts: dict[str, int] = Field(default_factory=dict)
    artifacts_total: int = 0
    agent_runs: list[LineageAgentRun] = Field(default_factory=list)
