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
# Project
# --------------------------------------------------------------------------- #
class ProjectCreate(BaseModel):
    name: str


class Project(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
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


class GraphUpsertRequest(BaseModel):
    """A delta (or full snapshot) pushed by the local engine. All lists optional."""

    requirements: list[Requirement] = Field(default_factory=list)
    spec_documents: list[SpecDocument] = Field(default_factory=list)
    tasks: list[Task] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    agent_runs: list[AgentRun] = Field(default_factory=list)


class GraphUpsertResponse(BaseModel):
    upserted: dict[str, int]
    cursor: datetime | None = None


class ProjectGraph(BaseModel):
    """Full (or incremental, when `since` is provided) view of a project's graph."""

    project: Project
    requirements: list[Requirement] = Field(default_factory=list)
    spec_documents: list[SpecDocument] = Field(default_factory=list)
    tasks: list[Task] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    agent_runs: list[AgentRun] = Field(default_factory=list)
    cursor: datetime | None = None
