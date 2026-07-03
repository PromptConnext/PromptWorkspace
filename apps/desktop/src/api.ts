export const ENGINE_URL = "http://127.0.0.1:47131";

export type OnboardingState = "not_started" | "in_progress" | "satisfied";

export type Recommendation = {
  provider: string;
  label: string;
  endpoint: string;
  model: string;
  needsKey: boolean;
  role: string;
};

export type Connection = {
  id: string;
  role: string;
  provider: string;
  endpoint: string;
  model: string;
  healthy: boolean;
};

export type Project = { id: string; name: string; path: string };

export type Graph = {
  project: Project;
  stages: { stage: string; status: string; gate_passed: number; approver: string | null }[];
  requirements: {
    id: string;
    title: string;
    description: string;
    status: string;
    specDocuments: {
      id: string;
      version: number;
      approved_by: string | null;
      content: string;
      tasks: { id: string; title: string; status: string }[];
    }[];
  }[];
  agentRuns: {
    id: string;
    action: string;
    status: string;
    evidence: string | null;
    created_at: string;
  }[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function engineHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/engine/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export const getOnboardingState = () =>
  request<{ state: OnboardingState }>("/engine/onboarding/state");

export const getRecommendations = () =>
  request<{ recommendations: Recommendation[] }>("/engine/onboarding/recommendations");

export const listModels = () => request<{ connections: Connection[] }>("/engine/models");

export const connectModel = (payload: {
  role: string;
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
}) =>
  request<{ id: string; verified: boolean }>("/engine/models/connect", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const listProjects = () => request<{ projects: Project[] }>("/engine/projects");

export const createProject = (name: string, path?: string) =>
  request<Project>("/engine/projects", {
    method: "POST",
    body: JSON.stringify({ name, ...(path ? { path } : {}) }),
  });

export const runScope = (projectId: string, description: string) =>
  request<{ requirementId: string; title: string; files: string[]; content: string }>(
    `/engine/projects/${projectId}/scope`,
    { method: "POST", body: JSON.stringify({ description }) },
  );

export const runSpec = (projectId: string) =>
  request<{ specDocumentId: string; files: string[]; content: string }>(
    `/engine/projects/${projectId}/spec`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const approveStage = (projectId: string, stage: string) =>
  request<{ ok: boolean }>(`/engine/projects/${projectId}/stages/${stage}/approve`, {
    method: "POST",
    body: JSON.stringify({ approver: "user" }),
  });

export const getGraph = (projectId: string) =>
  request<Graph>(`/engine/projects/${projectId}/graph`);
