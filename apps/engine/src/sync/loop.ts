// D2 (docs/plans/0004): push the linked project's local graph to apps/cloud
// on an interval + on demand. Pull-back (apps/cloud -> local SQLite) is
// deliberately out of scope for this cut — see the note at the bottom.
import { db, getAppState, setAppState } from "../db.ts";
import { cloudFetch } from "../cloudClient.ts";

export const CLOUD_SYNC_POLL_SECONDS = Number(process.env.CLOUD_SYNC_POLL_SECONDS ?? 20);

// Local status vocabularies are finer-grained (and in one case, differently
// shaped) than the cloud's — both were verified by reading the actual write
// paths in routes/projects.ts, not assumed. Mapping is intentionally lossy;
// the cloud graph is a coarser shared view, local SQLite stays the detailed
// source of truth.
const TASK_STATUS_TO_CLOUD: Record<string, string> = {
  todo: "todo",
  running: "in_progress",
  done: "implemented",
  // no cloud equivalent for a failed run — surfaces as "needs another pass",
  // which "todo" represents better than inventing a status the enum lacks.
  failed: "todo",
};

const REQUIREMENT_STATUS_TO_CLOUD: Record<string, string> = {
  draft: "draft",
  // cloud only distinguishes draft/approved; the in-review state collapses
  // to draft until a human approves it (same as it not being approved yet).
  awaiting_approval: "draft",
  approved: "approved",
};

type CloudLinkConfig = { workspace_id: string; project_id: string };

function getCloudLink(projectId: string): CloudLinkConfig | null {
  const row = db
    .prepare("SELECT config FROM integrations WHERE project_id = ? AND kind = 'cloud'")
    .get(projectId) as { config: string | null } | undefined;
  return row?.config ? (JSON.parse(row.config) as CloudLinkConfig) : null;
}

function linkedProjectIds(): string[] {
  return (
    db.prepare("SELECT project_id FROM integrations WHERE kind = 'cloud'").all() as {
      project_id: string;
    }[]
  ).map((r) => r.project_id);
}

// Assemble a full snapshot of one local project's graph in apps/cloud's
// GraphUpsertRequest shape. Local ids are pushed as-is as the cloud entity
// ids — no id-mapping table needed, the cloud accepts a client-supplied id.
function assembleSnapshot(localProjectId: string, cloudProjectId: string) {
  const requirements = (
    db
      .prepare("SELECT id, title, description, status FROM requirements WHERE project_id = ?")
      .all(localProjectId) as { id: string; title: string; description: string; status: string }[]
  ).map((r) => ({
    id: r.id,
    project_id: cloudProjectId,
    title: r.title,
    description: r.description ?? "",
    status: REQUIREMENT_STATUS_TO_CLOUD[r.status] ?? "draft",
  }));

  const specDocuments = (
    db
      .prepare(
        `SELECT sd.id, sd.requirement_id, sd.content, sd.version, sd.approved_by
         FROM spec_documents sd
         JOIN requirements r ON sd.requirement_id = r.id
         WHERE r.project_id = ?`,
      )
      .all(localProjectId) as {
      id: string;
      requirement_id: string;
      content: string;
      version: number;
      approved_by: string | null;
    }[]
  ).map((sd) => ({
    id: sd.id,
    project_id: cloudProjectId,
    requirement_id: sd.requirement_id,
    content: sd.content ?? "",
    version: sd.version,
    status: sd.approved_by ? "approved" : "draft",
    approved_by: sd.approved_by,
  }));

  const taskRows = db
    .prepare(
      `SELECT t.id, t.spec_id, t.title, t.status, t.feature_tag
       FROM tasks t
       JOIN spec_documents sd ON t.spec_id = sd.id
       JOIN requirements r ON sd.requirement_id = r.id
       WHERE r.project_id = ?`,
    )
    .all(localProjectId) as {
    id: string;
    spec_id: string;
    title: string;
    status: string;
    feature_tag: string | null;
  }[];

  const criteriaByTask = new Map<string, { text: string }[]>();
  for (const t of taskRows) {
    const rows = db
      .prepare("SELECT text FROM acceptance_criteria WHERE task_id = ?")
      .all(t.id) as { text: string }[];
    if (rows.length) criteriaByTask.set(t.id, rows);
  }

  const tasks = taskRows.map((t) => ({
    id: t.id,
    project_id: cloudProjectId,
    spec_id: t.spec_id,
    title: t.title,
    status: TASK_STATUS_TO_CLOUD[t.status] ?? "todo",
    feature_tag: t.feature_tag,
    acceptance_criteria: criteriaByTask.get(t.id) ?? [],
    // assignee/sprint are pmo-owned and not stored locally — omit rather
    // than push null, so a pz-sourced push can't clobber a tracker mirror.
  }));

  const artifacts = (
    db
      .prepare(
        `SELECT a.id, a.task_id, a.kind, a.uri, a.commit_sha
         FROM artifacts a
         JOIN tasks t ON a.task_id = t.id
         JOIN spec_documents sd ON t.spec_id = sd.id
         JOIN requirements r ON sd.requirement_id = r.id
         WHERE r.project_id = ?`,
      )
      .all(localProjectId) as {
      id: string;
      task_id: string;
      kind: string;
      uri: string;
      commit_sha: string | null;
    }[]
  ).map((a) => ({
    id: a.id,
    project_id: cloudProjectId,
    task_id: a.task_id,
    kind: a.kind,
    uri: a.uri,
    commit_sha: a.commit_sha,
  }));

  const agentRuns = (
    db
      .prepare(
        `SELECT ar.id, ar.task_id, ar.action, ar.status, ar.evidence, mc.role AS model_role
         FROM agent_runs ar
         LEFT JOIN model_connections mc ON ar.model_connection_id = mc.id
         WHERE ar.project_id = ?`,
      )
      .all(localProjectId) as {
      id: string;
      task_id: string | null;
      action: string;
      status: string;
      evidence: string | null;
      model_role: string | null;
    }[]
  )
    // agent_runs.task_id is nullable locally (cleared when its task is
    // deleted, see routes/projects.ts) but required by the cloud entity —
    // a run with no task left doesn't have anywhere to sync to.
    .filter((ar) => ar.task_id)
    .map((ar) => ({
      id: ar.id,
      project_id: cloudProjectId,
      task_id: ar.task_id as string,
      model_role: ar.model_role ?? "code",
      action: ar.action,
      status: ar.status,
      // local `evidence` is a free-text string; cloud's field is a dict.
      evidence: ar.evidence ? { note: ar.evidence } : {},
    }));

  return { requirements, spec_documents: specDocuments, tasks, artifacts, agent_runs: agentRuns, source: "pz" as const };
}

export type SyncResult = {
  at: string;
  ok: boolean;
  upserted?: Record<string, number>;
  error?: string;
};

function recordResult(localProjectId: string, result: SyncResult): void {
  setAppState(`cloud_sync_last:${localProjectId}`, JSON.stringify(result));
}

export function lastSyncResult(localProjectId: string): SyncResult | null {
  const raw = getAppState(`cloud_sync_last:${localProjectId}`);
  return raw ? (JSON.parse(raw) as SyncResult) : null;
}

export async function pushProjectSnapshot(localProjectId: string): Promise<SyncResult> {
  const link = getCloudLink(localProjectId);
  if (!link) {
    const result: SyncResult = { at: new Date().toISOString(), ok: false, error: "not linked" };
    recordResult(localProjectId, result);
    return result;
  }
  try {
    const snapshot = assembleSnapshot(localProjectId, link.project_id);
    const res = await cloudFetch<{ upserted: Record<string, number> }>(
      `/sync/projects/${link.project_id}/graph`,
      { method: "PUT", body: JSON.stringify(snapshot) },
    );
    const result: SyncResult = { at: new Date().toISOString(), ok: true, upserted: res.upserted };
    recordResult(localProjectId, result);
    return result;
  } catch (err) {
    const result: SyncResult = {
      at: new Date().toISOString(),
      ok: false,
      error: (err as Error).message,
    };
    recordResult(localProjectId, result);
    return result;
  }
}

let loopTimer: ReturnType<typeof setInterval> | null = null;

export function startCloudSyncLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(async () => {
    for (const projectId of linkedProjectIds()) {
      await pushProjectSnapshot(projectId).catch(() => {});
    }
  }, CLOUD_SYNC_POLL_SECONDS * 1000);
  loopTimer.unref?.();
}

export function stopCloudSyncLoop(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
}

// --- Deliberately not built in this cut -------------------------------
// Pull-and-apply (cloud graph -> local SQLite) needs its own schema
// decision: the local `tasks` table has no `assignee`/`sprint` columns, so
// there's nowhere to put the pmo fields a pull would bring back from a
// Jira/ClickUp mirror. Rather than guess a migration here, this ships
// push-only sync (the primary value: local work becomes visible to the
// team/cloud) and leaves pull as a follow-up once those columns exist.
