import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { db, getAppState } from "../db.ts";
import { connectionForRole, connectionForRoleStrict } from "./models.ts";
import { parseTaskLines, runImplementation, runStage } from "../agent/loop.ts";
import { resolveAgentCommand, runAgentTask } from "../agent/agent-runner.ts";

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

projects.get("/engine/projects", (c) => {
  const rows = db
    .prepare("SELECT id, name, path, created_at FROM projects ORDER BY created_at")
    .all();
  return c.json({ projects: rows });
});

// Project bootstrap (gap G3): pick/create a folder, engine git-inits it.
// The business persona never touches Git directly.
projects.post("/engine/projects", async (c) => {
  const body = await c.req.json<{ name?: string; path?: string }>();
  const name = body.name;
  if (!name) return c.json({ error: "name is required" }, 400);
  const slug = name.trim().replace(/[^\w-]+/g, "-").toLowerCase();
  const path = body.path ?? join(homedir(), "PromptZone-Projects", slug);

  mkdirSync(path, { recursive: true });
  if (!existsSync(join(path, ".git"))) {
    execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "pipe" });
  }

  const id = randomUUID();
  db.prepare("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(id, name, path);
  const insertStage = db.prepare(
    "INSERT INTO stage_states (project_id, stage, status) VALUES (?, ?, 'not_started')",
  );
  for (const stage of ["scope", "spec", "skill"]) insertStage.run(id, stage);

  db.prepare(
    "INSERT INTO integrations (id, project_id, kind, required) VALUES (?, ?, 'git', 1)",
  ).run(randomUUID(), id);

  return c.json({ id, name, path });
});

projects.post("/engine/projects/:id/scope", async (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  const { description } = await c.req.json<{ description?: string }>();
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
      const out = await runStage("specify", conn, project.path, description, (delta) => {
        void stream.writeSSE({ event: "delta", data: delta });
      });
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
      await stream.writeSSE({ event: "error", data: (err as Error).message });
    }
  });
});

projects.post("/engine/projects/:id/spec", async (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  if (!stageGatePassed(project.id, "scope")) {
    return c.json({ error: "scope must be approved before running spec" }, 409);
  }
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
      const specMd = `Requirement: ${requirement.title}\n\n${requirement.description}\n\nThe approved specification is in specs/001/spec.md of this repository.`;
      const out = await runStage("plan", conn, project.path, specMd, (delta) => {
        void stream.writeSSE({ event: "delta", data: delta });
      });
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
      await stream.writeSSE({ event: "error", data: (err as Error).message });
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
      const input = `Break the approved implementation plan into executable tasks.\n\nRequirement: ${spec.title}\n\nApproved plan:\n\n${spec.content}`;
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
      await stream.writeSSE({ event: "error", data: (err as Error).message });
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

  const conn = connectionForRoleStrict("code");
  if (!conn) {
    return c.json(
      { error: "no verified coding model — connect one with role 'code' in the Skill stage" },
      409,
    );
  }

  const runId = randomUUID();
  db.prepare(
    "INSERT INTO agent_runs (id, project_id, task_id, model_connection_id, action, input_ref, status) VALUES (?, ?, ?, ?, 'implement', ?, 'running')",
  ).run(runId, task.project_id, task.id, conn.id, task.title.slice(0, 2000));
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);

  // Implementation mode (ADR 0006): "agent" spawns a coding-agent CLI in the
  // workspace via the Anthropic façade; "loop" is the one-shot fallback;
  // "auto" (default) picks agent when one is installed.
  const mode = getAppState("implementation_mode") ?? "auto";
  const useAgent =
    mode === "agent" || (mode === "auto" && resolveAgentCommand() !== null);

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
          ).then((r) => ({ files: r.files.map((path) => ({ path })), commitSha: r.commitSha }))
        : await runImplementation(
            conn,
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
      await stream.writeSSE({ event: "error", data: (err as Error).message });
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
// terminal with their own tools; a commit subject mentioning a task ref
// ("T003: add filter") marks that task done and attaches the commit as an
// artifact. The graph stays honest without anyone updating a tracker.
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
  const byRef = new Map(tasks.map((t) => [t.feature_tag.split(" ")[0], t]));

  const hasArtifact = db.prepare(
    "SELECT 1 FROM artifacts WHERE task_id = ? AND commit_sha = ? LIMIT 1",
  );
  const insertArtifact = db.prepare(
    "INSERT INTO artifacts (id, task_id, kind, uri, commit_sha) VALUES (?, ?, 'code', ?, ?)",
  );
  const markDone = db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?");

  for (const line of log.split("\n")) {
    const [sha, subject = ""] = line.split("\t");
    if (!sha) continue;
    for (const ref of subject.match(/\bT\d{3}\b/g) ?? []) {
      const task = byRef.get(ref);
      if (!task) continue;
      if (!hasArtifact.get(task.id, sha)) {
        insertArtifact.run(randomUUID(), task.id, `git: ${subject.slice(0, 100)}`, sha);
      }
      markDone.run(task.id);
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
          .prepare("SELECT id, title, status, feature_tag FROM tasks WHERE spec_id = ?")
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
