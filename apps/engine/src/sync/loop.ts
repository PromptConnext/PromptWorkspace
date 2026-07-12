// D2 (docs/plans/0004): push the linked project's local graph to apps/cloud
// on an interval + on demand. Pull-back (apps/cloud -> local SQLite) was
// deliberately out of scope for that cut (see the note at the bottom) — M12
// adds it, narrowly, for discussions only: comments authored in the web app
// need to reach desktop, and unlike tasks/requirements/etc. there's no local
// column-shape conflict to resolve first (a wholly new local table, nothing
// to reconcile against). Every other entity stays push-only, unchanged.
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

  // Only source='pz' rows — pmo-mirrored discussions were pulled FROM the
  // cloud (pullProjectDiscussions below), not authored here; re-pushing them
  // back would be a harmless but pointless echo (same shape as tasks
  // omitting pmo-owned assignee/sprint above).
  const discussions = (
    db
      .prepare(
        `SELECT id, parent_node_type, parent_node_id, author, body, source, deleted_at
         FROM discussions WHERE project_id = ? AND source = 'pz'`,
      )
      .all(localProjectId) as {
      id: string;
      parent_node_type: string;
      parent_node_id: string;
      author: string;
      body: string;
      source: string;
      deleted_at: string | null;
    }[]
  ).map((d) => ({
    id: d.id,
    project_id: cloudProjectId,
    parent_node_type: d.parent_node_type,
    parent_node_id: d.parent_node_id,
    author: d.author,
    body: d.body,
    source: d.source as "pz" | "pmo",
    deleted_at: d.deleted_at,
  }));

  return {
    requirements,
    spec_documents: specDocuments,
    tasks,
    artifacts,
    agent_runs: agentRuns,
    discussions,
    source: "pz" as const,
  };
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

type CloudDiscussion = {
  id: string;
  parent_node_type: string;
  parent_node_id: string;
  author: string;
  body: string;
  source: "pz" | "pmo";
  deleted_at: string | null;
};

const upsertLocalDiscussion = db.prepare(`
  INSERT INTO discussions (id, project_id, parent_node_type, parent_node_id, author, body, source, deleted_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    parent_node_type = excluded.parent_node_type,
    parent_node_id = excluded.parent_node_id,
    author = excluded.author,
    body = excluded.body,
    source = excluded.source,
    deleted_at = excluded.deleted_at,
    updated_at = excluded.updated_at
`);

function pullCursorKey(localProjectId: string): string {
  return `discussions_pull_cursor:${localProjectId}`;
}

// M12: the *only* pull direction this engine has — see the module header.
// Reuses the existing incremental-pull graph endpoint (built for the desktop
// client's own bootstrap/incremental reads) and only looks at its
// `discussions` field; every other array in the response is ignored, since
// engine remains the source of truth for the rest of the graph.
export async function pullProjectDiscussions(localProjectId: string): Promise<void> {
  const link = getCloudLink(localProjectId);
  if (!link) return;

  const cursor = getAppState(pullCursorKey(localProjectId));
  const path = cursor
    ? `/sync/projects/${link.project_id}/graph?since=${encodeURIComponent(cursor)}`
    : `/sync/projects/${link.project_id}/graph`;

  const res = await cloudFetch<{ discussions: CloudDiscussion[]; cursor: string | null }>(path, {
    method: "GET",
  });

  for (const d of res.discussions) {
    upsertLocalDiscussion.run(
      d.id,
      localProjectId,
      d.parent_node_type,
      d.parent_node_id,
      d.author,
      d.body,
      d.source,
      d.deleted_at,
    );
  }
  if (res.cursor) setAppState(pullCursorKey(localProjectId), res.cursor);
}

let loopTimer: ReturnType<typeof setInterval> | null = null;

export function startCloudSyncLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(async () => {
    for (const projectId of linkedProjectIds()) {
      await pushProjectSnapshot(projectId).catch(() => {});
      await pullProjectDiscussions(projectId).catch(() => {});
    }
  }, CLOUD_SYNC_POLL_SECONDS * 1000);
  loopTimer.unref?.();
}

export function stopCloudSyncLoop(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
}

// --- Still deliberately not built ---------------------------------------
// General pull-and-apply for requirements/specs/tasks/artifacts/agent_runs
// (cloud graph -> local SQLite) remains out of scope: the local `tasks`
// table has no `assignee`/`sprint` columns, so there's nowhere to put the
// pmo fields a pull would bring back from a Jira/ClickUp mirror. M12's
// discussions pull (above) didn't need to solve this — a wholly new local
// table has nothing to reconcile against. This gap is unchanged by M12 and
// stays a follow-up once those columns exist.
