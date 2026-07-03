import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { db } from "../db.ts";
import { connectionForRole } from "./models.ts";
import { runStage } from "../agent/loop.ts";

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

  try {
    const out = await runStage("specify", conn, project.path, description);
    const reqId = randomUUID();
    db.prepare(
      "INSERT INTO requirements (id, project_id, title, description, status) VALUES (?, ?, ?, ?, 'awaiting_approval')",
    ).run(reqId, project.id, out.title, description);
    db.prepare(
      "UPDATE agent_runs SET status = 'succeeded', output_ref = ?, evidence = ? WHERE id = ?",
    ).run(out.files[0].path, `files: ${out.files.map((f) => f.path).join(", ")}`, runId);
    setStage(project.id, "scope", "awaiting_approval");
    return c.json({
      requirementId: reqId,
      title: out.title,
      files: out.files.map((f) => f.path),
      content: out.files[0].content,
    });
  } catch (err) {
    db.prepare("UPDATE agent_runs SET status = 'failed', evidence = ? WHERE id = ?").run(
      (err as Error).message,
      runId,
    );
    setStage(project.id, "scope", "failed");
    return c.json({ error: (err as Error).message }, 502);
  }
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

  try {
    const specMd = `Requirement: ${requirement.title}\n\n${requirement.description}\n\nThe approved specification is in specs/001/spec.md of this repository.`;
    const out = await runStage("plan", conn, project.path, specMd);
    const specId = randomUUID();
    db.prepare(
      "INSERT INTO spec_documents (id, requirement_id, content, version) VALUES (?, ?, ?, 1)",
    ).run(specId, requirement.id, out.files[0].content);
    db.prepare(
      "UPDATE agent_runs SET status = 'succeeded', output_ref = ?, evidence = ? WHERE id = ?",
    ).run(out.files[0].path, `files: ${out.files.map((f) => f.path).join(", ")}`, runId);
    setStage(project.id, "spec", "awaiting_approval");
    return c.json({
      specDocumentId: specId,
      files: out.files.map((f) => f.path),
      content: out.files[0].content,
    });
  } catch (err) {
    db.prepare("UPDATE agent_runs SET status = 'failed', evidence = ? WHERE id = ?").run(
      (err as Error).message,
      runId,
    );
    setStage(project.id, "spec", "failed");
    return c.json({ error: (err as Error).message }, 502);
  }
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

// The traceability view's data source (roadmap Phase 1, gap G4): the whole
// local graph in one read.
projects.get("/engine/projects/:id/graph", (c) => {
  const project = getProject(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);

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
