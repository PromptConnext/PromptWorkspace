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
      tasks: { id: string; title: string; status: string; feature_tag?: string | null }[];
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

// Stage runs stream over SSE: `delta` events carry raw model tokens, then one
// `done` (JSON payload) or `error` event ends the stream.
async function requestSSE<T>(
  path: string,
  body: unknown,
  onDelta?: (text: string) => void,
): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done: T | null = null;
  let error: string | null = null;

  const handleEvent = (chunk: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    const payload = data.join("\n");
    if (event === "delta") onDelta?.(payload);
    else if (event === "done") done = JSON.parse(payload) as T;
    else if (event === "error") error = payload;
  };

  while (true) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      handleEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (error) throw new Error(error);
  if (done === null) throw new Error("stream ended without a result");
  return done;
}

export const runScope = (
  projectId: string,
  description: string,
  onDelta?: (text: string) => void,
) =>
  requestSSE<{ requirementId: string; title: string; files: string[]; content: string }>(
    `/engine/projects/${projectId}/scope`,
    { description },
    onDelta,
  );

export const runSpec = (projectId: string, onDelta?: (text: string) => void) =>
  requestSSE<{ specDocumentId: string; files: string[]; content: string }>(
    `/engine/projects/${projectId}/spec`,
    {},
    onDelta,
  );

export const runTasks = (projectId: string, onDelta?: (text: string) => void) =>
  requestSSE<{ specDocumentId: string; taskCount: number; files: string[]; content: string }>(
    `/engine/projects/${projectId}/tasks`,
    {},
    onDelta,
  );

export const runTaskImplementation = (taskId: string, onDelta?: (text: string) => void) =>
  requestSSE<{ taskId: string; commitSha: string; files: string[] }>(
    `/engine/tasks/${taskId}/run`,
    {},
    onDelta,
  );

export const approveStage = (projectId: string, stage: string) =>
  request<{ ok: boolean }>(`/engine/projects/${projectId}/stages/${stage}/approve`, {
    method: "POST",
    body: JSON.stringify({ approver: "user" }),
  });

export const getGraph = (projectId: string) =>
  request<Graph>(`/engine/projects/${projectId}/graph`);
