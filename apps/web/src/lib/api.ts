// Thin fetch wrapper against apps/cloud, mirroring cloudFetch in
// apps/engine/src/cloudClient.ts on the browser side.

import { CLOUD_API_URL } from "./config";
import type {
  DocumentOut,
  PolicyScope,
  PolicyTemplateOut,
  PrefillOut,
  Project,
  StageDocumentOut,
  StageKind,
  Task,
  WorkspaceMember,
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
