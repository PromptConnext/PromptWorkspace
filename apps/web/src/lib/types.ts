// Mirrors apps/cloud/app/models/schemas.py. Keep field-for-field in sync with
// the backend models — this is a read-only client, not an independent schema.

export type RequirementStatus = "draft" | "approved";
export type SpecStatus = "draft" | "approved";
export type TaskStatus = "todo" | "in_progress" | "implemented" | "verified";
export type ArtifactKind = "code" | "doc" | "test" | "other";
export type AgentRunStatus = "running" | "succeeded" | "failed";
export type Role = "admin" | "member";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

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
  email: string | null;
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
  lifecycle_status: "planning" | "pending_tech_review" | "tech_review" | "repo_created";
  repo_url: string | null;
  repo_default_branch: string | null;
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
  assigned_user_id: string | null;
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

export type DiscussionSource = "pz" | "pmo";

export interface Discussion {
  id: string;
  project_id: string;
  parent_node_type: string;
  parent_node_id: string;
  author: string;
  body: string;
  source: DiscussionSource;
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
  discussions: Discussion[];
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

// An invitation addressed to the signed-in user (GET /invitations/pending).
// Carries the workspace name because the invitee is not a member yet and so
// cannot read the workspace row directly.
export interface PendingInvitation {
  token: string;
  workspace_id: string;
  workspace_name: string;
  role: Role;
  invited_by: string;
  expires_at: string;
}

// Non-secret view of a workspace's GitHub credential
// (GET/PUT /workspaces/{id}/integrations/github). Never carries the token.
export interface GithubConnection {
  connected: boolean;
  owner: string | null;
  owner_type: string | null;
  account_login: string | null;
  token_expires_at: string | null;
  connected_at: string | null;
}

export interface InvitationCreateResponse {
  invitation: Invitation;
  accept_url: string;
  email_sent: boolean;
}

export type StageKind = "constitution" | "specify" | "plan" | "tasks";

export interface DocumentOut {
  id: string;
  project_id: string;
  title: string;
  mime: string;
  source_kind: string;
  extract_method: string | null;
  status: "pending" | "extracted" | "failed";
  created_at: string;
  updated_at: string;
}

export interface GenerateDoneEvent {
  stage: StageKind;
  title: string;
  content: string;
  requirement_id?: string;
  spec_document_id?: string;
  task_count?: number;
  // The model stopped at its output limit — the document is real but cut off.
  truncated?: boolean;
  // Whether the raw markdown was written to the stage-document side store,
  // i.e. whether it will still be there on the next visit to the project.
  saved?: boolean;
  updated_at?: string;
}

export interface GenerateErrorEvent {
  error: string;
  retryable?: boolean;
  // Set on a post-generation failure (unparseable document): the model's
  // output was kept as a draft even though nothing landed in the graph.
  draft_saved?: boolean;
  truncated?: boolean;
}

export interface StageDocumentOut {
  stage: StageKind;
  content: string;
  updated_at: string | null;
}
