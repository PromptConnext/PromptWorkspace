// Plan 0024 M1 — the engine's first taskRefs test.
//
// Three things are pinned here, in increasing order of how much they matter:
//
//   1. The vendored copy at src/git/taskRefs.ts is byte-for-byte the file at
//      packages/pz-cloud/src/taskRefs.ts. This is the whole cost of vendoring
//      instead of depending, and it is one assertion.
//   2. The grammar answers exactly what docs/contracts/task-ref-cases.json
//      says it answers. That same file is read by
//      packages/pz-cloud/test/taskRefs.test.ts and apps/cloud/tests/
//      test_task_refs.py, so all three implementations are held to one table
//      rather than to three sets of hand-written cases that can drift apart.
//   3. The defect the plan opens with is actually closed: a project numbering
//      its tasks T12 gets a `code` artifact row from a commit naming T12. The
//      grammar unit tests above cannot show that on their own — the old bug
//      was half regex and half a textual feature_tag lookup, and only driving
//      the real route through a real git repository proves both halves are
//      gone.
//
// Run:  node --test apps/engine/test/task-refs.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const VENDORED = join(here, "..", "src", "git", "taskRefs.ts");
const REFERENCE = join(repoRoot, "packages", "pz-cloud", "src", "taskRefs.ts");
const CASES = join(repoRoot, "docs", "contracts", "task-ref-cases.json");

// --------------------------------------------------------------- drift ----

test("the vendored grammar is byte-for-byte the pz-cloud reference", () => {
  const vendored = readFileSync(VENDORED, "utf8");
  const reference = readFileSync(REFERENCE, "utf8");

  // The header is the only thing this file adds, and it is there so nobody
  // edits the copy by accident. Everything after it must be the reference
  // exactly — not "equivalent", not "reformatted", the same bytes.
  assert.ok(
    vendored.startsWith("// VENDORED — DO NOT EDIT."),
    "the vendored copy must announce itself as vendored",
  );
  assert.ok(
    vendored.endsWith(reference),
    "apps/engine/src/git/taskRefs.ts has drifted from packages/pz-cloud/src/taskRefs.ts. " +
      "Re-vendor it verbatim rather than editing the copy — see the header in that file " +
      "and docs/contracts/task-ref-grammar.md.",
  );

  // A header that grew a second copy of the source would still satisfy
  // endsWith, so pin the split point too.
  const header = vendored.slice(0, vendored.length - reference.length);
  assert.ok(
    !header.includes("export function"),
    "the vendored header must contain comments only, never code",
  );
});

// ------------------------------------------------------- shared contract ----

type CaseTable = {
  normalize: { name: string; tag: string | null; expect: string | null }[];
  commits: {
    name: string;
    subject: string;
    branch_name: string | null;
    branch_ref: string | null;
    expect: string[];
    expect_server: string[];
  }[];
  collisions: { name: string; feature_tags: (string | null)[]; blocked: string[] }[];
};

const table = JSON.parse(readFileSync(CASES, "utf8")) as CaseTable;

const { collidingRefs, normalizeTaskRef, refsForCommit, taskRefFromBranch, taskRefFromFeatureTag } =
  await import("../src/git/taskRefs.ts");

test("the shared case table is not silently empty", () => {
  // A suite that reads its cases from a file has one new way to pass while
  // testing nothing: read a file that has no cases in it.
  assert.ok(table.normalize.length > 0);
  assert.ok(table.commits.length > 0);
  assert.ok(table.collisions.length > 0);
});

for (const c of table.normalize) {
  test(`normalize: ${c.name}`, () => {
    assert.equal(taskRefFromFeatureTag(c.tag), c.expect);
    assert.equal(normalizeTaskRef(c.tag), c.expect);
  });
}

for (const c of table.commits) {
  test(`commit: ${c.name}`, () => {
    // The branch name resolves to the ref the table says it does — this is
    // the step the extension performs at its call site before calling
    // refsForCommit, and getting it wrong would hide a branch-pattern bug.
    assert.equal(taskRefFromBranch(c.branch_name), c.branch_ref);

    // An editor-shaped caller: it knows the branch, so it passes the ref.
    assert.deepEqual(refsForCommit(c.subject, c.branch_ref), c.expect);

    // A server-shaped caller passes null. The engine is one of these — see
    // the asymmetry section of docs/contracts/task-ref-grammar.md — so this
    // is the row that describes what syncTasksFromGit will actually do.
    assert.deepEqual(refsForCommit(c.subject, null), c.expect_server);
  });
}

for (const c of table.collisions) {
  test(`collision: ${c.name}`, () => {
    assert.deepEqual([...collidingRefs(c.feature_tags)].sort(), [...c.blocked].sort());
  });
}

// ------------------------------------------------ the T12 demonstration ----
//
// Everything below drives the real `GET /engine/projects/:id/graph` route
// against a real git repository, because that is the only way to show the
// bug is closed end to end.

const dataDir = mkdtempSync(join(tmpdir(), "pz-taskrefs-"));
process.env.HOME = dataDir;
process.env.PROMPTCONNEXT_DATA_DIR = dataDir;
process.env.CLOUD_API_URL = "";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PROMPTCONNEXT_AUTH_TOKEN;

const { Hono } = await import("hono");
const { projects: projectRoutes } = await import("../src/routes/projects.ts");
const { db } = await import("../src/db.ts");

const app = new Hono();
app.route("/", projectRoutes);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

/** A real repository with one commit per subject, oldest first. Returns the
 *  project path and each subject's sha. */
function repoWithCommits(subjects: string[]): { path: string; shas: string[] } {
  const path = mkdtempSync(join(tmpdir(), "pz-repo-"));
  mkdirSync(join(path, "src"), { recursive: true });
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.email", "t@example.test");
  git(path, "config", "user.name", "Test");
  const shas: string[] = [];
  for (const [i, subject] of subjects.entries()) {
    writeFileSync(join(path, "src", `f${i}.txt`), `${i}\n`);
    git(path, "add", "-A");
    git(path, "commit", "-m", subject);
    shas.push(git(path, "rev-parse", "HEAD"));
  }
  return { path, shas };
}

/** A project whose tasks carry the given zero-padded feature tags. */
function projectWithTasks(path: string, tags: string[]): { id: string; taskIds: string[] } {
  const id = `p-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(id, "Rocket", path);
  db.prepare(
    "INSERT INTO requirements (id, project_id, title, status) VALUES (?, ?, ?, 'approved')",
  ).run(`r-${id}`, id, "Uploads");
  db.prepare("INSERT INTO spec_documents (id, requirement_id, content) VALUES (?, ?, ?)").run(
    `s-${id}`,
    `r-${id}`,
    "spec",
  );
  const taskIds = tags.map((tag, i) => {
    const taskId = `t-${id}-${i}`;
    db.prepare(
      "INSERT INTO tasks (id, spec_id, title, status, feature_tag) VALUES (?, ?, ?, 'todo', ?)",
    ).run(taskId, `s-${id}`, `Task ${tag}`, tag);
    return taskId;
  });
  return { id, taskIds };
}

function artifactsFor(taskId: string): { commit_sha: string; kind: string; uri: string }[] {
  return db
    .prepare("SELECT kind, uri, commit_sha FROM artifacts WHERE task_id = ?")
    .all(taskId) as { commit_sha: string; kind: string; uri: string }[];
}

function taskStatus(taskId: string): string {
  return (db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string })
    .status;
}

test("a project numbering its tasks T12 gets its commit attributed", async () => {
  // THE BUG, stated as a fixture. The task is stored zero-padded ("T012"),
  // as the cloud's task generator writes it; the developer typed the natural
  // unpadded form in the subject. Before plan 0024 M1 this produced nothing:
  // /\bT\d{3}\b/ did not match "T12" in the subject, and even once widened,
  // `feature_tag.split(" ")[0]` compared the string "T12" to the string
  // "T012" and failed again. No artifact meant no build attribution, ever.
  const { path, shas } = repoWithCommits(["T12: add a retry to the uploader"]);
  const { id, taskIds } = projectWithTasks(path, ["T012"]);

  const res = await app.request(`/engine/projects/${id}/graph`);
  assert.equal(res.status, 200);

  const rows = artifactsFor(taskIds[0]);
  assert.equal(rows.length, 1, "the T12 commit must be attached to the T012 task");
  assert.equal(rows[0].commit_sha, shas[0]);
  assert.equal(rows[0].kind, "code");
  assert.match(rows[0].uri, /T12: add a retry/);

  // And it reaches the graph payload, which is what assembleSnapshot pushes
  // and what the cloud's freeze_build_tasks has to work from.
  const body = (await res.json()) as {
    requirements: { specDocuments: { tasks: { artifacts: { commit_sha: string }[] }[] }[] }[];
  };
  const viaApi = body.requirements[0].specDocuments[0].tasks[0].artifacts;
  assert.deepEqual(
    viaApi.map((a) => a.commit_sha),
    [shas[0]],
  );
});

test("the three-digit form still attributes, and a re-read does not duplicate", async () => {
  const { path, shas } = repoWithCommits(["T003: add filter"]);
  const { id, taskIds } = projectWithTasks(path, ["T003"]);

  await app.request(`/engine/projects/${id}/graph`);
  await app.request(`/engine/projects/${id}/graph`);

  // syncTasksFromGit re-walks the last 300 commits on every graph read, which
  // is exactly what backfills a project that was numbering outside the old
  // grammar. Its hasArtifact guard is what keeps that idempotent.
  const rows = artifactsFor(taskIds[0]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].commit_sha, shas[0]);
});

test("the engine does not write task status from a local commit", async () => {
  // ADR 0022: status belongs to the client that saw the publication. The
  // engine reads a local log and cannot tell a pushed commit from an
  // unpushed one, so it attributes and stops there. This used to run
  // `UPDATE tasks SET status = 'done'`.
  const { path } = repoWithCommits(["T12: add a retry"]);
  const { id, taskIds } = projectWithTasks(path, ["T012"]);

  await app.request(`/engine/projects/${id}/graph`);

  assert.equal(taskStatus(taskIds[0]), "todo");
  assert.equal(artifactsFor(taskIds[0]).length, 1, "but the artifact is still recorded");
});

test("a revert attributes nothing", async () => {
  const { path, shas } = repoWithCommits([
    "T12: add a retry",
    'Revert "T12: add a retry"',
  ]);
  const { id, taskIds } = projectWithTasks(path, ["T012"]);

  await app.request(`/engine/projects/${id}/graph`);

  const rows = artifactsFor(taskIds[0]);
  assert.deepEqual(
    rows.map((r) => r.commit_sha),
    [shas[0]],
    "the revert must not attach itself to the task it reverts",
  );
});

test("a colliding project attributes neither task", async () => {
  // Both tasks normalise to T12. Guessing one would be an invisible error,
  // so the ref is dropped entirely.
  const { path } = repoWithCommits(["T12: which one?"]);
  const { id, taskIds } = projectWithTasks(path, ["T012", "T12"]);

  await app.request(`/engine/projects/${id}/graph`);

  assert.equal(artifactsFor(taskIds[0]).length, 0);
  assert.equal(artifactsFor(taskIds[1]).length, 0);
});

test("a subject that names no task attributes nothing", async () => {
  const { path } = repoWithCommits(["SPRINT12 rollout is done", "TEST-12 flaked again"]);
  const { id, taskIds } = projectWithTasks(path, ["T012"]);

  await app.request(`/engine/projects/${id}/graph`);

  assert.equal(artifactsFor(taskIds[0]).length, 0);
});
