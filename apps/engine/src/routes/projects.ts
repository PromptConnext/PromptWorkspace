import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { db, getAppState } from "../db.ts";
import { connectionForRole, connectionForRoleStrict } from "./models.ts";
import { parseTaskLines, runImplementation, runStage } from "../agent/loop.ts";
import { runAgentTask } from "../agent/agent-runner.ts";
import { resolveAdapter } from "../agent/adapters/index.ts";
import { AgentError } from "../agent/errors.ts";
import { loadActiveWorkspace, loadCloudSession } from "../cloudClient.ts";
import { ensureCloudProject, writeCloudLink } from "../sync/loop.ts";
import { collidingRefs, refsForCommit, taskRefFromFeatureTag } from "../git/taskRefs.ts";

export const projects = new Hono();

type ProjectRow = { id: string; name: string; path: string };

function getProject(id: string): ProjectRow | undefined {
  return db
    .prepare("SELECT id, name, path FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
}

function stageGatePassed(projectId: string, stage: string): boolean {
  const row = db
    .prepare("SELECT gate_passed FROM stage_states WHERE project_id = ? AND stage = ?")
    .get(projectId, stage) as { gate_passed: number } | undefined;
  return row?.gate_passed === 1;
}

function setStage(projectId: string, stage: string, status: string): void {
  db.prepare(
    "UPDATE stage_states SET status = ? WHERE project_id = ? AND stage = ?",
  ).run(status, projectId, stage);
}

// SSE `error` event payload: JSON so the desktop can pull out `kind` (7e) for
// kind-specific UI guidance, alongside the existing plain error message.
function sseErrorPayload(err: unknown): string {
  return JSON.stringify({
    error: (err as Error).message,
    kind: err instanceof AgentError ? err.kind : undefined,
  });
}

projects.get("/engine/projects", (c) => {
  const rows = db
    .prepare("SELECT id, name, path, created_at FROM projects ORDER BY created_at")
    .all() as { id: string; name: string; path: string; created_at: string }[];
  const links = db
    .prepare("SELECT project_id, config FROM integrations WHERE kind = 'cloud'")
    .all() as { project_id: string; config: string | null }[];
  const wsByProject = new Map<string, string>();
  // The cloud project id is recorded per-project in the same link config
  // (writeCloudLink stores { workspace_id, project_id }). Surfacing it lets the
  // desktop match a local project to its roster tab precisely by id rather than
  // by name (plan 0006 G4 — removes the duplicate-name ambiguity G3 flagged).
  const cloudIdByProject = new Map<string, string>();
  for (const l of links) {
    if (!l.config) continue;
    try {
      const cfg = JSON.parse(l.config) as { workspace_id?: string; project_id?: string };
      if (cfg.workspace_id) wsByProject.set(l.project_id, cfg.workspace_id);
      if (cfg.project_id) cloudIdByProject.set(l.project_id, cfg.project_id);
    } catch {
      // ignore malformed link config
    }
  }
  const projectsOut = rows.map((r) => ({
    ...r,
    cloud_workspace_id: wsByProject.get(r.id) ?? null,
    cloud_project_id: cloudIdByProject.get(r.id) ?? null,
  }));
  return c.json({ projects: projectsOut });
});

// Thrown by createLocalProjectShell when the resolved path is already used by
// another project (deterministic name→slug→path collision, or an explicit
// duplicate path). Typed so callers can branch on it instead of matching the
// raw SQLite message.
export class ProjectCollisionError extends Error {
  path: string;
  constructor(path: string) {
    super(`a project already exists at ${path}`);
    this.name = "ProjectCollisionError";
    this.path = path;
  }
}

// Thrown by cloneLocalProjectShell when `git clone` fails (bad url, no
// credentials, network down, etc). Carries stderr so callers/HTTP routes can
// surface an actionable message instead of a raw Error. The partial target
// directory (if git created one) is left in place for inspection — no cleanup.
export class CloneFailedError extends Error {
  stderr: string;
  constructor(stderr: string) {
    super(`git clone failed: ${stderr.trim() || "(no stderr captured)"}`);
    this.name = "CloneFailedError";
    this.stderr = stderr;
  }
}

// Shared tail of project bootstrap: db insert + stage_states + git
// integration row. Used by both createLocalProjectShell (git init) and
// cloneLocalProjectShell (git clone) once the working tree already exists on
// disk. `gitConfig` is stored verbatim as the integration row's config
// (empty/omitted for a plain init, {remote, default_branch} for a clone).
function registerLocalProject(
  name: string,
  resolvedPath: string,
  gitConfig?: { remote: string; default_branch: string },
): ProjectRow {
  const id = randomUUID();
  try {
    db.prepare("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(id, name, resolvedPath);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test((err as Error).message)) {
      throw new ProjectCollisionError(resolvedPath);
    }
    throw err;
  }
  const insertStage = db.prepare(
    "INSERT INTO stage_states (project_id, stage, status) VALUES (?, ?, 'not_started')",
  );
  for (const stage of ["scope", "spec", "skill"]) insertStage.run(id, stage);

  db.prepare(
    "INSERT INTO integrations (id, project_id, kind, required, config) VALUES (?, ?, 'git', 1, ?)",
  ).run(randomUUID(), id, gitConfig ? JSON.stringify(gitConfig) : null);

  return { id, name, path: resolvedPath };
}

// Project bootstrap (gap G3): pick/create a folder, engine git-inits it.
// The business persona never touches Git directly. Exported so the cloud
// roster's bootstrap-pull (routes/cloud.ts) can materialize a local project
// for a cloud project it's about to hydrate.
export function createLocalProjectShell(name: string, path?: string): ProjectRow {
  const slug = name.trim().replace(/[^\w-]+/g, "-").toLowerCase();
  const resolvedPath = path ?? join(homedir(), "PromptWorkspace-Projects", slug);

  const dup = db.prepare("SELECT id FROM projects WHERE path = ?").get(resolvedPath);
  if (dup) throw new ProjectCollisionError(resolvedPath);

  mkdirSync(resolvedPath, { recursive: true });
  if (!existsSync(join(resolvedPath, ".git"))) {
    execFileSync("git", ["init", "-b", "main"], { cwd: resolvedPath, stdio: "pipe" });
  }

  return registerLocalProject(name, resolvedPath);
}

// Directory exists and has at least one entry (dotfiles included) — used to
// reject cloning into a non-empty folder rather than letting `git clone`
// produce its own (less actionable) error.
function isNonEmptyDir(path: string): boolean {
  if (!existsSync(path)) return false;
  return readdirSync(path).length > 0;
}

// repoUrl arrives from the cloud roster — a separate trust boundary from the
// engine (a compromised/malicious cloud project could set an arbitrary
// string). Two concrete exploits this closes: (1) `ext::sh -c <cmd>` — git's
// `ext` transport runs an arbitrary shell command, direct RCE; (2) a value
// starting with `-` gets parsed by git as a flag (e.g. `--upload-pack=<cmd>`).
// Allowlist only the two transports PromptWorkspace actually needs: `https://`
// and the `git@<host>:<path>` SSH shorthand (not restricted to github.com —
// GitHub Enterprise hosts are legitimate). Everything else, including
// `file://` and `ext::`, is rejected before git is ever invoked.
const HTTPS_REPO_URL_RE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d+)?\/\S+$/;
const SSH_SHORTHAND_REPO_URL_RE =
  /^[A-Za-z0-9_.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:\S+$/;

export function assertCloneableRepoUrl(repoUrl: string): void {
  if (typeof repoUrl !== "string" || repoUrl.length === 0 || repoUrl.startsWith("-")) {
    throw new CloneFailedError(`unsupported repository URL: ${JSON.stringify(repoUrl)}`);
  }
  if (HTTPS_REPO_URL_RE.test(repoUrl) || SSH_SHORTHAND_REPO_URL_RE.test(repoUrl)) return;
  throw new CloneFailedError(`unsupported repository URL: ${repoUrl}`);
}

// Clone path for the tech-review-exit repo handoff (plan 0016/phase 6): the
// cloud has already created the GitHub repo and seeded it with AI context, so
// the engine clones instead of git-initing an empty folder. Same slug/path
// resolution and collision semantics as createLocalProjectShell, plus a
// non-empty-directory check since a clone target must be empty (or absent).
export function cloneLocalProjectShell(name: string, repoUrl: string, path?: string): ProjectRow {
  assertCloneableRepoUrl(repoUrl);

  const slug = name.trim().replace(/[^\w-]+/g, "-").toLowerCase();
  const resolvedPath = path ?? join(homedir(), "PromptWorkspace-Projects", slug);

  const dup = db.prepare("SELECT id FROM projects WHERE path = ?").get(resolvedPath);
  if (dup) throw new ProjectCollisionError(resolvedPath);
  if (isNonEmptyDir(resolvedPath)) throw new ProjectCollisionError(resolvedPath);

  try {
    // GIT_TERMINAL_PROMPT=0 is mandatory: without it, a private repo with no
    // saved credentials hangs the HTTP handler forever waiting on a tty that
    // does not exist. GIT_ASKPASS="" disables any configured askpass helper
    // for the same reason. `-c protocol.ext.allow=never` is belt-and-braces
    // against the `ext::` transport even if URL validation is ever bypassed;
    // `--` terminates option parsing so a validated-but-still-dash-prefixed
    // value can never be read as a flag.
    execFileSync(
      "git",
      ["-c", "protocol.ext.allow=never", "clone", "--", repoUrl, resolvedPath],
      {
        stdio: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      },
    );
  } catch (err) {
    const stderr =
      (err as { stderr?: Buffer | string })?.stderr?.toString() ?? (err as Error).message;
    throw new CloneFailedError(stderr);
  }

  let defaultBranch = "main";
  try {
    defaultBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: resolvedPath,
      stdio: "pipe",
    })
      .toString()
      .trim();
  } catch {
    // best-effort; keep the "main" fallback
  }

  return registerLocalProject(name, resolvedPath, { remote: repoUrl, default_branch: defaultBranch });
}

projects.post("/engine/projects", async (c) => {
  const body = await c.req.json<{ name?: string; path?: string; workspaceId?: string }>();
  const name = body.name;
  if (!name) return c.json({ error: "name is required" }, 400);

  // ADR 0015 §5: once a cloud identity is in play, a new project must be born
  // into an active workspace (workspace_id required) rather than the old
  // "unassigned, optionally link later" path. When no cloud session exists
  // (single-player / stub-dev / cloud disabled) the old local-only path stays,
  // so offline-first and local testing are preserved (plan 0006 G2).
  const session = loadCloudSession();
  const workspaceId = session ? body.workspaceId?.trim() || loadActiveWorkspace()?.id : undefined;
  if (session && !workspaceId) {
    return c.json({ error: "an active workspace is required to create a project" }, 400);
  }

  let project: ProjectRow;
  try {
    project = createLocalProjectShell(name, body.path);
  } catch (err) {
    if (err instanceof ProjectCollisionError) {
      return c.json({ error: "A project with that name already exists — choose a different name." }, 409);
    }
    throw err;
  }

  // Bind the project to the workspace immediately, even offline: the link is
  // written now (cloud project pending), and the sync loop mints the cloud
  // project + pushes on reconnect (ensureCloudProject / pushProjectSnapshot).
  if (workspaceId) {
    writeCloudLink(project.id, { workspace_id: workspaceId });
    // Best-effort immediate materialize+push when online; offline this fails
    // silently and stays pending for the next tick (no data loss).
    void ensureCloudProject(project.id).catch(() => {});
  }

  return c.json(project);
});

// Refine-before-approve (business surface): regenerating a stage replaces its
// unapproved draft instead of stacking a new one, so a business user can
// iterate on Scope/Spec until they approve. Approved records are never touched.
function clearSpecChildren(specId: string): void {
  const tasks = db.prepare("SELECT id FROM tasks WHERE spec_id = ?").all(specId) as {
    id: string;
  }[];
  for (const t of tasks) {
    db.prepare("DELETE FROM acceptance_criteria WHERE task_id = ?").run(t.id);
    db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(t.id);
    db.prepare("UPDATE agent_runs SET task_id = NULL WHERE task_id = ?").run(t.id);
  }
  db.prepare("DELETE FROM tasks WHERE spec_id = ?").run(specId);
}

function clearUnapprovedSpecs(requirementId: string): void {
  const specs = db
    .prepare("SELECT id FROM spec_documents WHERE requirement_id = ? AND approved_by IS NULL")
    .all(requirementId) as { id: string }[];
  for (const s of specs) clearSpecChildren(s.id);
  db.prepare(
    "DELETE FROM spec_documents WHERE requirement_id = ? AND approved_by IS NULL",
  ).run(requirementId);
}

function clearUnapprovedScope(projectId: string): void {
  const reqs = db
    .prepare("SELECT id FROM requirements WHERE project_id = ? AND status = 'awaiting_approval'")
    .all(projectId) as { id: string }[];
  for (const r of reqs) {
    clearUnapprovedSpecs(r.id);
    db.prepare("DELETE FROM requirements WHERE id = ?").run(r.id);
  }
}

function withFeedback(base: string, feedback?: string): string {
  if (!feedback?.trim()) return base;
  return `${base}\n\nREVISION REQUESTED by the reviewer — revise accordingly:\n${feedback.trim()}`;
}

// Spec Kit's constitution (project principles) steers specify/plan/tasks. If a
// project has one, prepend it to each stage's input.
function readConstitution(projectPath: string): string {
  try {
    const p = join(projectPath, ".specify/memory/constitution.md");
    if (existsSync(p)) return readFileSync(p, "utf8");
  } catch {
    // absent is fine
  }
  return "";
}

function withConstitution(projectPath: string, input: string): string {
  const con = readConstitution(projectPath);
  return con
    ? `PROJECT CONSTITUTION (principles that govern this project — honor them):\n${con}\n\n${input}`
    : input;
}

// Spec Kit constitution step — project principles, presented under the 3S
// vision as one-time setup (ADR 0009). Uses the lightweight generator, no
// coding agent needed.
projects.post("/engine/projects/:id/constitution", async (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  const { principles } = await c.req
    .json<{ principles?: string }>()
    .catch(() => ({}) as { principles?: string });

  const conn = connectionForRole("plan");
  if (!conn) return c.json({ error: "no verified model connection for role: plan" }, 409);

  const runId = randomUUID();
  db.prepare(
    "INSERT INTO agent_runs (id, project_id, model_connection_id, action, input_ref, status) VALUES (?, ?, ?, 'constitution', ?, 'running')",
  ).run(runId, project.id, conn.id, (principles ?? "").slice(0, 2000));

  return streamSSE(c, async (stream) => {
    try {
      const input = principles?.trim()
        ? principles
        : "Establish sensible default engineering principles for this project.";
      const out = await runStage("constitution", conn, project.path, input, (d) => {
        void stream.writeSSE({ event: "delta", data: d });
      });
      db.prepare("UPDATE agent_runs SET status = 'succeeded', output_ref = ? WHERE id = ?").run(
        out.files[0].path,
        runId,
      );
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ files: out.files.map((f) => f.path), content: out.files[0].content }),
      });
    } catch (err) {
      db.prepare("UPDATE agent_runs SET status = 'failed', evidence = ? WHERE id = ?").run(
        (err as Error).message,
        runId,
      );
      await stream.writeSSE({ event: "error", data: sseErrorPayload(err) });
    }
  });
});

projects.post("/engine/projects/:id/scope", async (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  const { description, feedback } = await c.req.json<{
    description?: string;
    feedback?: string;
  }>();
  if (!description) return c.json({ error: "description is required" }, 400);

  const conn = connectionForRole("plan");
  if (!conn) return c.json({ error: "no verified model connection for role: plan" }, 409);

  const runId = randomUUID();
  db.prepare(
    "INSERT INTO agent_runs (id, project_id, model_connection_id, action, input_ref, status) VALUES (?, ?, ?, 'scope.specify', ?, 'running')",
  ).run(runId, project.id, conn.id, description.slice(0, 2000));
  setStage(project.id, "scope", "running");

  return streamSSE(c, async (stream) => {
    try {
      const out = await runStage(
        "specify",
        conn,
        project.path,
        withConstitution(project.path, withFeedback(description, feedback)),
        (delta) => {
          void stream.writeSSE({ event: "delta", data: delta });
        },
      );
      // Replace the prior unapproved draft only now that generation succeeded,
      // so a failed regenerate never destroys the reviewer's current draft.
      clearUnapprovedScope(project.id);
      const reqId = randomUUID();
      db.prepare(
        "INSERT INTO requirements (id, project_id, title, description, status) VALUES (?, ?, ?, ?, 'awaiting_approval')",
      ).run(reqId, project.id, out.title, description);
      db.prepare(
        "UPDATE agent_runs SET status = 'succeeded', output_ref = ?, evidence = ? WHERE id = ?",
      ).run(out.files[0].path, `files: ${out.files.map((f) => f.path).join(", ")}`, runId);
      setStage(project.id, "scope", "awaiting_approval");
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          requirementId: reqId,
          title: out.title,
          files: out.files.map((f) => f.path),
          content: out.files[0].content,
        }),
      });
    } catch (err) {
      db.prepare("UPDATE agent_runs SET status = 'failed', evidence = ? WHERE id = ?").run(
        (err as Error).message,
        runId,
      );
      setStage(project.id, "scope", "failed");
      await stream.writeSSE({ event: "error", data: sseErrorPayload(err) });
    }
  });
});

projects.post("/engine/projects/:id/spec", async (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  if (!stageGatePassed(project.id, "scope")) {
    return c.json({ error: "scope must be approved before running spec" }, 409);
  }
  const { feedback } = await c.req.json<{ feedback?: string }>().catch(() => ({}) as { feedback?: string });
  const requirement = db
    .prepare(
      "SELECT id, title, description FROM requirements WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(project.id) as { id: string; title: string; description: string } | undefined;
  if (!requirement) return c.json({ error: "no requirement found — run scope first" }, 409);

  const conn = connectionForRole("plan");
  if (!conn) return c.json({ error: "no verified model connection for role: plan" }, 409);

  const runId = randomUUID();
  db.prepare(
    "INSERT INTO agent_runs (id, project_id, model_connection_id, action, input_ref, status) VALUES (?, ?, ?, 'spec.plan', ?, 'running')",
  ).run(runId, project.id, conn.id, requirement.id);
  setStage(project.id, "spec", "running");

  return streamSSE(c, async (stream) => {
    try {
      const specMd = withConstitution(
        project.path,
        withFeedback(
          `Requirement: ${requirement.title}\n\n${requirement.description}\n\nThe approved specification is in specs/001/spec.md of this repository.`,
          feedback,
        ),
      );
      const out = await runStage("plan", conn, project.path, specMd, (delta) => {
        void stream.writeSSE({ event: "delta", data: delta });
      });
      // replace prior unapproved plan only after this one succeeded
      clearUnapprovedSpecs(requirement.id);
      const specId = randomUUID();
      db.prepare(
        "INSERT INTO spec_documents (id, requirement_id, content, version) VALUES (?, ?, ?, 1)",
      ).run(specId, requirement.id, out.files[0].content);
      db.prepare(
        "UPDATE agent_runs SET status = 'succeeded', output_ref = ?, evidence = ? WHERE id = ?",
      ).run(out.files[0].path, `files: ${out.files.map((f) => f.path).join(", ")}`, runId);
      setStage(project.id, "spec", "awaiting_approval");
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          specDocumentId: specId,
          files: out.files.map((f) => f.path),
          content: out.files[0].content,
        }),
      });
    } catch (err) {
      db.prepare("UPDATE agent_runs SET status = 'failed', evidence = ? WHERE id = ?").run(
        (err as Error).message,
        runId,
      );
      setStage(project.id, "spec", "failed");
      await stream.writeSSE({ event: "error", data: sseErrorPayload(err) });
    }
  });
});

// Skill stage, first half (gap G2): break the approved spec into tasks via
// Spec Kit's tasks template. Implementation kick-off comes later.
projects.post("/engine/projects/:id/tasks", async (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  if (!stageGatePassed(project.id, "spec")) {
    return c.json({ error: "spec must be approved before generating tasks" }, 409);
  }
  const spec = db
    .prepare(
      `SELECT sd.id, sd.content, r.title FROM spec_documents sd
       JOIN requirements r ON r.id = sd.requirement_id
       WHERE r.project_id = ? ORDER BY sd.created_at DESC LIMIT 1`,
    )
    .get(project.id) as { id: string; content: string; title: string } | undefined;
  if (!spec) return c.json({ error: "no spec document found — run spec first" }, 409);

  const conn = connectionForRole("plan");
  if (!conn) return c.json({ error: "no verified model connection for role: plan" }, 409);

  const runId = randomUUID();
  db.prepare(
    "INSERT INTO agent_runs (id, project_id, model_connection_id, action, input_ref, status) VALUES (?, ?, ?, 'skill.tasks', ?, 'running')",
  ).run(runId, project.id, conn.id, spec.id);
  setStage(project.id, "skill", "running");

  return streamSSE(c, async (stream) => {
    try {
      const input = withConstitution(
        project.path,
        `Break the approved implementation plan into executable tasks.\n\nRequirement: ${spec.title}\n\nApproved plan:\n\n${spec.content}`,
      );
      const out = await runStage("tasks", conn, project.path, input, (delta) => {
        void stream.writeSSE({ event: "delta", data: delta });
      });
      const parsed = parseTaskLines(out.files[0].content);
      if (parsed.length === 0) {
        throw new Error("tasks document contained no parseable '- [ ] T###' checklist lines");
      }
      db.prepare("DELETE FROM tasks WHERE spec_id = ?").run(spec.id);
      const insert = db.prepare(
        "INSERT INTO tasks (id, spec_id, title, status, feature_tag) VALUES (?, ?, ?, 'todo', ?)",
      );
      for (const task of parsed) {
        insert.run(randomUUID(), spec.id, task.title, task.parallel ? `${task.ref} [P]` : task.ref);
      }
      db.prepare(
        "UPDATE agent_runs SET status = 'succeeded', output_ref = ?, evidence = ? WHERE id = ?",
      ).run(out.files[0].path, `${parsed.length} tasks parsed from ${out.files[0].path}`, runId);
      setStage(project.id, "skill", "tasks_generated");
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          specDocumentId: spec.id,
          taskCount: parsed.length,
          files: out.files.map((f) => f.path),
          content: out.files[0].content,
        }),
      });
    } catch (err) {
      db.prepare("UPDATE agent_runs SET status = 'failed', evidence = ? WHERE id = ?").run(
        (err as Error).message,
        runId,
      );
      setStage(project.id, "skill", "failed");
      await stream.writeSSE({ event: "error", data: sseErrorPayload(err) });
    }
  });
});

// Snapshot the repo for single-shot codegen: full file list plus the contents
// of small text files, capped so tiny skeleton projects fit whole and larger
// ones degrade to listing-only.
function repoSnapshot(projectPath: string): string {
  const listing = execFileSync("git", ["ls-files"], { cwd: projectPath })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const parts: string[] = [`Repository files:\n${listing.join("\n") || "(empty)"}`];
  let budget = 40_000;
  for (const rel of listing) {
    if (budget <= 0) {
      parts.push("(remaining file contents omitted — context budget reached)");
      break;
    }
    try {
      const abs = join(projectPath, rel);
      if (statSync(abs).size > 8_000) continue;
      const content = readFileSync(abs, "utf8");
      budget -= content.length;
      parts.push(`--- ${rel} ---\n${content}`);
    } catch {
      // unreadable/binary — listing entry is enough
    }
  }
  return parts.join("\n\n");
}

projects.post("/engine/tasks/:taskId/run", async (c) => {
  const task = db
    .prepare(
      `SELECT t.id, t.title, t.feature_tag, sd.content AS spec_content,
              r.title AS requirement_title, p.id AS project_id, p.path AS project_path
       FROM tasks t
       JOIN spec_documents sd ON sd.id = t.spec_id
       JOIN requirements r ON r.id = sd.requirement_id
       JOIN projects p ON p.id = r.project_id
       WHERE t.id = ?`,
    )
    .get(c.req.param("taskId")) as
    | {
        id: string;
        title: string;
        feature_tag: string | null;
        spec_content: string;
        requirement_title: string;
        project_id: string;
        project_path: string;
      }
    | undefined;
  if (!task) return c.json({ error: "task not found" }, 404);

  // Implementation runtime (ADR 0009): orchestrate the project's chosen agent
  // CLI; fall back to the one-shot loop when none is available. `loop` forces
  // the fallback.
  const mode = getAppState("implementation_mode") ?? "auto";
  const preferredAgent = getAppState(`implementation_agent.${task.project_id}`);
  const adapter = mode === "loop" ? null : resolveAdapter(preferredAgent);
  const useAgent = adapter !== null;

  // The one-shot loop and façade-routed Claude Code run on the connected BYO
  // model; agents that bring their own account/model (Gemini/Codex/custom) do
  // not need a PromptWorkspace code connection.
  const needsCodeModel = !useAgent || adapter.bringsOwnModel === false;
  const conn = connectionForRoleStrict("code");
  if (needsCodeModel && !conn) {
    return c.json(
      {
        error:
          "no verified coding model — connect one with role 'code' in the Skill stage, or select an agent that uses its own account (Gemini/Codex)",
      },
      409,
    );
  }

  const runId = randomUUID();
  db.prepare(
    "INSERT INTO agent_runs (id, project_id, task_id, model_connection_id, action, input_ref, status) VALUES (?, ?, ?, ?, 'implement', ?, 'running')",
  ).run(runId, task.project_id, task.id, conn?.id ?? null, task.title.slice(0, 2000));
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);

  return streamSSE(c, async (stream) => {
    try {
      const label = `${task.feature_tag ?? "task"} ${task.title}`;
      const onDelta = (delta: string) => {
        void stream.writeSSE({ event: "delta", data: delta });
      };
      const out = useAgent
        ? await runAgentTask(
            task.project_path,
            label,
            [
              `Implement exactly one task in this repository: ${label}`,
              ``,
              `Requirement: ${task.requirement_title}`,
              `The approved specification is at specs/001/spec.md, the implementation plan at specs/001/plan.md, and the full task list at specs/001/tasks.md — read them for context.`,
              `Implement ONLY the task named above, with tests where appropriate. Do not commit; the platform commits for you.`,
            ].join("\n"),
            onDelta,
            preferredAgent,
          ).then((r) => ({ files: r.files.map((path) => ({ path })), commitSha: r.commitSha }))
        : await runImplementation(
            conn!,
            task.project_path,
            label,
            [
              `Requirement: ${task.requirement_title}`,
              ``,
              `Approved implementation plan:`,
              task.spec_content,
              ``,
              repoSnapshot(task.project_path),
              ``,
              `TASK TO IMPLEMENT NOW: ${label}`,
            ].join("\n"),
            onDelta,
          );
      const insertArtifact = db.prepare(
        "INSERT INTO artifacts (id, task_id, kind, uri, commit_sha) VALUES (?, ?, 'code', ?, ?)",
      );
      for (const file of out.files) insertArtifact.run(randomUUID(), task.id, file.path, out.commitSha);
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
      db.prepare(
        "UPDATE agent_runs SET status = 'succeeded', output_ref = ?, evidence = ? WHERE id = ?",
      ).run(
        out.commitSha,
        `commit ${out.commitSha.slice(0, 7)}: ${out.files.map((f) => f.path).join(", ")}`,
        runId,
      );
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          taskId: task.id,
          commitSha: out.commitSha,
          files: out.files.map((f) => f.path),
        }),
      });
    } catch (err) {
      db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(task.id);
      db.prepare("UPDATE agent_runs SET status = 'failed', evidence = ? WHERE id = ?").run(
        (err as Error).message,
        runId,
      );
      await stream.writeSSE({ event: "error", data: sseErrorPayload(err) });
    }
  });
});

projects.post("/engine/projects/:id/stages/:stage/approve", async (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  const stage = c.req.param("stage");
  if (!["scope", "spec", "skill"].includes(stage)) {
    return c.json({ error: `unknown stage: ${stage}` }, 400);
  }
  const { approver } = await c.req.json<{ approver?: string }>().catch(() => ({}) as { approver?: string });
  db.prepare(
    "UPDATE stage_states SET gate_passed = 1, status = 'approved', approver = ? WHERE project_id = ? AND stage = ?",
  ).run(approver ?? "user", project.id, stage);
  if (stage === "scope") {
    db.prepare(
      "UPDATE requirements SET status = 'approved' WHERE project_id = ? AND status = 'awaiting_approval'",
    ).run(project.id);
  }
  if (stage === "spec") {
    db.prepare(
      `UPDATE spec_documents SET approved_by = ? WHERE requirement_id IN
       (SELECT id FROM requirements WHERE project_id = ?) AND approved_by IS NULL`,
    ).run(approver ?? "user", project.id);
  }
  return c.json({ ok: true });
});

// Git truth-keeping (ADR 0007): developers implement in the integrated
// terminal with their own tools; a commit subject naming a task ref
// ("T003: add filter", "T12: add retry") attaches that commit to the task as a
// code artifact. Those artifacts are what `assembleSnapshot` pushes and what
// the cloud's build attribution has to work from, so a commit this misses is a
// build that can never say what is in it.
//
// The grammar is NOT defined here. It is the vendored copy at
// ../git/taskRefs.ts, byte-identical to packages/cloud-client/src/taskRefs.ts and
// held that way by apps/engine/test/task-refs.test.ts, so the engine, the
// extension and the cloud resolve a commit to the same task. Writing a third
// grammar here is what produced the defect plan 0024 M1 closes: /\bT\d{3}\b/
// could not see a project numbering its tasks T12, and the textual
// `feature_tag.split(" ")[0]` lookup could not match "T12" to a stored "T012"
// even once the regex was widened. Both sides normalise numerically instead.
//
// This function does NOT write task status. ADR 0022 put status with the
// client that observed the publication; the engine reads a local log and
// cannot tell a commit that was pushed from one that was not, so it must not
// guess. Attribution only.
function syncTasksFromGit(projectId: string, projectPath: string): void {
  let log: string;
  try {
    log = execFileSync("git", ["log", "--format=%H%x09%s", "-n", "300"], {
      cwd: projectPath,
      stdio: "pipe",
    }).toString();
  } catch {
    return; // empty repo or no git — nothing to sync
  }
  const tasks = db
    .prepare(
      `SELECT t.id, t.feature_tag FROM tasks t
       JOIN spec_documents sd ON sd.id = t.spec_id
       JOIN requirements r ON r.id = sd.requirement_id
       WHERE r.project_id = ? AND t.feature_tag IS NOT NULL`,
    )
    .all(projectId) as { id: string; feature_tag: string }[];
  if (tasks.length === 0) return;

  // A project holding both "T012" and "T12" normalises them to one key. Those
  // refs are dropped entirely rather than resolved to whichever row this query
  // happened to return first — a wrong attribution is worse than a missing one
  // because nobody reviewing a build's task list goes looking for it.
  const blocked = collidingRefs(tasks.map((t) => t.feature_tag));
  const byRef = new Map<string, { id: string }>();
  for (const task of tasks) {
    const ref = taskRefFromFeatureTag(task.feature_tag);
    if (ref === null || blocked.has(ref)) continue;
    byRef.set(ref, task);
  }

  const hasArtifact = db.prepare(
    "SELECT 1 FROM artifacts WHERE task_id = ? AND commit_sha = ? LIMIT 1",
  );
  const insertArtifact = db.prepare(
    "INSERT INTO artifacts (id, task_id, kind, uri, commit_sha) VALUES (?, ?, 'code', ?, ?)",
  );

  for (const line of log.split("\n")) {
    const [sha, subject = ""] = line.split("\t");
    if (!sha) continue;
    // Null branch ref, like both cloud call sites and for the same reason:
    // this walks 300 historic commits in one pass, and there is no per-commit
    // branch to recover after the fact. Attributing all of them to whatever
    // branch happens to be checked out now would be worse than attributing
    // none. Documented in docs/contracts/task-ref-grammar.md.
    for (const ref of refsForCommit(subject, null)) {
      const task = byRef.get(ref);
      if (!task) continue;
      if (!hasArtifact.get(task.id, sha)) {
        insertArtifact.run(randomUUID(), task.id, `git: ${subject.slice(0, 100)}`, sha);
      }
    }
  }
}

// The traceability view's data source (roadmap Phase 1, gap G4): the whole
// local graph in one read.
projects.get("/engine/projects/:id/graph", (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  try {
    syncTasksFromGit(project.id, project.path);
  } catch {
    // sync is best-effort; the graph read must never fail because of it
  }

  const stages = db
    .prepare("SELECT stage, status, gate_passed, approver FROM stage_states WHERE project_id = ?")
    .all(project.id);
  const requirements = (
    db
      .prepare("SELECT id, title, description, status, created_at FROM requirements WHERE project_id = ?")
      .all(project.id) as { id: string }[]
  ).map((req) => ({
    ...req,
    specDocuments: (
      db
        .prepare(
          "SELECT id, version, approved_by, created_at, content FROM spec_documents WHERE requirement_id = ?",
        )
        .all(req.id) as { id: string }[]
    ).map((spec) => ({
      ...spec,
      tasks: (
        db
          .prepare("SELECT id, title, status, feature_tag, assigned_user_id FROM tasks WHERE spec_id = ?")
          .all(spec.id) as { id: string }[]
      ).map((task) => ({
        ...task,
        acceptanceCriteria: db
          .prepare("SELECT id, text FROM acceptance_criteria WHERE task_id = ?")
          .all(task.id),
        artifacts: db
          .prepare("SELECT id, kind, uri, commit_sha FROM artifacts WHERE task_id = ?")
          .all(task.id),
      })),
    })),
  }));
  const agentRuns = db
    .prepare(
      "SELECT id, action, status, input_ref, output_ref, evidence, created_at FROM agent_runs WHERE project_id = ? ORDER BY created_at",
    )
    .all(project.id);

  return c.json({ project, stages, requirements, agentRuns });
});
