// Thin fetch wrapper against apps/cloud, mirroring cloudFetch in
// apps/engine/src/cloudClient.ts on the browser side.

import { CLOUD_API_URL } from "./config";
import type {
  DeployConnection,
  DeploymentStatus,
  DeploymentTemplateOut,
  DocumentOut,
  IndexStatus,
  PolicyScope,
  PolicyTemplateOut,
  PrefillOut,
  Project,
  StageDocumentOut,
  StageKind,
  Task,
  TaskStatus,
  WorkspaceMember,
  WorkspaceReindexResult,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  authHeaders: Record<string, string>,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${CLOUD_API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (data as { detail?: string }).detail ?? `cloud HTTP ${res.status}`);
  }
  return data as T;
}

export function listMembers(workspaceId: string, authHeaders: Record<string, string>) {
  return apiFetch<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`, authHeaders);
}

export function assignTask(
  projectId: string,
  taskId: string,
  assignedUserId: string | null,
  authHeaders: Record<string, string>,
) {
  return apiFetch<Task>(`/projects/${projectId}/tasks/${taskId}/assignment`, authHeaders, {
    method: "PATCH",
    body: JSON.stringify({ assigned_user_id: assignedUserId }),
  });
}

/**
 * Moving a card between board columns. Deliberately the narrow status route
 * and not a graph push — see the docstring on `set_task_status` in
 * apps/cloud/app/api/sync.py for why a full-`Task` write would clobber
 * tracker-owned fields. The `artifact` half of that endpoint's body is for
 * commit-driven closes (the VS Code extension); the board sends status alone.
 */
export function setTaskStatus(
  projectId: string,
  taskId: string,
  status: TaskStatus,
  authHeaders: Record<string, string>,
) {
  return apiFetch<Task>(`/projects/${projectId}/tasks/${taskId}/status`, authHeaders, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

// Uploaded source documents (PRDs and the like) live server-side, so the
// Planner reads them back on mount instead of remembering only what this
// browser tab happened to upload — otherwise a refresh loses the extracted
// state and invites the user to re-upload the same file.
export function listDocuments(projectId: string, authHeaders: Record<string, string>) {
  return apiFetch<DocumentOut[]>(`/projects/${projectId}/documents`, authHeaders);
}

// Direct fetch, not apiFetch: the response is the raw file (PDF bytes or
// Markdown source), not JSON. Returns a Blob the caller turns into an object
// URL for the PDF viewer or reads as text for the Markdown renderer.
export async function fetchDocumentContent(
  projectId: string,
  documentId: string,
  authHeaders: Record<string, string>,
): Promise<Blob> {
  const res = await fetch(
    `${CLOUD_API_URL}/projects/${projectId}/documents/${documentId}/content`,
    { headers: authHeaders },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { detail?: string }).detail ?? `cloud HTTP ${res.status}`);
  }
  return res.blob();
}

// Draft a stage's intake form from the uploaded PRD. The field list travels
// with the request: stage-forms.ts owns the questions, the cloud only answers
// them, so adding a field needs no cloud deploy.
export function prefillStage(
  projectId: string,
  stage: StageKind,
  fields: { key: string; label: string; hint?: string }[],
  authHeaders: Record<string, string>,
) {
  return apiFetch<PrefillOut>(`/projects/${projectId}/prefill/${stage}`, authHeaders, {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
}

export function getStageDocument(
  projectId: string,
  stage: StageKind,
  authHeaders: Record<string, string>,
) {
  return apiFetch<StageDocumentOut>(`/projects/${projectId}/stage-documents/${stage}`, authHeaders);
}

export function updateStageDocument(
  projectId: string,
  stage: StageKind,
  content: string,
  authHeaders: Record<string, string>,
) {
  return apiFetch<StageDocumentOut>(`/projects/${projectId}/stage-documents/${stage}`, authHeaders, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

// Idempotent — the design doc calls this "automatic on first Tech Lead
// interaction", so the client may fire it repeatedly (server no-ops if
// already tech_review).
export function startTechReview(projectId: string, authHeaders: Record<string, string>) {
  return apiFetch<Project>(`/projects/${projectId}/lifecycle/start-tech-review`, authHeaders, {
    method: "POST",
  });
}

// Built-in (and, later, workspace) compliance templates offered by the Policy
// Scope picker. Includes each template's full body — six small files, so a
// preview needs no second round trip.
export function listPolicyTemplates(authHeaders: Record<string, string>) {
  return apiFetch<PolicyTemplateOut[]>("/policy-templates", authHeaders);
}

// Full-replace PATCH: `scope` is the project's entire policy scope going
// forward, not a delta.
export function updatePolicyScope(
  projectId: string,
  scope: PolicyScope,
  authHeaders: Record<string, string>,
) {
  return apiFetch<Project>(`/projects/${projectId}/policy-scope`, authHeaders, {
    method: "PATCH",
    body: JSON.stringify(scope),
  });
}

// Deployment templates offered to the Tech Lead (ADR 0021). Each row
// carries its scaffold paths and full workflow text, so the picker previews
// what a template will commit without a request per template — the same
// reasoning as listPolicyTemplates above.
export function listDeploymentTemplates(authHeaders: Record<string, string>) {
  return apiFetch<DeploymentTemplateOut[]>("/deployment-templates", authHeaders);
}

// Admin-only on the server, and frozen once the repo exists (409
// project_frozen) — the repo already carries the previous template's
// scaffold, so the selection must not drift from what was committed.
export function updateDeploymentConfig(
  projectId: string,
  templateId: string,
  authHeaders: Record<string, string>,
) {
  return apiFetch<Project>(`/projects/${projectId}/deployment-config`, authHeaders, {
    method: "PATCH",
    body: JSON.stringify({ template_id: templateId }),
  });
}

// Membership-only read, deliberately: a business user finding the running
// application is the reason the feature exists, so this is not admin-gated.
export function getDeploymentStatus(projectId: string, authHeaders: Record<string, string>) {
  return apiFetch<DeploymentStatus>(`/projects/${projectId}/deployment`, authHeaders);
}

// Admin-only on the server. Verified against the provider before storage, so
// a 400 here means the provider rejected the token, not that we did.
export function getDeployConnection(
  workspaceId: string,
  providerId: string,
  authHeaders: Record<string, string>,
) {
  return apiFetch<DeployConnection>(
    `/workspaces/${workspaceId}/integrations/deploy/${providerId}`,
    authHeaders,
  );
}

export function connectDeployProvider(
  workspaceId: string,
  providerId: string,
  body: { token: string; values: Record<string, string> },
  authHeaders: Record<string, string>,
) {
  return apiFetch<DeployConnection>(
    `/workspaces/${workspaceId}/integrations/deploy/${providerId}`,
    authHeaders,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function disconnectDeployProvider(
  workspaceId: string,
  providerId: string,
  authHeaders: Record<string, string>,
) {
  return apiFetch<DeployConnection>(
    `/workspaces/${workspaceId}/integrations/deploy/${providerId}`,
    authHeaders,
    { method: "DELETE" },
  );
}

export function createRepository(
  projectId: string,
  body: { name?: string; private?: boolean },
  authHeaders: Record<string, string>,
) {
  return apiFetch<Project>(`/projects/${projectId}/lifecycle/create-repository`, authHeaders, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Enqueue-only: returns as soon as the embed jobs are queued, with no
// completion signal of its own (apps/cloud/app/api/assistant.py). The UI
// must say "queued", never "indexed" — pair with getIndexStatus below to
// show whether the queue actually drained.
export function reindexProject(projectId: string, authHeaders: Record<string, string>) {
  return apiFetch<{ enqueued: number }>(`/projects/${projectId}/assistant/reindex`, authHeaders, {
    method: "POST",
  });
}

// The honest completion signal reindexProject doesn't provide: what's
// actually indexed right now, read fresh from storage rather than inferred
// from an enqueue response.
export function getIndexStatus(projectId: string, authHeaders: Record<string, string>) {
  return apiFetch<IndexStatus>(`/projects/${projectId}/assistant/index-status`, authHeaders);
}

// Same enqueue-only contract as reindexProject, fanned out across every
// project in the workspace (apps/cloud/app/api/assistant.py::reindex_workspace).
// There is no workspace-level index-status endpoint — the response's
// per-project breakdown is the only completion signal this call gets.
export function reindexWorkspace(workspaceId: string, authHeaders: Record<string, string>) {
  return apiFetch<WorkspaceReindexResult>(
    `/workspaces/${workspaceId}/assistant/reindex`,
    authHeaders,
    { method: "POST" },
  );
}
