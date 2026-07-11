// Mirrors apps/cloud/app/models/schemas.py. Keep field-for-field in sync with
// the backend models — this is a read-only client, not an independent schema.

export type RequirementStatus = "draft" | "approved";
export type SpecStatus = "draft" | "approved";
export type TaskStatus = "todo" | "in_progress" | "implemented" | "verified";
export type ArtifactKind = "code" | "doc" | "test" | "other";
export type AgentRunStatus = "running" | "succeeded" | "failed";
export type Role = "admin" | "member";
export type InvitationStatus = "pending" | "accepted" | "expired";

export interface Workspace {
  id: string;
  name: string;
  created_by: string;
  git_config: Record<string, unknown>;
  integration_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: Role;
  invited_by: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  workspace_id: string;
  owner_id: string;
  onboarding_state: string;
  stage_state: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface AcceptanceCriterion {
  text: string;
}

export interface Requirement {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: RequirementStatus;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface SpecDocument {
  id: string;
  project_id: string;
  requirement_id: string;
  content: string;
  version: number;
  status: SpecStatus;
  approved_by: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface Task {
  id: string;
  project_id: string;
  spec_id: string | null;
  title: string;
  status: TaskStatus;
  feature_tag: string | null;
  acceptance_criteria: AcceptanceCriterion[];
  assignee: string | null;
  sprint: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  project_id: string;
  task_id: string;
  kind: ArtifactKind;
  uri: string;
  commit_sha: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  project_id: string;
  task_id: string;
  model_role: string;
  action: string;
  status: AgentRunStatus;
  evidence: Record<string, unknown>;
  updated_at: string | null;
  deleted_at: string | null;
  field_versions: Record<string, unknown>;
}

export interface ProjectGraph {
  project: Project;
  requirements: Requirement[];
  spec_documents: SpecDocument[];
  tasks: Task[];
  artifacts: Artifact[];
  agent_runs: AgentRun[];
  cursor: string | null;
  next_id: string | null;
  has_more: boolean;
}

export interface Invitation {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  token: string;
  status: InvitationStatus;
  invited_by: string;
  expires_at: string;
  created_at: string;
}
