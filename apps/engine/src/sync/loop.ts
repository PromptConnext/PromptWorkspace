// D2 (docs/plans/0004): push the linked project's local graph to apps/cloud
// on an interval + on demand. Pull-back (apps/cloud -> local SQLite) was
// deliberately out of scope for that cut (see the note at the bottom) — M12
// adds it, narrowly, for discussions only: comments authored in the web app
// need to reach desktop, and unlike tasks/requirements/etc. there's no local
// column-shape conflict to resolve first (a wholly new local table, nothing
// to reconcile against). Every other entity stays push-only, unchanged.
import { randomUUID } from "node:crypto";
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

// project_id is optional: a project created offline into a workspace is linked
// (workspace_id known) but has no cloud project row yet — it stays pending until
// ensureCloudProject() mints one on reconnect (ADR 0015 §5, plan 0006 G2).
export type CloudLinkConfig = { workspace_id: string; project_id?: string | null };

export function getCloudLink(projectId: string): CloudLinkConfig | null {
  const row = db
    .prepare("SELECT config FROM integrations WHERE project_id = ? AND kind = 'cloud'")
    .get(projectId) as { config: string | null } | undefined;
  return row?.config ? (JSON.parse(row.config) as CloudLinkConfig) : null;
}

// Upsert the per-project cloud link row (kind='cloud' in `integrations`). Used
// by the cloud-link route and by workspace-scoped project creation.
export function writeCloudLink(localProjectId: string, config: CloudLinkConfig): void {
  const existing = db
    .prepare("SELECT id FROM integrations WHERE project_id = ? AND kind = 'cloud'")
    .get(localProjectId) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE integrations SET config = ? WHERE id = ?").run(
      JSON.stringify(config),
      existing.id,
    );
  } else {
    db.prepare(
      "INSERT INTO integrations (id, project_id, kind, config, required) VALUES (?, ?, 'cloud', ?, 0)",
    ).run(randomUUID(), localProjectId, JSON.stringify(config));
  }
}

// Resolve a pending link into a real cloud project. A project born into a
// workspace while offline has a link with no project_id; on reconnect this
// creates the cloud project (POST /projects, membership-gated server-side) and
// fills in the returned id. Requires the network — throws when offline, leaving
// the link pending so the next sync tick retries (plan 0006 G2 test 5).
export async function ensureCloudProject(localProjectId: string): Promise<string | null> {
  const link = getCloudLink(localProjectId);
  if (!link) return null;
  if (link.project_id) return link.project_id;
  const project = db
    .prepare("SELECT name FROM projects WHERE id = ?")
    .get(localProjectId) as { name: string } | undefined;
  if (!project) return null;
  const created = await cloudFetch<{ id: string }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name: project.name, workspace_id: link.workspace_id }),
  });
  writeCloudLink(localProjectId, { workspace_id: link.workspace_id, project_id: created.id });
  return created.id;
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
    // assignee/sprint are pmo-owned and not stored locally; assigned_user_id
    // IS stored locally (ADR 0016) but is pz-owned and app-authored via the
    // dedicated assignment endpoint — omit all three rather than push null,
    // so this push can't clobber a tracker mirror or an app-set assignment.
    // pullProjectTaskAssignments (below) is the sole writer of the local column.
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
  // Entity id -> field names the cloud's ownership/LWW gate silently dropped
  // on this push (WP2). Populated straight from the cloud response so a
  // teammate's overwritten edits surface instead of vanishing unnoticed.
  conflicts?: Record<string, string[]>;
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
  let link = getCloudLink(localProjectId);
  if (!link) {
    const result: SyncResult = { at: new Date().toISOString(), ok: false, error: "not linked" };
    recordResult(localProjectId, result);
    return result;
  }
  // A project born into a workspace while offline is linked but has no cloud
  // project yet — mint it on reconnect before pushing. If still offline this
  // throws and the push is recorded as failed (pending), flushing next tick.
  if (!link.project_id) {
    try {
      await ensureCloudProject(localProjectId);
      link = getCloudLink(localProjectId);
    } catch (err) {
      const result: SyncResult = {
        at: new Date().toISOString(),
        ok: false,
        error: (err as Error).message,
      };
      recordResult(localProjectId, result);
      return result;
    }
    if (!link?.project_id) {
      const result: SyncResult = {
        at: new Date().toISOString(),
        ok: false,
        error: "pending workspace link (no cloud project yet)",
      };
      recordResult(localProjectId, result);
      return result;
    }
  }
  try {
    const snapshot = assembleSnapshot(localProjectId, link.project_id);
    const res = await cloudFetch<{
      upserted: Record<string, number>;
      conflicts?: Record<string, string[]>;
    }>(`/sync/projects/${link.project_id}/graph`, {
      method: "PUT",
      body: JSON.stringify(snapshot),
    });
    const result: SyncResult = {
      at: new Date().toISOString(),
      ok: true,
      upserted: res.upserted,
      conflicts: res.conflicts,
    };
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
  if (!link?.project_id) return; // unlinked or pending (no cloud project yet)

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

const updateLocalTaskAssignee = db.prepare("UPDATE tasks SET assigned_user_id = ? WHERE id = ?");

function assignmentsPullCursorKey(localProjectId: string): string {
  return `assignments_pull_cursor:${localProjectId}`;
}

// Ongoing pull of the one pz-owned field the app writes and the engine never
// pushes (ADR 0016 §5). Reuses the incremental graph endpoint; reads only
// tasks[].assigned_user_id, ignoring every other array (engine stays the
// source of truth for the rest). Narrow, single-field mirror — NOT the general
// pull-and-apply still deferred at the bottom of this file.
export async function pullProjectTaskAssignments(localProjectId: string): Promise<void> {
  const link = getCloudLink(localProjectId);
  if (!link?.project_id) return;
  const cursor = getAppState(assignmentsPullCursorKey(localProjectId));
  const path = cursor
    ? `/sync/projects/${link.project_id}/graph?since=${encodeURIComponent(cursor)}`
    : `/sync/projects/${link.project_id}/graph`;
  const res = await cloudFetch<{
    tasks: { id: string; assigned_user_id: string | null }[];
    cursor: string | null;
  }>(path, { method: "GET" });
  for (const t of res.tasks) {
    // Only updates a row that already exists locally; a task the engine has
    // never seen is created by the normal generate path / hydrate, not here.
    updateLocalTaskAssignee.run(t.assigned_user_id ?? null, t.id);
  }
  if (res.cursor) setAppState(assignmentsPullCursorKey(localProjectId), res.cursor);
}

let loopTimer: ReturnType<typeof setInterval> | null = null;

export function startCloudSyncLoop(): void {
  if (loopTimer) return;
  loopTimer = setInterval(async () => {
    for (const projectId of linkedProjectIds()) {
      await pushProjectSnapshot(projectId).catch(() => {});
      await pullProjectDiscussions(projectId).catch(() => {});
      await pullProjectTaskAssignments(projectId).catch(() => {});
    }
  }, CLOUD_SYNC_POLL_SECONDS * 1000);
  loopTimer.unref?.();
}

export function stopCloudSyncLoop(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
}

// --- Full-graph bootstrap-pull (ADR 0015 §2, plan 0006 G2) ----------------
// Hydrate a cloud project that has NO local graph yet (a new device, or a
// project a teammate created). Unlike a general incremental pull-and-apply
// (still not built — see the note at the bottom), a bootstrap is a one-shot
// replica of the cloud's *already-merged* state into empty local tables: the
// client re-runs no merge, and pmo-only fields (assignee/sprint) simply have
// no local column and are dropped, exactly as the push omits them.

// Cloud status vocabularies are coarser than local; reverse the push maps so a
// hydrated graph reads back in the local vocabulary the rest of the engine
// expects. Unknown values fall back to the local default.
const TASK_STATUS_FROM_CLOUD: Record<string, string> = {
  todo: "todo",
  in_progress: "running",
  implemented: "done",
  verified: "done",
};

const REQUIREMENT_STATUS_FROM_CLOUD: Record<string, string> = {
  draft: "draft",
  approved: "approved",
};

type CloudGraphPage = {
  requirements: { id: string; title: string; description: string; status: string }[];
  spec_documents: {
    id: string;
    requirement_id: string;
    content: string;
    version: number;
    approved_by: string | null;
  }[];
  tasks: {
    id: string;
    spec_id: string | null;
    title: string;
    status: string;
    feature_tag: string | null;
    acceptance_criteria: { text: string }[];
    assigned_user_id: string | null;
  }[];
  artifacts: { id: string; task_id: string; kind: string; uri: string; commit_sha: string | null }[];
  agent_runs: {
    id: string;
    task_id: string;
    action: string;
    status: string;
    evidence: Record<string, unknown> | null;
  }[];
  discussions: CloudDiscussion[];
  cursor: string | null;
  next_id: string | null;
  has_more: boolean;
};

const upsertRequirement = db.prepare(`
  INSERT INTO requirements (id, project_id, title, description, status)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title, description = excluded.description, status = excluded.status
`);
const upsertSpecDocument = db.prepare(`
  INSERT INTO spec_documents (id, requirement_id, content, version, approved_by)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    content = excluded.content, version = excluded.version, approved_by = excluded.approved_by
`);
const upsertTask = db.prepare(`
  INSERT INTO tasks (id, spec_id, title, status, feature_tag, assigned_user_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    spec_id = excluded.spec_id, title = excluded.title,
    status = excluded.status, feature_tag = excluded.feature_tag,
    assigned_user_id = excluded.assigned_user_id
`);
const deleteCriteriaForTask = db.prepare("DELETE FROM acceptance_criteria WHERE task_id = ?");
const insertCriterion = db.prepare(
  "INSERT INTO acceptance_criteria (id, task_id, text) VALUES (?, ?, ?)",
);
const upsertArtifact = db.prepare(`
  INSERT INTO artifacts (id, task_id, kind, uri, commit_sha)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    task_id = excluded.task_id, kind = excluded.kind,
    uri = excluded.uri, commit_sha = excluded.commit_sha
`);
const upsertAgentRun = db.prepare(`
  INSERT INTO agent_runs (id, project_id, task_id, action, status, evidence)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    task_id = excluded.task_id, action = excluded.action,
    status = excluded.status, evidence = excluded.evidence
`);

// Apply one drained page of the cloud graph into local SQLite (dumb replica).
// Cloud entity ids ARE the local ids (the push uses local ids as cloud ids),
// so a bootstrap on a fresh device reconstructs the same id space.
function applyGraphPage(localProjectId: string, page: CloudGraphPage): void {
  for (const r of page.requirements) {
    upsertRequirement.run(
      r.id,
      localProjectId,
      r.title,
      r.description ?? "",
      REQUIREMENT_STATUS_FROM_CLOUD[r.status] ?? "draft",
    );
  }
  for (const sd of page.spec_documents) {
    upsertSpecDocument.run(sd.id, sd.requirement_id, sd.content ?? "", sd.version ?? 1, sd.approved_by);
  }
  for (const t of page.tasks) {
    if (!t.spec_id) continue; // a task with no spec has no local parent to attach to
    upsertTask.run(
      t.id,
      t.spec_id,
      t.title,
      TASK_STATUS_FROM_CLOUD[t.status] ?? "todo",
      t.feature_tag,
      t.assigned_user_id ?? null,
    );
    // acceptance_criteria are embedded (not separately keyed) in the cloud
    // shape — replace the local set wholesale, minting fresh local ids.
    deleteCriteriaForTask.run(t.id);
    for (const c of t.acceptance_criteria ?? []) {
      insertCriterion.run(randomUUID(), t.id, c.text);
    }
  }
  for (const a of page.artifacts) {
    upsertArtifact.run(a.id, a.task_id, a.kind, a.uri, a.commit_sha);
  }
  for (const ar of page.agent_runs) {
    // local `evidence` is free text; cloud's is a dict — reverse the push's
    // {note: ...} wrapping, else serialize whatever shape came back.
    const note =
      ar.evidence && typeof ar.evidence.note === "string"
        ? ar.evidence.note
        : ar.evidence && Object.keys(ar.evidence).length
          ? JSON.stringify(ar.evidence)
          : null;
    upsertAgentRun.run(ar.id, localProjectId, ar.task_id, ar.action, ar.status, note);
  }
  for (const d of page.discussions) {
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
}

export type HydrateResult = { pages: number; counts: Record<string, number> };

// Drain the bootstrap graph (no `since` = tombstones hidden) page by page via
// keyset pagination (limit + after_ts + after_id), exactly like plan 0004 D2's
// incremental drain, applying each page before fetching the next. Never assume
// a single response — a multi-page graph must be fully drained.
const HYDRATE_PAGE_LIMIT = 500;

export async function hydrateProjectGraph(
  localProjectId: string,
  cloudProjectId: string,
): Promise<HydrateResult> {
  const counts: Record<string, number> = {
    requirements: 0,
    spec_documents: 0,
    tasks: 0,
    artifacts: 0,
    agent_runs: 0,
    discussions: 0,
  };
  let afterTs: string | null = null;
  let afterId: string | null = null;
  let pages = 0;

  // Bound the loop defensively so a server that never clears has_more can't
  // spin forever; 10k pages * 500 rows is far beyond any real desktop project.
  for (let guard = 0; guard < 10_000; guard++) {
    const params = new URLSearchParams({ limit: String(HYDRATE_PAGE_LIMIT) });
    if (afterTs) params.set("after_ts", afterTs);
    if (afterId) params.set("after_id", afterId);
    const page = await cloudFetch<CloudGraphPage>(
      `/sync/projects/${cloudProjectId}/graph?${params.toString()}`,
      { method: "GET" },
    );
    applyGraphPage(localProjectId, page);
    pages++;
    for (const key of Object.keys(counts)) {
      counts[key] += (page[key as keyof CloudGraphPage] as unknown[] | undefined)?.length ?? 0;
    }
    if (!page.has_more || !page.next_id || !page.cursor) break;
    afterTs = page.cursor;
    afterId = page.next_id;
  }

  return { pages, counts };
}

// --- Still deliberately not built ---------------------------------------
// General *incremental* pull-and-apply (cloud graph -> local SQLite on an
// ongoing basis, honoring `since` and tombstones for requirements/specs/
// tasks/artifacts/agent_runs) remains out of scope: the local `tasks` table
// still has no `assignee`/`sprint` columns, so there's nowhere to put the pmo
// fields a live pull would bring back from a Jira/ClickUp mirror. The one
// exception is `assigned_user_id` (ADR 0016): that pz-owned column now exists
// locally and is kept live by pullProjectTaskAssignments above, the same
// narrow-mirror shape M12's discussions pull established. The bootstrap
// hydrate above is still a one-shot replica into empty tables, not an ongoing
// reconciliation for the rest of the graph. General ongoing pull for
// everything else stays a follow-up once the pmo columns exist.
