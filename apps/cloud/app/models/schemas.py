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
    # The model hit its completion cap (`finish_reason == "length"`) before
    # finishing the document. The partial output is still parsed, persisted
    # and shown — it's usable, just incomplete — so this is deliberately not
    # `failed`; the distinction is what lets the Planner warn the user and
    # what makes silent truncation visible in generation_runs.
    truncated = "truncated"


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
    # pz-owned: a workspace member's user_id, set by the app (ADR 0018).
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


class TaskStatusArtifact(BaseModel):
    """Evidence for a status change — the commit that closed the task.

    Rides the status PATCH rather than the full-graph PUT: ADR 0020 decision 2
    names the status write and its evidence together, and a purpose-built route
    grants a task client exactly one writable field plus one append-only child
    row, where `PUT /sync/projects/{id}/graph` would grant it every entity.
    """

    commit_sha: str
    uri: str
    kind: ArtifactKind = ArtifactKind.code


class TaskStatusUpdate(BaseModel):
    """Set a task's status, optionally attaching the commit that closed it."""

    status: TaskStatus
    artifact: TaskStatusArtifact | None = None


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


class PendingInvitation(BaseModel):
    """An invitation addressed to the *caller*, for the "you've been invited"
    surface on the web gate. Carries the workspace name so the UI can name the
    workspace without a second membership-gated fetch (the invitee is not yet a
    member, so `GET /workspaces/{id}` would 403)."""

    token: str
    workspace_id: str
    workspace_name: str
    role: Role
    invited_by: str
    expires_at: datetime


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
# Policy Scope — predefined compliance templates for project planning
# --------------------------------------------------------------------------- #
# A project's declared regulatory/compliance frame, injected server-side into
# every generated stage (constitution/specify/plan/tasks) and seeded into the
# repo at tech-review exit. `selected` holds built-in template IDs (bare
# slugs, e.g. "thai-pdpa") in user-chosen order; `custom_text` is free-form
# and stands on its own, not tied to any ID. See app/policies/registry.py.
#
# Future org-owned custom templates (deferred, designed-for) will use
# namespaced `ws:<uuid>` IDs — slugs never contain ":" — so only ID
# resolution changes when that lands, not this shape.
class PolicyScope(BaseModel):
    selected: list[str] = Field(default_factory=list)
    custom_text: str = ""


class PolicyScopeUpdate(BaseModel):
    """PATCH /projects/{id}/policy-scope request body. Same two fields as
    `PolicyScope`, kept as its own model so the storage shape can gain
    server-only fields later without changing the API contract."""

    selected: list[str] = Field(default_factory=list)
    custom_text: str = ""


# --------------------------------------------------------------------------- #
# Deployment templates (ADR 0021)
# --------------------------------------------------------------------------- #
# Three shapes, and the split between the first two is the load-bearing part.
#
# `DeploymentConfig` is the Tech Lead's INPUT: one template id, chosen during
# tech review and frozen at `repo_created` exactly as PolicyScope is.
#
# `DeploymentState` is the server's CURRENT VIEW, written only by the signed
# GitHub webhook and mutating for the life of the project. It duplicates the
# newest pz_deployments row on purpose — the same trade `repo_url` already
# makes — because GET /projects backs the workspace project list and the
# engine roster, and neither can afford a join or an N+1 to answer "is this
# project live, and where".
#
# Different lifetimes, different writers, different authorization. Keeping
# them in one blob would mean a member PATCH and a webhook write racing for
# the same column.
class DeploymentConfig(BaseModel):
    # Bare slug for a built-in (never contains ":"); a future workspace-owned
    # template resolves through the same field as `ws:<uuid>`. See
    # app/deployments/registry.py.
    template_id: str
    # Provider identifiers that name a resource THIS project deploys to — a
    # Fly app, a Vercel project (ADR 0025). Keyed by CredentialField.name, and
    # only ever keys the provider declares `scope="project"`; the token and the
    # account identifiers stay on the workspace credential. Frozen with
    # template_id at repo_created, because they are part of what the seeded
    # pipeline was built against.
    provider_values: dict[str, str] = Field(default_factory=dict)


class DeploymentConfigUpdate(BaseModel):
    """PATCH /projects/{id}/deployment-config request body. Its own model so
    the storage shape can gain server-only fields without moving the API."""

    template_id: str
    provider_values: dict[str, str] = Field(default_factory=dict)


class DeploymentState(BaseModel):
    """Denormalized current deployment view on the project row.

    `url` is LAST KNOWN GOOD and `state` is current — deliberately two
    questions. A failed deploy must not blank a preview that is still
    serving; the business user's link keeps working while the Tech Lead
    fixes the build.
    """

    template_id: str | None = None
    provider: str | None = None
    # not_configured | awaiting_first_deploy | building | live | failed
    state: str = "not_configured"
    url: str | None = None
    commit_sha: str | None = None
    run_url: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)


class Deployment(BaseModel):
    """One row per deploy, in `pz_deployments`.

    Plain BaseModel, not a GraphEntity: a deployment has exactly one author
    (the webhook) and never participates in field-level merge, so it stays
    out of ENTITY_TYPES/FIELD_AUTHORITY and out of the task-graph sync.
    """

    id: str = Field(default_factory=new_id)
    workspace_id: str
    project_id: str
    provider: str
    template_id: str
    # Idempotency key. One deploy emits several deliveries (in_progress, then
    # success/failure), so this is what makes the second write an update
    # rather than a duplicate row: GitHub's deployment id for
    # deployment_status, "run-<id>" for workflow_run.
    external_key: str
    state: str  # queued | building | live | failed | inactive
    url: str | None = None
    commit_sha: str | None = None
    ref: str | None = None
    run_url: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    # Measured server-side after a successful deploy: allow | deny | unknown.
    # The browser cannot read a cross-origin response header; the backend can.
    frame_policy: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Project
# --------------------------------------------------------------------------- #
class ProjectCreate(BaseModel):
    name: str
    workspace_id: str
    # Import gate: "owner/repo" of an existing repository to adopt at repo
    # creation, chosen from GithubRepoListOut. None (the default) is today's
    # unchanged start-from-scratch path. Deliberately a full_name and not a
    # URL — the picker is the only source, there is no free-text paste path.
    import_repo_full_name: str | None = None


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
    # Cloud Planner lifecycle (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md):
    # planning -> pending_tech_review -> tech_review -> repo_created. Linear,
    # no going back — iteration happens within a state.
    lifecycle_status: Literal["planning", "pending_tech_review", "tech_review", "repo_created"] = (
        "planning"
    )
    repo_url: str | None = None
    repo_default_branch: str | None = None
    # GitHub's own numeric repository id — immutable across a rename or
    # transfer, unlike repo_url/full_name. The identity a name-collision check
    # verifies against (plan 0016); a name alone is a lookup key, not proof of
    # provenance. Nullable: every project predating this field has a repo_url
    # with no recorded id.
    repo_id: int | None = None
    # Nullable: `None` = never selected (backward compatible with every
    # project created before this feature). See PolicyScope above.
    policy_scope: PolicyScope | None = None
    # ADR 0021. Both nullable for the same backward-compatibility reason:
    # `None` config = no template ever chosen, `None` state = nothing ever
    # deployed. See the DeploymentConfig/DeploymentState note above for why
    # these are two fields and not one.
    deployment_config: DeploymentConfig | None = None
    deployment_state: DeploymentState | None = None
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
    # Entity id -> field names silently dropped by the merge (ownership-gate
    # rejection or stale LWW). Additive/optional so existing clients that
    # ignore it keep working; the desktop UI surfaces it as a warning banner.
    conflicts: dict[str, list[str]] = Field(default_factory=dict)


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


class AssignedTask(BaseModel):
    """A task assigned to the caller, flattened with the context a task client
    needs to render it and to match it against a local clone.

    `repo_url` is carried deliberately: an editor client has a workspace folder
    and a git remote, and this is what lets it work out which cloud project the
    folder belongs to without a second round trip per project.
    """

    task: Task
    project_id: str
    project_name: str
    workspace_id: str
    workspace_name: str
    repo_url: str | None = None


class RepoWebhook(BaseModel):
    """One repository's inbound webhook binding.

    Its own row rather than a column on `Project` for two reasons. The
    signing secret is ciphertext that must never reach a client, and `Project`
    is serialized directly by several routes (`response_model=Project`) — a
    field here cannot leak by accident. And `repo_full_name` as the primary
    key makes the repo → project mapping unique *by construction*, which the
    old `find_workspace_by_github_repo` scan (first match wins) did not
    guarantee.

    Never returned by an API route.
    """

    repo_full_name: str
    project_id: str
    workspace_id: str
    secret_ref: str
    created_at: datetime = Field(default_factory=utcnow)


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


class ModelConnectionStatusOut(BaseModel):
    """What the workspace settings UI needs to render the assistant's model
    state: whether this workspace has its own connection, plus which source
    the assistant would actually resolve right now.

    `chat_source`/`embed_source` are computed from resolve_assistant_models,
    not guessed from `configured` — a deployment with the managed tier enabled
    still answers questions with no BYO connection at all, and one without it
    answers none. "none" for either is what the UI warns on.
    """

    configured: bool
    connection: ModelConnectionOut | None = None
    chat_source: Literal["byo", "managed", "none"]
    embed_source: Literal["byo", "managed", "none"]


class IndexJobError(BaseModel):
    """The last thing that stopped one of this project's embed jobs from
    storing chunks — app/rag/queue.py::JobFailure over the wire. `code` is
    stable enough for the UI to branch on ("no_model_connection",
    "github_not_connected", "embed_failed"); `message` carries the detail."""

    code: str
    message: str
    node_type: str
    node_id: str
    at: datetime


class IndexStatusOut(BaseModel):
    """What GET /projects/{id}/assistant/index-status returns — the
    completion signal POST .../reindex itself never had (that endpoint
    returns the instant jobs are queued, before any embedding runs).

    `pending_jobs` and `last_error` come from bookkeeping `EmbedQueue` keeps
    around its own enqueue/complete pair (app/rag/queue.py), not from probing
    an opaque FIFO: the count is per-project and measured, so "still draining"
    is distinguishable from "drained" without guessing. `last_error` covers
    the case the chunk count can never express — jobs that were discarded
    rather than deferred (no model connection resolved, no GitHub token) or
    that raised — which is what makes a frozen "0 chunks indexed" readable
    instead of merely alarming.

    Both are this process's in-memory view: a restart zeroes them, and only
    the instance that ran the jobs knows about them. The single-instance
    constraint that already governs presence (see ADR 0011 / ws/manager.py)
    applies here too — with a second instance these numbers describe that
    instance's share, not the workspace's.
    """

    indexed_chunks: int
    indexable_nodes: int
    embed_model: str | None = None
    pending_jobs: int = 0
    last_error: IndexJobError | None = None


class ProjectReindexCount(BaseModel):
    """One project's share of a workspace-wide reindex — see
    WorkspaceReindexOut."""

    project_id: str
    enqueued: int


class WorkspaceReindexOut(BaseModel):
    """What POST /workspaces/{id}/assistant/reindex returns: the same
    enqueue-only contract as the per-project reindex (this spends real
    money, one embedding call per node per project, so the response says
    "queued", never "indexed" — there is no completion signal here either,
    only GET .../index-status per project has one), fanned out across every
    project in the workspace via app/rag/backfill.py::enqueue_workspace_backfill.
    """

    enqueued: int
    projects_swept: int
    projects: list[ProjectReindexCount]


class RagChunk(BaseModel):
    """A stored, embedded chunk. `embedding` never leaves the repository
    layer — retrieval returns `RagChunkHit`, which drops it.

    `embed_model` (plan 0008 M1) records which model actually produced this
    chunk's vector — a project's chunks must stay homogeneous in embed
    model/dimension, so this is how a query-time model switch (e.g. BYO ->
    managed embeddings) gets caught as "reindex required" instead of
    silently comparing incompatible vectors.

    `embed_dim` (migration 0023) records the vector's width. Before 0023
    `pz_rag_chunks.embedding` was a fixed `vector(1536)` column, so no chunk
    could ever be a different width and this field would have been
    redundant. Once the column width became a deploy-time parameter, a
    workspace whose connection's `embed_dim` no longer matches what its
    existing chunks were embedded at is reachable, and the mismatch is
    worse than an `embed_model` mismatch — the vectors are not even the
    same shape, so the guard in app/api/assistant.py checks this field the
    same way it checks `embed_model`."""

    workspace_id: str
    project_id: str
    node_type: str
    node_id: str
    chunk_index: int
    content: str
    embedding: list[float]
    embed_model: str = ""
    embed_dim: int = 0
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
class GithubConnectRequest(BaseModel):
    """Admin-supplied GitHub credential for the whole workspace.

    `owner` is the org (or personal account) new project repositories are
    created under; `token` is a fine-grained PAT with Contents + Administration
    write on that owner. Deliberately no `repo` field — a workspace holds many
    projects and the cloud *creates* each project's repo at tech-review exit
    (ADR 0017), so naming one repo here was both wrong-scoped and the hook
    that let a workspace claim another's deliveries (issue #3).

    The token is verified against GitHub before anything is written, then
    encrypted to a `secret_ref`; the plaintext is never persisted or echoed.
    """

    owner: str
    token: str


class GithubConnectionOut(BaseModel):
    """Non-secret view of a workspace's GitHub connection, safe to render in
    settings. Carries no token and no `secret_ref`."""

    connected: bool
    owner: str | None = None
    owner_type: str | None = None
    account_login: str | None = None
    token_expires_at: datetime | None = None
    connected_at: datetime | None = None
    # Org/user the App is installed on. Repo creation (create-repository,
    # app/api/sync.py) needs this separately from `repo`, since `repo` may
    # not exist yet at install time; null falls back to `repo.split("/")[0]`.
    owner: str | None = None


class GithubRepoOut(BaseModel):
    """One repository the workspace's PAT can see, for the import picker
    (GET /workspaces/{id}/integrations/github/repos)."""

    full_name: str
    name: str
    html_url: str
    default_branch: str
    private: bool
    archived: bool = False
    # Derived from GitHub's `size == 0` — the only available proxy for "has no
    # commits". A repo in that state can't be seeded (the seed step reads the
    # branch head first, which 404s), so the picker disables the row rather
    # than letting the failure surface at tech-review exit.
    empty: bool = False
    pushed_at: datetime | None = None


class GithubRepoListOut(BaseModel):
    """Response for the import picker.

    `owner`/`owner_type`/`account_login` are carried even when `repositories`
    is empty — that emptiness is the out-of-scope-owner state a member sees
    when their app lives under an account the workspace's PAT cannot reach,
    and the connection-status endpoint that would otherwise supply the owner
    is admin-only, so this response has to say it itself.
    """

    owner: str | None = None
    owner_type: str | None = None
    account_login: str | None = None
    repositories: list[GithubRepoOut] = []
    truncated: bool = False


class CreateRepositoryRequest(BaseModel):
    """Body for POST /projects/{id}/lifecycle/create-repository. `name` lets
    the Tech Lead override the auto-derived slug; omitted, the endpoint
    slugifies the project name."""

    name: str | None = None
    private: bool = True


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


class StageDocument(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    project_id: str
    stage: Literal["constitution", "specify", "plan", "tasks"]
    content: str = ""
    created_by: str
    updated_at: datetime = Field(default_factory=utcnow)
    # Always None in v1 — no delete endpoint yet — present so the embed
    # worker's duck-typed tombstone check (`node.deleted_at`), shared with
    # every other node_type, works unmodified for this one too.
    deleted_at: datetime | None = None


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
