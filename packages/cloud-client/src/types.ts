// Wire types, mirroring apps/cloud/app/models/schemas.py.
//
// This file is the ONLY place task statuses are named, and there is no local
// vocabulary and no mapping table anywhere in this extension. The engine has
// two (apps/engine/src/sync/loop.ts), and they are lossy in both directions —
// `verified` collapses to `done` on the way down, so a client that pulls a
// verified task and later pushes its status silently demotes it. If you find
// yourself writing a third map, stop and re-read ADR 0020.

export type TaskStatus = "todo" | "in_progress" | "implemented" | "verified";

export const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "implemented",
  "verified",
];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  implemented: "Implemented",
  verified: "Verified",
};

/** Stored as {text}[] to match Ideva Kit's card renderer. Do NOT flatten to
 *  plain strings — apps/cloud says the same thing at the other end. */
export interface AcceptanceCriterion {
  text: string;
}

export interface Task {
  id: string;
  project_id: string;
  spec_id?: string | null;
  title: string;
  status: TaskStatus;
  feature_tag?: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  assigned_user_id?: string | null;
  change_id?: string | null;
  updated_at?: string | null;
}

export interface AssignedTask {
  task: Task;
  project_id: string;
  project_name: string;
  workspace_id: string;
  workspace_name: string;
  repo_url?: string | null;
}

/** The cloud Planner's project lifecycle. Only `repo_created` guarantees a
 *  `repo_url`; every earlier state is a project that exists but has nothing to
 *  clone yet, which the Projects view has to render rather than hide. */
export type LifecycleStatus =
  | "planning"
  | "pending_tech_review"
  | "tech_review"
  | "repo_created";

/** Just enough of apps/cloud's Workspace to name it in a tree. */
export interface Workspace {
  id: string;
  name: string;
}

/** Deliberately a subset of apps/cloud's `Project`. The cloud row also carries
 *  stage state, policy scope and deployment config; none of that is rendered
 *  here, and naming a field we do not use is an invitation to start using it. */
export interface CloudProject {
  id: string;
  name: string;
  workspace_id: string;
  repo_url?: string | null;
  repo_default_branch?: string | null;
  lifecycle_status: LifecycleStatus;
}

export type ArtifactKind = "code" | "pr" | "doc";

export interface StatusArtifact {
  commit_sha: string;
  uri: string;
  kind: ArtifactKind;
}

export interface TaskStatusUpdate {
  status: TaskStatus;
  artifact?: StatusArtifact;
}

export interface StageDocument {
  id: string | null;
  stage: string;
  content: string;
  updated_at: string | null;
}

export interface SpecDocument {
  id: string;
  project_id: string;
  requirement_id: string;
  content: string;
  version: number;
}

export interface ProjectGraph {
  tasks: Task[];
  spec_documents: SpecDocument[];
  cursor?: string | null;
  next_id?: string | null;
  has_more?: boolean;
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as string[]).includes(value);
}

/** Statuses that mean "the work is done" for checkbox and auto-close purposes. */
export function isClosed(status: TaskStatus): boolean {
  return status === "implemented" || status === "verified";
}
