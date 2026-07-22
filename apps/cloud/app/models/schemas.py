"""Pydantic models for the AI-native task graph and the Sync API.

The task graph is PromptConnext's moat: every entity ties a business requirement all
the way down to the AI agent run that produced code for it. See
docs/promptconnext-platform-architecture.md (section 3.1).

IMPORTANT: model *credentials* never live in the cloud. `ModelConnection` here is
metadata-only (role/provider/mode) — no keys — and is not part of this first
milestone's sync payload.
"""

from __future__ import annotations

import secrets
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


class DocumentStatus(str, Enum):
    pending = "pending"
    extracted = "extracted"
    failed = "failed"


class GenerationRunStatus(str, Enum):
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


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
    # pz-owned: a workspace member's user_id, set by the app (ADR 0016).
    # Distinct from the pmo `assignee` free-text tracker name above.
    assigned_user_id: str | None = None


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


class Discussion(GraphEntity):
    """A comment threaded on any graph node (M12). `source` distinguishes a
    PromptConnext-native comment (web/desktop) from a Jira-mirrored one — unlike
    Task, both sources create their *own* rows rather than fighting over the
    same one, so `body`/`author` are "shared" authority (see FIELD_AUTHORITY
    below), not a pz/pmo split."""

    project_id: str
    parent_node_type: str  # "requirements" | "spec_documents" | "tasks" | "artifacts"
    parent_node_id: str
    author: str
    body: str
    source: Literal["pz", "pmo"] = "pz"


class TaskAssignmentUpdate(BaseModel):
    """Set or clear a task's PromptConnext assignee. `null` unassigns."""

    assigned_user_id: str | None = None


class DiscussionCreate(BaseModel):
    """Web/desktop authoring request. `author` is deliberately absent —
    the endpoint sets it to the authenticated caller, never client-supplied
    (otherwise anyone could comment as anyone)."""

    parent_node_type: str
    parent_node_id: str
    body: str


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
    rag_index_pmo_discussions: bool | None = None


class Workspace(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    created_by: str
    git_config: dict = Field(default_factory=dict)
    # Per-provider external-tracker settings (non-secret): base_url, project_key,
    # status_map. See app/integrations. Secrets come from the server env, never
    # this row (ADR 0010 §5).
    integration_config: dict = Field(default_factory=dict)
    # Discussions RAG opt-in (M12, ADR 0011): pmo-mirrored (Jira) comments are
    # third-party content and default OUT of the assistant's index; pz-native
    # discussions are always in. A typed column, not another integration_config
    # key — this is a first-class workspace setting, not vendor config.
    rag_index_pmo_discussions: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class WorkspaceMember(BaseModel):
    workspace_id: str
    user_id: str
    # Denormalized from the inviting user's session / the accepted invitation
    # at membership-creation time — avoids a cross-schema join into
    # auth.users, which only service_role can read directly. May be null for
    # members added before this field existed.
    email: str | None = None
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
    token: str = Field(default_factory=lambda: secrets.token_urlsafe(32))
    status: InvitationStatus = InvitationStatus.pending
    invited_by: str
    expires_at: datetime
    created_at: datetime = Field(default_factory=utcnow)


class InvitationCreateResponse(BaseModel):
    invitation: Invitation
    accept_url: str
    email_sent: bool


# --------------------------------------------------------------------------- #
# External-tracker links (M5)
# --------------------------------------------------------------------------- #
class TaskLink(BaseModel):
    """Maps a PromptConnext task to its mirror in an external tracker."""

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
    # PromptConnext TaskStatus value -> Jira status name used in transitions.
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
    "discussions": Discussion,
}


# Per-field authority domains (M3). A field is one of:
#   "pz"     — PromptConnext-authoritative (AI-native: agent evidence, spec lineage)
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
        "assigned_user_id": "pz",
    },
    "requirements": {"title": "shared", "description": "shared", "status": "pz"},
    "spec_documents": {"content": "pz", "status": "pz", "version": "pz"},
    "artifacts": {"uri": "pz", "commit_sha": "pz", "kind": "pz"},
    "agent_runs": {"action": "pz", "status": "pz", "evidence": "pz"},
    # "shared", not a pz/pmo split: a pz upsert and a pmo upsert never fight
    # over the SAME row's body — each source creates its own comment row.
    # Splitting this "pz" (or "pmo") would silently drop the other source's
    # writes entirely (merge_entity's domain gate), which would make Jira
    # comment mirroring impossible rather than merely lower-priority.
    "discussions": {"body": "shared", "author": "shared"},
}


class GraphUpsertRequest(BaseModel):
    """A delta (or full snapshot) pushed by the local engine. All lists optional."""

    requirements: list[Requirement] = Field(default_factory=list)
    spec_documents: list[SpecDocument] = Field(default_factory=list)
    tasks: list[Task] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    agent_runs: list[AgentRun] = Field(default_factory=list)
    discussions: list[Discussion] = Field(default_factory=list)
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
    discussions: list[Discussion] = Field(default_factory=list)
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
    API route; routes serialize `ModelConnectionOut` instead.

    `source` (M2, plan 0007): "byo" for every real, persisted workspace row
    (the default, so existing rows without this column still load fine) —
    "managed" is synthesized on the fly by app/generation/managed.py, never
    written to `pz_workspace_model_connections`, and carries the
    platform-held Typhoon key instead of a workspace-supplied one."""

    workspace_id: str
    provider: str
    base_url: str
    model: str
    embed_model: str
    embed_dim: int = 1536
    secret_ref: str
    daily_token_budget: int = 200_000
    created_by: str
    source: Literal["byo", "managed"] = "byo"
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
    layer — retrieval returns `RagChunkHit`, which drops it.

    `embed_model` (plan 0008 M1) records which model actually produced this
    chunk's vector — a project's chunks must stay homogeneous in embed
    model/dimension (pz_rag_chunks.embedding is a fixed-width column), so
    this is how a query-time model switch (e.g. BYO -> managed embeddings)
    gets caught as "reindex required" instead of silently comparing
    incompatible vectors."""

    workspace_id: str
    project_id: str
    node_type: str
    node_id: str
    chunk_index: int
    content: str
    embedding: list[float]
    embed_model: str = ""
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
    # for these and is always 0. "code" — a fetch-on-demand code chunk (M11);
    # repo/path/start_line/end_line let the client link to the Git host —
    # the code itself was never persisted (ADR 0011: no source at rest).
    source: Literal["vector", "graph", "code"] = "vector"
    repo: str | None = None
    path: str | None = None
    start_line: int | None = None
    end_line: int | None = None


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


# --------------------------------------------------------------------------- #
# Git-host integration (M11) — PRs indexed as text, code indexed as
# embeddings + refs only (ADR 0011: no source code at rest).
# --------------------------------------------------------------------------- #
class GithubInstallRequest(BaseModel):
    """Admin-supplied, after completing the GitHub App install flow on
    GitHub's own site (external, one-time — same posture as generating a
    Jira API token today; no OAuth redirect handling lives in this repo).
    v1 is one-repo-per-workspace: `project_id` says which project this repo's
    PRs/code index into."""

    installation_id: str
    repo: str  # "owner/name"
    default_branch: str = "main"
    project_id: str


class PullRequest(BaseModel):
    """GitHub is the source of truth for this data — unlike GraphEntity rows,
    there's no pz/pmo merge semantics or tombstone lifecycle here, just an
    upsert keyed by (project_id, number) driven entirely by webhook events."""

    id: str
    project_id: str
    number: int
    title: str
    body: str = ""
    html_url: str
    head_sha: str
    task_id: str | None = None  # resolved via the T-ref commit convention
    merged: bool = False
    # Always None in v1 — no PR-deletion webhook is handled — but present so
    # the embed worker's duck-typed tombstone check (`node.deleted_at`,
    # shared with every other node_type) works unmodified for this one too.
    deleted_at: datetime | None = None
    updated_at: datetime = Field(default_factory=utcnow)


class CodeChunk(BaseModel):
    """No `content` field — by construction, not by omission. The embedding
    is computed from code fetched transiently at index time (app/rag/queue.py);
    only the reference survives. Answer-time context re-fetches the same
    range fresh via the Git host (app/api/assistant.py)."""

    workspace_id: str
    project_id: str
    repo: str
    path: str
    sha: str
    start_line: int
    end_line: int
    chunk_index: int
    embedding: list[float]
    updated_at: datetime = Field(default_factory=utcnow)


class CodeChunkHit(BaseModel):
    repo: str
    path: str
    sha: str
    start_line: int
    end_line: int
    score: float


# --------------------------------------------------------------------------- #
# Documents knowledge base (M0, plan 0007) — uploaded PRDs/Markdown become a
# first-class `documents` node_type flowing through the same RAG rails as
# every other node (M9). Unlike GraphEntity rows, a Document has no pz/pmo
# merge lifecycle — it's written once by the upload endpoint, not pushed by
# the engine sync path — so it lives in its own store, the same shape as
# PullRequest above. `extracted_text` IS persisted (unlike code): these are
# business documents, not source code, so ADR 0011's "no source at rest" rule
# doesn't apply here.
class Document(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    project_id: str
    title: str
    mime: str
    storage_ref: str
    source_kind: Literal["upload"] = "upload"
    extract_method: Literal["passthrough", "text_layer", "ocr"] | None = None
    status: DocumentStatus = DocumentStatus.pending
    extracted_text: str | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    # Always None in v1 — no delete endpoint yet — present so the embed
    # worker's duck-typed tombstone check (`node.deleted_at`), shared with
    # every other node_type, works unmodified for this one too.
    deleted_at: datetime | None = None


class DocumentOut(BaseModel):
    id: str
    project_id: str
    title: str
    mime: str
    source_kind: str
    extract_method: str | None
    status: DocumentStatus
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- #
# Generation (M1, plan 0007) — stage-prompt generation endpoints, still BYO.
# `generation_runs` is an audit/cost-accounting record, not itself part of
# the task graph: the generated artifact lands as a Requirement/SpecDocument/
# Task via the existing sync/upsert path instead (see app/api/generation.py).
# --------------------------------------------------------------------------- #
class GenerateRequest(BaseModel):
    user_input: str
    options: dict = Field(default_factory=dict)


class GenerationRun(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    project_id: str
    stage: str
    model_source: str = "byo"
    model: str
    status: GenerationRunStatus = GenerationRunStatus.running
    prompt_tokens: int = 0
    completion_tokens: int = 0
    created_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Stage routing (M3, plan 0007) — per-workspace/project overrides of
# DEFAULT_STAGE_ROUTING (app/generation/routing.py). `project_id: None` is a
# workspace-wide default; resolution order is project -> workspace -> the
# hard-coded default.
# --------------------------------------------------------------------------- #
class StageRoutingUpdate(BaseModel):
    stage: Literal["constitution", "specify", "plan", "tasks"]
    model_source: Literal["byo", "managed"]
    model: str | None = None


class StageModelRouting(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    project_id: str | None = None
    stage: str
    model_source: str
    model: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class EffectiveStageRouting(BaseModel):
    stage: str
    model_source: str
    model: str | None = None
    # Which level this value came from — lets the web settings panel show
    # "inherited from workspace default" vs. "overridden here".
    origin: Literal["project", "workspace", "default"]


class RoutingTableOut(BaseModel):
    routing: list[EffectiveStageRouting]
