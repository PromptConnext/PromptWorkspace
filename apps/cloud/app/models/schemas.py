"""Pydantic models for the AI-native task graph and the Sync API.

The task graph is PromptWorkspace's moat: every entity ties a business requirement all
the way down to the AI agent run that produced code for it. See
docs/promptzone-platform-architecture.md (section 3.1).

IMPORTANT: model *credentials* never live in the cloud. `ModelConnection` here is
metadata-only (role/provider/mode) — no keys — and is not part of this first
milestone's sync payload.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Any, ClassVar, Literal

from pydantic import (
    AnyHttpUrl,
    AnyUrl,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)


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
    # pw-owned: a workspace member's user_id, set by the app (ADR 0018).
    # Distinct from the pmo `assignee` free-text tracker name above.
    assigned_user_id: str | None = None
    # pw-owned: the delivery change (plan 0029) this task is a step of, set by
    # the Planner from tasks.md's phase headings.
    change_id: str | None = None


class ArtifactAgent(BaseModel):
    """The coding agent that produced a closing artifact (plan 0033)."""

    client: str = Field(max_length=64)
    model: str | None = Field(default=None, max_length=128)


class Artifact(GraphEntity):
    project_id: str
    task_id: str
    kind: ArtifactKind = ArtifactKind.code
    uri: str
    commit_sha: str | None = None
    agent: ArtifactAgent | None = None


class AgentRun(GraphEntity):
    project_id: str
    task_id: str
    model_role: str = "code"  # plan | code | thai | other
    action: str = ""
    status: AgentRunStatus = AgentRunStatus.running
    evidence: dict = Field(default_factory=dict)


class Discussion(GraphEntity):
    """A comment threaded on any graph node (M12). `source` distinguishes a
    PromptWorkspace-native comment (web/desktop) from a Jira-mirrored one — unlike
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
    """Set or clear a task's PromptWorkspace assignee. `null` unassigns."""

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
    agent: ArtifactAgent | None = None


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
# Request-side rule for a workspace's display name: surrounding whitespace is
# stripped, then the name must be 1-100 characters (422 otherwise). The web
# client enforces the same cap (WORKSPACE_NAME_MAX_LENGTH). Applied to request
# bodies only — the stored `Workspace.name` stays a plain str so auto-provisioned
# personal workspaces and existing rows are never re-validated on read.
WorkspaceName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
]


class WorkspaceCreate(BaseModel):
    name: WorkspaceName


class WorkspaceUpdate(BaseModel):
    name: WorkspaceName | None = None
    git_config: dict | None = None
    rag_index_pmo_discussions: bool | None = None
    language: Literal["en", "th"] | None = None


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
    # third-party content and default OUT of the assistant's index; pw-native
    # discussions are always in. A typed column, not another integration_config
    # key — this is a first-class workspace setting, not vendor config.
    rag_index_pmo_discussions: bool = False
    # Language of notifications sent for the workspace's projects (LINE, plan
    # 0032). Email and the web UI do not read it.
    language: Literal["en", "th"] = "en"
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ProjectLineLink(BaseModel):
    """The LINE group a project's notifications go to (plan 0032). One per project."""

    project_id: str
    group_id: str
    group_name: str | None = None
    linked_by: str
    linked_at: datetime


class LineLinkCode(BaseModel):
    """A pending, single-use code an admin pastes into the LINE group to link it."""

    code: str
    project_id: str
    created_by: str
    expires_at: datetime


class ProjectLineStatus(BaseModel):
    """`GET /projects/{id}/line`: whether LINE is on and which group is linked."""

    configured: bool
    connected: bool
    group_name: str | None = None
    linked_at: datetime | None = None
    bot_basic_id: str | None = None


class LineLinkCodeOut(BaseModel):
    code: str
    expires_at: datetime
    bot_basic_id: str | None = None


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
    # What the member chose to be called (plan 0033). Shown in preference to
    # the email; stripped, capped at 80 characters, blank means unset.
    display_name: str | None = Field(default=None, max_length=80)
    created_at: datetime = Field(default_factory=utcnow)

    @field_validator("display_name", mode="before")
    @classmethod
    def _blank_display_name_is_none(cls, v: object) -> object:
        return _clean_display_name(v)


class MemberDisplayNameUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=80)

    @field_validator("display_name", mode="before")
    @classmethod
    def _blank_display_name_is_none(cls, v: object) -> object:
        return _clean_display_name(v)


def _clean_display_name(v: object) -> object:
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


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
    """Maps a PromptWorkspace task to its mirror in an external tracker."""

    task_id: str
    project_id: str
    provider: str  # "jira" | "clickup"
    # Which provider *account* `external_key` belongs to — the normalized site
    # base URL for Jira (see WorkspaceIntegration). Part of the primary key
    # since migration 0032, because an issue key is unique per site and not per
    # provider: two tenants each running a project keyed "PZ" both produce
    # "PZ-1". Empty only on rows mirrored before that migration, which is a
    # value no configured account can ever equal, so they no longer resolve.
    account_key: str = ""
    external_key: str  # e.g. Jira issue key "PZ-42"
    external_url: str = ""
    updated_at: datetime = Field(default_factory=utcnow)


class WorkspaceIntegration(BaseModel):
    """One workspace's binding to one tracker *account*, with that account's own
    webhook signing secret.

    Its own row rather than a key inside `Workspace.integration_config` for the
    same two reasons `RepoWebhook` is not a field on `Project`: `Workspace` is
    serialized directly by several routes (`response_model=Workspace`), so a
    ciphertext secret stored there could leak by accident, and
    `(provider, account_key)` as a unique constraint makes the account →
    workspace mapping unique *by construction* — which is precisely what
    routing an inbound delivery on `(provider, external_key)` alone did not
    guarantee.

    `integration_config[provider]` keeps holding the non-secret settings
    (`base_url`, `project_key`, `status_map`); only the account identity and the
    secret live here.

    Never returned by an API route.
    """

    workspace_id: str
    provider: str  # "jira" | "clickup"
    # The normalized provider account: scheme + lowercased host, no trailing
    # slash (app/integrations/account.py::normalize_account_key). Never empty.
    account_key: str
    webhook_secret_ref: str  # ciphertext (app/secrets.py), never plaintext
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class TrackerIntegrationOut(BaseModel):
    """What an admin sees after binding a workspace to a tracker account.

    `webhook_secret` is plaintext and is populated on exactly two responses:
    the one that *mints* a secret (a first bind, or a rebind to a different
    account) and an explicit rotate. Every other response — a re-save of the
    same account's settings, and every read anywhere in the API — leaves it
    `None`. This is the one-time-reveal pattern, and the reason it exists is
    that Jira's own webhook UI works the same way: the admin pastes the secret
    into Jira by hand, and Atlassian likewise never shows it again ("You can't
    retrieve your secret after you generate it - if you lose it, you have to
    get a new one"). Unlike GitHub, the cloud cannot register a Jira webhook on
    the admin's behalf — that needs a Connect/OAuth app, not the API token this
    integration authenticates with — so *something* has to be transcribed, and
    a reveal that happens once beats a reveal route that answers forever.

    `WorkspaceIntegration` itself is still never serialized by a route: this is
    a separate, deliberately narrow projection of it, for the same reason
    `RepoWebhook` is not a field on `Project`.
    """

    workspace_id: str
    provider: str
    account_key: str
    webhook_secret: str | None = None
    # Where the admin pastes that secret, and which header we read the digest
    # from — spelled out because getting either wrong fails as a silent 401.
    signature_header: str = ""


class JiraIntegrationConfig(BaseModel):
    """Non-secret Jira settings stored on the workspace. The API token +
    webhook secret live in the server env, never here (ADR 0010 §5)."""

    base_url: str  # https://your-org.atlassian.net
    project_key: str  # "PZ"
    # PromptWorkspace TaskStatus value -> Jira status name used in transitions.
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
# newest pw_deployments row on purpose — the same trade `repo_url` already
# makes — because GET /projects backs the workspace project list and the
# engine roster, and neither can afford a join or an N+1 to answer "is this
# project live, and where".
#
# Different lifetimes, different writers, different authorization. Keeping
# them in one blob would mean a member PATCH and a webhook write racing for
# the same column.
class StackJudgment(BaseModel):
    """A TypeSafe read of which runtime and services a project's plan calls
    for (app/deployments/stack_judge.py), pinned so that the seed preview and
    the real seed — and any retry of it — select the same files.

    Raw probabilities, not decisions: the thresholds that turn these into a
    profile live in code (`stack_judge.apply_judgment`), so tightening one
    needs no second model call. Valid only while `input_sha256` matches the
    state it was asked about; a changed plan is simply asked again.
    """

    input_sha256: str
    model: str
    # The chosen option ("node" | "python" | "go" | "other") and how
    # concentrated the distribution behind it was.
    runtime: str
    runtime_confidence: float
    # Service name -> probability the plan needs it run alongside the app.
    services: dict[str, float] = Field(default_factory=dict)
    judged_at: datetime = Field(default_factory=utcnow)


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
    # Server-only: never accepted from DeploymentConfigUpdate, so a PATCH that
    # changes the template also drops it and the next seed asks again.
    stack_judgment: StackJudgment | None = None


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
    """One row per deploy, in `pw_deployments`.

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
    # uncomputed | frozen (migration 0033). Whether this build's task set in
    # pw_deployment_tasks has been resolved yet — which is a different fact
    # from the set being empty, and used to be indistinguishable from it. A
    # frozen set is never recomputed: GitHub redelivers webhooks freely, and
    # a redelivery must not rewrite what a reviewer already relied on. The
    # only thing that clears this is the admin-only reattribute endpoint.
    attribution_state: str = "uncomputed"
    attributed_at: datetime | None = None
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
    # How the project came by its repository (plan 0027, migration 0035):
    # "imported" by POST /projects, "created" by create_repository. Written by
    # the server only — no route accepts it, and migration 0036 took member
    # writes on pw_projects away — unlike the repository's description, which
    # anyone with admin on the repository can edit. `None` for a project with no
    # repository yet, or one that predates the field; see `is_imported`.
    repo_origin: Literal["imported", "created"] | None = None
    # Nullable: `None` = never selected (backward compatible with every
    # project created before this feature). See PolicyScope above.
    policy_scope: PolicyScope | None = None
    # Whether policy_scope came from the workspace default or the project (plan 0033;
    # migration 0011 column, default 'project').
    policy_scope_source: Literal["workspace", "project"] = "project"
    # ADR 0021. Both nullable for the same backward-compatibility reason:
    # `None` config = no template ever chosen, `None` state = nothing ever
    # deployed. See the DeploymentConfig/DeploymentState note above for why
    # these are two fields and not one.
    deployment_config: DeploymentConfig | None = None
    deployment_state: DeploymentState | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    @property
    def is_imported(self) -> bool:
        """Whether the repository is one the user brought (plan 0027). A
        project with no recorded origin that names a repository before
        `repo_created` predates `repo_origin`, and is treated as imported:
        that is the non-destructive reading — its seed never overwrites, and
        its planning waits on a baseline — whereas guessing "created" would
        hand a real team's repository the overwriting seed."""
        if self.repo_origin is not None:
            return self.repo_origin == "imported"
        return bool(self.repo_url) and self.lifecycle_status != "repo_created"


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
#   "pz"     — PromptWorkspace-authoritative (AI-native: agent evidence, spec lineage)
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
        "change_id": "pz",
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


def _declared_defaults(model: type[BaseModel]) -> dict:
    """Each optional field's default, JSON-safe.

    The creation gate in app/db/merge.py needs a value to put back when a writer
    authors a field it does not own on a first write: substituting the default
    keeps every row in one batch carrying the same columns (a PostgREST bulk
    insert requires that) where dropping the key would not. A required field has
    no entry — see the gate for what it does then.
    """
    defaults: dict = {}
    for name, field in model.model_fields.items():
        if field.is_required():
            continue
        value = field.get_default(call_default_factory=True)
        defaults[name] = value.value if isinstance(value, Enum) else value
    return defaults


FIELD_DEFAULTS: dict[str, dict] = {
    etype: _declared_defaults(model) for etype, model in ENTITY_TYPES.items()
}


class GraphUpsertRequest(BaseModel):
    """A delta (or full snapshot) pushed by the local engine. All lists optional."""

    requirements: list[Requirement] = Field(default_factory=list)
    spec_documents: list[SpecDocument] = Field(default_factory=list)
    tasks: list[Task] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    agent_runs: list[AgentRun] = Field(default_factory=list)
    discussions: list[Discussion] = Field(default_factory=list)
    # DEAD FIELD — accepted, never read (plan 0015 M2). The writer's authority
    # domain is a property of the code path that holds the credential, not of the
    # request body: `repo.upsert_graph`'s `source` argument is a hardcoded literal
    # at every call site ("pz" from the sync route and the cloud's own writers,
    # "pmo" only inside the signature-verified tracker webhook). It stays on the
    # model because the engine's snapshot still sends `"source": "pz"`
    # (apps/engine/src/sync/loop.ts) and an old binary must not get a 422 for it.
    # Do not wire it to anything: a writer that names its own authority domain
    # can write any field it likes.
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
    # Keyset continuation: when a `limit` truncates the page, the client re-pulls
    # with after_ts=cursor & after_id=next_id. `has_more` False with `next_id`
    # None means drained. The full contract every adapter implements — global
    # (updated_at, id) ordering, the exclusive keyset predicate applied before
    # limiting, and what `limit` counts — is stated once on
    # `Repository.get_graph` in app/db/repository.py; read it before changing
    # either adapter.
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
    # A binding is pending until GitHub confirms it accepted this secret. This
    # state is durable so overlapping requests never mistake another request's
    # provisional secret for a known-good one.
    registration_state: Literal["pending", "confirmed"] = "confirmed"
    registration_owner: str | None = None
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
    written to `pw_workspace_model_connections`, and carries the
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
    `pw_rag_chunks.embedding` was a fixed `vector(1536)` column, so no chunk
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


class GithubRepoImportedBy(BaseModel):
    """The project that already imported a repository. Both fields are null
    when that project belongs to a workspace the caller is not a member of:
    the picker can still say the repository is taken, but must not disclose
    another workspace's project (the 409 at create time keeps the same
    silence)."""

    project_id: str | None = None
    name: str | None = None


class GithubRepoOut(BaseModel):
    """One repository the workspace's PAT can see, for the import picker
    (GET /workspaces/{id}/integrations/github/repos)."""

    full_name: str
    name: str
    html_url: str
    default_branch: str
    private: bool
    archived: bool = False
    # Advisory hint: GitHub's `size == 0` unless a push landed after the
    # repository was created (`pushed_at` > `created_at` + 2 s), since `size`
    # lags for hours after a first push. It can be wrong either way, so the
    # picker only warns; POST /projects confirms the default branch head and
    # refuses with `repo_is_empty` when there is no commit to seed from.
    empty: bool = False
    pushed_at: datetime | None = None
    # Set when a project already imported this repository (matched on GitHub's
    # numeric id, so a rename does not hide it). Advisory for the picker, which
    # disables the row; POST /projects still answers 409 `repo_already_imported`.
    imported_by: GithubRepoImportedBy | None = None


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


# Which door wrote a stage document: a generation, the editor, or an accepted
# agent draft.
StageDocumentSource = Literal["generated", "manual", "agent"]


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
    # Provenance: None for rows written before migration 0012.
    source: StageDocumentSource | None = None


class StageInputs(BaseModel):
    """The Planner form answers a stage was (or will be) generated from — one
    row per (project, stage), shared by the project's members. Kept apart
    from StageDocument on purpose: an answers-only save must never look like
    a generated stage to anything that reads stage documents (the Planner's
    done-state, RAG, repository seeding)."""

    project_id: str
    workspace_id: str
    stage: Literal["constitution", "specify", "plan"]
    inputs: dict[str, str] = Field(default_factory=dict)
    updated_by: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)


DeliveryChangeKind = Literal["setup", "foundational", "story", "other", "polish", "unphased"]


class DeliveryChange(BaseModel):
    """One PR-sized slice of delivery, plan 0029's "Change", derived from one
    `## Phase N:` section of tasks.md. Named DeliveryChange in code because
    `/sync/projects/{id}/changes` already means the sync head. `ref` ("C3") is
    assigned once at creation and never renumbered; `key` is what a
    regeneration matches on ("setup", "story:2", ...)."""

    id: str = Field(default_factory=new_id)
    project_id: str
    workspace_id: str
    ref: str
    key: str
    title: str
    kind: DeliveryChangeKind
    story: int | None = None
    priority: str | None = None
    position: int
    depends_on: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    deleted_at: datetime | None = None


ProjectHat = Literal["business_owner", "tech_steward"]


class ProjectRole(BaseModel):
    """Who wears a project hat (plan 0029 §5.2). No row means workspace admins
    act for that hat."""

    project_id: str
    workspace_id: str
    hat: ProjectHat
    user_id: str
    assigned_by: str
    created_at: datetime = Field(default_factory=utcnow)


DecisionKind = Literal["intent_approval", "plan_approval"]
DecisionStatus = Literal["open", "approved", "rejected", "withdrawn", "expired"]


class Decision(BaseModel):
    """A recorded human judgement (plan 0029 §5.1). This slice has two kinds,
    both approvals, bound to the SHA-256 of the decision's subject as the
    requester saw it (a stage document; for the plan approval, project rules,
    plan and tasks) (`subject_hash`)."""

    id: str = Field(default_factory=new_id)
    project_id: str
    workspace_id: str
    kind: DecisionKind
    title: str
    subject_stage: Literal["specify", "tasks"]
    subject_hash: str
    # The document text the hash covers, stored at request time (migration
    # 0006) so an approver sees what they sign and what changed. `None` for a
    # decision made before the column existed.
    subject_content: str | None = None
    routed_hat: ProjectHat
    status: DecisionStatus = "open"
    rationale: str | None = None
    requested_by: str
    resolved_by: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    resolved_at: datetime | None = None
    # When an unanswered decision counts as no (v2.1 View 1: timeouts).
    # None for a decision made before migration 0009.
    expires_at: datetime | None = None
    # When the "expires soon" email went out; at most one per decision.
    reminded_at: datetime | None = None


ReceiptEvent = Literal[
    "decision.requested",
    "decision.approved",
    "decision.rejected",
    "decision.withdrawn",
    "decision.expired",
    "decision.snapshot_erased",
    "role.assigned",
    "role.cleared",
    "policy_scope.updated",
]


class ReceiptDraft(BaseModel):
    """What a receipt records, before it is sealed into a project's chain
    (enterprise AI v2.1 D1). `body` holds ids, hashes, kinds and statuses
    only: never document text or free text, which may be personal data."""

    project_id: str
    workspace_id: str
    event: ReceiptEvent
    subject_type: Literal["decision", "project_role", "project_policy"]
    subject_id: str
    actor: str
    body: dict[str, str | int | bool | None] = Field(default_factory=dict)


class Receipt(ReceiptDraft):
    """One link of a project's append-only hash chain (`pw_receipts`).
    `hash` covers every other field (app/delivery/receipts.py)."""

    id: str = Field(default_factory=new_id)
    seq: int
    prev_hash: str
    hash: str = ""
    created_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Generation (M1, plan 0007) — stage-prompt generation endpoints, still BYO.
# `generation_runs` is an audit/cost-accounting record, not itself part of
# the task graph: the generated artifact lands as a Requirement/SpecDocument/
# Task via the existing sync/upsert path instead (see app/api/generation.py).
# --------------------------------------------------------------------------- #
class GenerateRequest(BaseModel):
    user_input: str
    options: dict = Field(default_factory=dict)


class TaskSummary(BaseModel):
    """A task reduced to what the workspace overview counts (plan 0033)."""

    task_id: str
    project_id: str
    status: TaskStatus
    assigned_user_id: str | None = None
    agent_closed: bool = False
    updated_at: datetime


class GenerationRun(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    project_id: str | None = None
    stage: str
    model_source: str = "byo"
    model: str
    status: GenerationRunStatus = GenerationRunStatus.running
    prompt_tokens: int = 0
    completion_tokens: int = 0
    created_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Repository analysis (plan 0027) — what the platform read out of an imported
# repository before planning against it. One current analysis per project,
# not a Spec Kit stage: the `stage` Literal on StageDocument is closed on
# purpose (app/integrations/repo_seed.py's docstring), and the baseline is an
# *input* to planning rather than a planning output.
# --------------------------------------------------------------------------- #
RepoAnalysisStatus = Literal["snapshot_ready", "baseline_ready", "failed"]


class RepoStack(BaseModel):
    # One of the runtimes app/deployments/plan_profile.py can scaffold for
    # ("node", "python", "go"), another language name when the manifests
    # point elsewhere, or None when nothing recognisable was found.
    runtime: str | None = None
    # Root-level manifests and build files found, e.g. "package.json".
    manifests: list[str] = Field(default_factory=list)
    # Most common source languages by file count, most common first.
    languages: list[str] = Field(default_factory=list)


class RepoExcerpt(BaseModel):
    path: str
    content: str
    truncated: bool = False


class RepoSkippedFile(BaseModel):
    """A path the snapshot left out (app/imports/snapshot.py::skipped_files):
    a vendored or build directory (one entry, path ending in `/`), a binary
    file, or a secret-shaped file whose content is never fetched."""

    path: str
    reason: Literal["vendored", "binary", "secret"]


class RepoSnapshot(BaseModel):
    """Deterministic read of one commit of the repository
    (app/imports/snapshot.py). Secret-shaped files (`.env*`, keys,
    certificates) are never fetched, so none of this ever carried a
    credential into a prompt or into this row. Their *names* are stored in
    `skipped` (shown to admins only, app/api/repo_analysis.py::_out), and env
    templates (`.env.example`, `.env.sample`, `.env.template`) are also listed
    in `paths` so a task extends one rather than adding another."""

    commit_sha: str
    default_branch: str
    # Files after vendored/build/binary/secret filtering, before the path cap.
    file_count: int = 0
    # GitHub truncated the recursive tree listing (a very large repository).
    tree_truncated: bool = False
    # Per-directory file counts, one line per directory, capped.
    tree_summary: str = ""
    stack: RepoStack = Field(default_factory=RepoStack)
    excerpts: list[RepoExcerpt] = Field(default_factory=list)
    # The filtered file paths plus env template names, capped — enough for the
    # Planner to show and for
    # a reader to know what was looked at. The no-overwrite check at repository
    # creation does NOT read this: it reads the live tree, so a file pushed
    # after the analysis still cannot be overwritten.
    paths: list[str] = Field(default_factory=list)
    # Declaration and TODO/stub lines of up to 60 source files (plan 0028),
    # redacted, one RepoExcerpt per file whose outline is non-empty. Verbatim
    # source lines, so withheld from members exactly as `excerpts` is.
    source_outlines: list[RepoExcerpt] = Field(default_factory=list)
    # "N test files: tests/ 12, src/ 3" or "no test files found". Empty on a
    # snapshot stored before plan 0028.
    test_summary: str = ""
    # What the filter left out and why, capped; `skipped_count` is every file
    # skipped, so `file_count` of `file_count + skipped_count` were read. An env
    # template is listed in `paths` but never read, so it is counted here and
    # not in `file_count`. Empty on a snapshot stored before the trust-test
    # fixes (finding #6).
    skipped: list[RepoSkippedFile] = Field(default_factory=list)
    skipped_count: int = 0


class RepoAnalysis(BaseModel):
    project_id: str
    workspace_id: str
    commit_sha: str
    snapshot: RepoSnapshot
    baseline: str = ""
    status: RepoAnalysisStatus = "snapshot_ready"
    created_by: str
    updated_at: datetime = Field(default_factory=utcnow)
    # Who wrote the baseline: the managed model ("cloud") or a local coding
    # agent ("agent"), and which model the agent reported.
    source: Literal["cloud", "agent"] = "cloud"
    model: str | None = None


DraftSource = Literal["agent"]
StageDraftStatus = Literal["pending", "rejected"]


class StageDraft(BaseModel):
    """A planning document a local coding agent submitted, awaiting a
    decision from someone who may author that stage. One row per (project,
    stage); a new submission replaces the old one."""

    id: str = Field(default_factory=new_id)
    project_id: str
    workspace_id: str
    stage: Literal["constitution", "specify", "plan", "tasks"]
    markdown: str
    source: DraftSource = "agent"
    model: str | None = None
    status: StageDraftStatus = "pending"
    rejection_note: str | None = None
    last_error: str | None = None
    # sha256 of the predecessor stage's content this draft was written
    # against: its pending draft at submit time if there was one, else its
    # stored document, else "". None for constitution (no predecessor).
    predecessor_fingerprint: str | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utcnow)


class StageDraftIn(BaseModel):
    """What a local agent submits for one stage. Stored exactly as received;
    it becomes the stage document only when a human accepts it."""

    stage: Literal["constitution", "specify", "plan", "tasks"]
    markdown: str = Field(min_length=1, max_length=100_000)
    model: str | None = Field(default=None, max_length=200)


class StageDraftWarning(BaseModel):
    code: Literal[
        "missing_task_numbers", "unmarked_new_paths", "no_task_lines", "empty_document"
    ]
    items: list[Any]


class StageDraftOut(BaseModel):
    id: str
    project_id: str
    stage: str
    markdown: str
    source: str
    model: str | None
    status: StageDraftStatus
    stale: bool
    rejection_note: str | None
    last_error: str | None
    created_by: str
    created_at: datetime
    # Only the submit response carries warnings: they are what the agent
    # must fix before submitting again. Everywhere else this is empty.
    warnings: list[StageDraftWarning] = []


class StageDraftAcceptIn(BaseModel):
    # The draft the human read. A draft resubmitted since has a new id, and
    # accepting it unseen is refused with 409 `draft_changed`.
    draft_id: str = Field(min_length=1, max_length=64)
    # The reviewer's edited text from the stage editor. When given and not
    # blank it is applied instead of the draft's own markdown.
    markdown: str | None = Field(default=None, max_length=100_000)


class StageDraftRejectIn(BaseModel):
    draft_id: str = Field(min_length=1, max_length=64)
    note: str = Field(default="", max_length=2_000)

# -- OAuth authorization server (migration 0013) ---------------------------- #
# Design: docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md,
# "Cloud: the authorization server". Codes and refresh tokens are held only as
# hashes; these rows are service-only.
OAuthClientKind = Literal["preregistered", "cimd", "dcr"]


class OAuthClient(BaseModel):
    client_id: str
    kind: OAuthClientKind
    client_name: str = ""
    redirect_uris: list[str]
    client_uri: str | None = None
    logo_uri: str | None = None
    token_endpoint_auth_method: Literal["none"] = "none"
    metadata: dict = {}
    created_at: datetime
    last_used_at: datetime | None = None


class OAuthRequest(BaseModel):
    request_id: str = Field(default_factory=new_id)
    client_id: str
    redirect_uri: str
    code_challenge: str
    resource: str
    scope: str
    state: str | None
    created_at: datetime
    expires_at: datetime
    approved_user_id: str | None = None
    approved_at: datetime | None = None
    denied_at: datetime | None = None


class OAuthCode(BaseModel):
    code_hash: str
    request_id: str
    family_id: str
    client_id: str
    user_id: str
    redirect_uri: str
    code_challenge: str
    resource: str
    scope: str
    expires_at: datetime
    used_at: datetime | None = None


class OAuthRefreshToken(BaseModel):
    token_hash: str
    family_id: str
    client_id: str
    user_id: str
    scope: str
    resource: str
    issued_at: datetime
    expires_at: datetime
    rotated_to_hash: str | None = None
    rotated_at: datetime | None = None
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None
    user_agent: str | None = None


class OAuthFamily(BaseModel):
    family_id: str
    client_id: str
    user_id: str
    created_at: datetime = Field(default_factory=utcnow)
    revoked_at: datetime | None = None
    revoked_reason: str | None = None



class ConsentWorkspace(BaseModel):
    id: str
    name: str


class ConsentView(BaseModel):
    """What the web consent page shows for a pending `/oauth/authorize`.
    `vendor`/`verified` come from the redirect URIs, never the self-declared
    name; `loopback` means "an app on this computer"."""

    client_name: str
    client_uri: str | None = None
    logo_uri: str | None = None
    vendor: str | None = None
    verified: bool
    redirect_host: str
    loopback: bool
    scopes: list[str]
    account_email: str
    workspaces: list[ConsentWorkspace]
    expires_at: datetime


class ConsentDecisionOut(BaseModel):
    redirect_to: str


DCR_MAX_BODY = 16_384
DCR_MAX_URI = 2048
DCR_MAX_SCOPE = 1000


def _cap_dcr_uri(v: Any) -> Any:
    # Checked on the raw string: pydantic's URL types have no length cap.
    if isinstance(v, str) and len(v) > DCR_MAX_URI:
        raise ValueError(f"URI longer than {DCR_MAX_URI} characters")
    return v


class DcrRegistrationIn(BaseModel):
    """RFC 7591 client metadata accepted by `POST /oauth/register`. Public
    clients only: no secret is ever issued or stored. The route reports
    validation failures as RFC 7591 §3.2.2 errors, never as 422."""

    MAX_BODY: ClassVar[int] = DCR_MAX_BODY

    redirect_uris: list[Annotated[AnyUrl, BeforeValidator(_cap_dcr_uri)]] = Field(
        min_length=1, max_length=10
    )
    client_name: str = Field("", max_length=120)
    client_uri: AnyHttpUrl | None = None
    logo_uri: AnyHttpUrl | None = None
    application_type: Literal["web", "native"] | None = None
    token_endpoint_auth_method: Literal["none"] = "none"
    grant_types: list[str] | None = Field(None, max_length=10)
    response_types: list[str] | None = Field(None, max_length=10)
    scope: str | None = Field(None, max_length=DCR_MAX_SCOPE)

    @field_validator("client_uri", "logo_uri", mode="before")
    @classmethod
    def _cap_uri(cls, v: Any) -> Any:
        return _cap_dcr_uri(v)


class DcrRegistrationOut(BaseModel):
    client_id: str
    client_id_issued_at: int
    redirect_uris: list[str]
    client_name: str
    token_endpoint_auth_method: Literal["none"]
    grant_types: list[str]
    response_types: list[str]


class RepoAnalysisOut(BaseModel):
    """GET/PATCH/SSE-`done` shape. A project with no analysis yet answers
    200 with `status: "none"` rather than 404, the way a stage document that
    was never saved answers with empty content."""

    project_id: str
    status: Literal["none", "snapshot_ready", "baseline_ready", "failed"]
    # True while the analysis gates planning: an imported project before
    # `repo_created`. The Planner shows the analysis panel only then.
    required: bool
    commit_sha: str | None = None
    snapshot: RepoSnapshot | None = None
    baseline: str = ""
    updated_at: datetime | None = None
    # The default branch has moved past `commit_sha`. None when that could not
    # be checked (GitHub unreachable, token missing) or there is nothing to
    # compare — "unknown" is not the same fact as "fresh".
    stale: bool | None = None


class AgentRepoAnalysisIn(BaseModel):
    """A snapshot and baseline a local coding agent wrote from its own
    checkout, posted instead of the cloud reading the repository itself."""

    default_branch: str = Field(min_length=1, max_length=200)
    # A full commit id as `git rev-parse` prints it: 40 lowercase hex (SHA-1)
    # or 64 (SHA-256). An abbreviation could never match the branch head the
    # staleness check compares it with.
    commit_sha: str = Field(pattern=r"^[0-9a-f]{40}$|^[0-9a-f]{64}$")
    paths: list[Annotated[str, StringConstraints(max_length=1024)]] = Field(
        default_factory=list, max_length=50_000
    )
    file_count: int = Field(ge=0)
    tree_truncated: bool = False
    stack: RepoStack = Field(default_factory=RepoStack)
    tree_summary: str = Field(default="", max_length=20_000)
    baseline: str = Field(min_length=1, max_length=100_000)
    model: str | None = Field(default=None, max_length=200)


class RepoAnalysisBaselineUpdate(BaseModel):
    baseline: str = Field(max_length=100_000)


class RelocatedFile(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_path: str = Field(alias="from")
    to_path: str = Field(alias="to")


class SeedPreviewOut(BaseModel):
    """GET /projects/{id}/repository/seed-preview (plan 0027 M4). `write` is
    every path the seed commit will write, relocated ones at their new path;
    `conflicts` non-empty means create-repository will refuse with
    `deploy_workflow_conflict`."""

    write: list[str]
    relocated: list[RelocatedFile] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)


class RepositoryDocFile(BaseModel):
    """One seeded planning document, compared with the repository's default
    branch by git blob sha (app/integrations/repo_docs.py)."""

    path: str
    # `in_pull_request`: differs from the default branch, and the open sync
    # pull request's branch already carries the rebuilt view.
    state: Literal["current", "out_of_date", "missing", "in_pull_request"]


class OpenSyncPr(BaseModel):
    number: int
    url: str
    # The pull request's branch changes more than the planning documents (or
    # someone else opened it on the branch the next sync would use): the
    # sync refuses with `sync_branch_has_foreign_changes` until it is cleared.
    foreign_changes: bool = False


class RepositoryDocsStatus(BaseModel):
    """GET /projects/{id}/repository/docs-status."""

    files: list[RepositoryDocFile]
    open_sync_pr: OpenSyncPr | None = None


class SyncDocsOut(BaseModel):
    """POST /projects/{id}/repository/sync-docs: the pull request the changed
    documents went to, and which paths were committed."""

    pr_number: int
    pr_url: str
    branch: str
    files: list[str]


# --------------------------------------------------------------------------- #
# Workspace overview and governance (plan 0033)
# --------------------------------------------------------------------------- #
class ProjectCheckOut(BaseModel):
    id: str
    ok: bool
    text: str


class ProjectCardOut(BaseModel):
    id: str
    name: str
    lifecycle_status: str
    live_url: str | None = None
    updated_at: datetime
    hats: dict[str, str | None]
    contributors: list[str]
    task_counts: dict[str, int]
    decisions: dict[str, int]
    stack: dict | None = None
    policy: dict
    checks: list[ProjectCheckOut]
    agent_closed_30d: int = 0
    last_activity_at: datetime


class WorkspaceGovernance(BaseModel):
    workspace_id: str
    policy_scope: PolicyScope = Field(default_factory=PolicyScope)
    required_hats: list[str] = Field(
        default_factory=lambda: ["business_owner", "tech_steward"]
    )
    require_seeded_rules: bool = True
    updated_by: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)

    @classmethod
    def default(cls, workspace_id: str) -> WorkspaceGovernance:
        return cls(workspace_id=workspace_id)


class WorkspaceGovernanceUpdate(BaseModel):
    """PUT /workspaces/{id}/governance body (full replace)."""

    policy_scope: PolicyScopeUpdate = Field(default_factory=PolicyScopeUpdate)
    required_hats: list[str] = Field(default_factory=list)
    require_seeded_rules: bool = True


class PersonLinkOut(BaseModel):
    kind: Literal["hat", "work", "approval"]
    from_user_id: str
    to_user_id: str | None = None
    project_id: str | None = None
    hat: str | None = None
    weight: int = 1


class WorkspaceOverviewOut(BaseModel):
    workspace_id: str
    generated_at: datetime
    members: list[WorkspaceMember]
    projects: list[ProjectCardOut]
    people: list[PersonLinkOut] = Field(default_factory=list)
    truncated: bool = False


class UsageStageOut(BaseModel):
    stage: str
    runs: int
    model: str
    tokens: int


class UsageSourceOut(BaseModel):
    source: Literal["managed", "byo"]
    provider: str | None = None
    runs: int
    tokens: int
    today_tokens: int
    daily_budget: int | None = None
    by_stage: list[UsageStageOut] = Field(default_factory=list)


class DisciplineOut(BaseModel):
    resolved: int
    open: int
    expired_30d: int
    median_hours_to_decide: float | None = None
    chains_verified: int
    chains_total: int


class ProjectGovernanceOut(BaseModel):
    project_id: str
    name: str
    checks: list[ProjectCheckOut]


class GovernanceReportOut(BaseModel):
    usage: list[UsageSourceOut]
    discipline: DisciplineOut
    projects: list[ProjectGovernanceOut]


# --------------------------------------------------------------------------- #
# Ask the workspace (plan 0033 task 20): the only context the model ever sees.
# --------------------------------------------------------------------------- #
class AskDecisionFact(BaseModel):
    project_id: str
    project_name: str
    kind: str
    expires_at: datetime | None = None


class AskMissingHatsFact(BaseModel):
    project_id: str
    name: str
    hats: list[str]


class AskOverdueFact(BaseModel):
    project_id: str
    name: str
    count: int


class WorkspaceFacts(BaseModel):
    my_open_decisions: list[AskDecisionFact] = Field(default_factory=list)
    projects_missing_hats: list[AskMissingHatsFact] = Field(default_factory=list)
    overdue: list[AskOverdueFact] = Field(default_factory=list)
    expired: list[AskOverdueFact] = Field(default_factory=list)
    by_runtime: dict[str, list[str]] = Field(default_factory=dict)
    agent_closed_30d: int = 0
