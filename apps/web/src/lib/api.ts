// Thin fetch wrapper against apps/cloud, mirroring cloudFetch in
// apps/engine/src/cloudClient.ts on the browser side.

import { CLOUD_API_URL } from "./config";
import type { Project, StageDocumentOut, StageKind, Task, WorkspaceMember } from "./types";

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
