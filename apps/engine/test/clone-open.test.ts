// Phase 6 (plan: cloud creates the project repo at tech-review exit) —
// POST /engine/cloud/projects/:cloudProjectId/open gates on lifecycle_status
// and branches on repo_url: clone when set, `git init` fallback when null.
// Uses a real local bare repo in a tmpdir as the clone source — no network.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type RosterProjectFixture = {
  id: string;
  name: string;
  workspace_id: string;
  lifecycle_status: string;
  repo_url: string | null;
  repo_default_branch: string | null;
};

const cloud = {
  workspaces: [{ id: "ws-1", name: "Acme" }] as { id: string; name: string }[],
  projects: [] as RosterProjectFixture[],
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const graphMatch = url.pathname.match(/^\/sync\/projects\/([^/]+)\/graph$/);

  if (url.pathname === "/workspaces" && req.method === "GET") return send(200, cloud.workspaces);
  if (url.pathname === "/projects" && req.method === "GET") return send(200, cloud.projects);
  if (graphMatch && req.method === "GET") {
    return send(200, {
      requirements: [],
      spec_documents: [],
      tasks: [],
      artifacts: [],
      agent_runs: [],
      discussions: [],
      cursor: null,
      next_id: null,
      has_more: false,
    });
  }
  if (graphMatch && req.method === "PUT") {
    await readBody(req);
    return send(200, { upserted: {}, cursor: null });
  }
  return send(404, { error: "not found" });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

// Env MUST be set before importing the SUT (db.ts + config.ts read it at import).
const dataDir = mkdtempSync(join(tmpdir(), "pz-clone-open-"));
process.env.HOME = dataDir;
process.env.PROMPTCONNEXT_DATA_DIR = dataDir;
process.env.CLOUD_API_URL = `http://127.0.0.1:${port}`;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PROMPTCONNEXT_AUTH_TOKEN;

const { Hono } = await import("hono");
const { cloud: cloudRoutes } = await import("../src/routes/cloud.ts");
const { projects: projectRoutes } = await import("../src/routes/projects.ts");
const { db } = await import("../src/db.ts");

const app = new Hono();
app.route("/", cloudRoutes);
app.route("/", projectRoutes);

const req = (path: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

async function loginStub(userId = "tester"): Promise<void> {
  const res = await req("/engine/cloud/login", { method: "POST", body: JSON.stringify({ userId }) });
  assert.equal(res.status, 200);
  const { loadRosterWorkspaces } = await import("../src/cloudClient.ts");
  for (let i = 0; i < 50 && loadRosterWorkspaces().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A real local bare repo to clone from — no network involved.
function makeBareRepo(): string {
  const workDir = mkdtempSync(join(tmpdir(), "pz-clone-src-work-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir, stdio: "pipe" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed: AGENTS.md"], {
    cwd: workDir,
    stdio: "pipe",
  });

  const bareDir = mkdtempSync(join(tmpdir(), "pz-clone-src-bare-"));
  const barePath = join(bareDir, "repo.git");
  execFileSync("git", ["clone", "--bare", workDir, barePath], { stdio: "pipe" });
  return barePath;
}

// cloneLocalProjectShell's URL validator only allows https:// (and the
// git@host: SSH shorthand) — no file://, since a real cloud-supplied repo_url
// is always one of those two. To still exercise the real `git clone` binary
// end-to-end with zero network, register a per-repo `url.<fake>.insteadOf`
// rewrite in this test's isolated $HOME/.gitconfig: git resolves the rewrite
// locally, before any transport is opened, so a well-formed https:// URL is
// what the engine validates while the actual bytes never leave disk.
function registerLocalHttpsAlias(barePath: string): string {
  const fakeUrl = `https://pz-test.local/acme/repo-${randomUUID()}.git`;
  const gitConfigPath = join(dataDir, ".gitconfig");
  appendFileSync(
    gitConfigPath,
    `[url "file://${barePath}/"]\n\tinsteadOf = ${fakeUrl}\n`,
  );
  return fakeUrl;
}

await loginStub();

test("open on a pre-repo imported project returns 409 even when repo_url is set", async () => {
  cloud.projects.push({
    id: "cp-tr",
    name: "Imported Planning Project",
    workspace_id: "ws-1",
    lifecycle_status: "planning",
    // Imports retain their existing repository while planning. The engine must
    // not clone it before cloud-side repo creation has seeded the AI context.
    repo_url: "https://github.com/acme/imported-planning-project",
    repo_default_branch: "main",
  });
  await req("/engine/cloud/roster/refresh", { method: "POST" });

  const res = await req("/engine/cloud/projects/cp-tr/open", { method: "POST" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; lifecycle_status: string };
  assert.equal(body.error, "project_not_ready");
  assert.equal(body.lifecycle_status, "planning");
});

test("open on repo_created with a repo_url clones the real repo (local bare repo, no network)", async () => {
  const barePath = makeBareRepo();
  const repoUrl = registerLocalHttpsAlias(barePath);
  cloud.projects.push({
    id: "cp-clone",
    name: "Clone Project",
    workspace_id: "ws-1",
    lifecycle_status: "repo_created",
    repo_url: repoUrl,
    repo_default_branch: "main",
  });
  await req("/engine/cloud/roster/refresh", { method: "POST" });

  const res = await req("/engine/cloud/projects/cp-clone/open", { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { localProjectId: string; hydrated: boolean };

  const row = db.prepare("SELECT id, name, path FROM projects WHERE id = ?").get(body.localProjectId) as
    | { id: string; name: string; path: string }
    | undefined;
  assert.ok(row, "project row exists");
  assert.ok(existsSync(join(row!.path, ".git")), ".git present in the cloned working tree");

  const integ = db
    .prepare("SELECT config FROM integrations WHERE project_id = ? AND kind = 'git'")
    .get(body.localProjectId) as { config: string } | undefined;
  assert.ok(integ?.config, "git integration row has a config");
  const cfg = JSON.parse(integ!.config) as { remote: string; default_branch: string };
  assert.equal(cfg.remote, repoUrl);
  assert.ok(cfg.default_branch, "default_branch recorded");
});

test("repo_created with null repo_url falls back to git init", async () => {
  cloud.projects.push({
    id: "cp-init",
    name: "Init Fallback Project",
    workspace_id: "ws-1",
    lifecycle_status: "repo_created",
    repo_url: null,
    repo_default_branch: null,
  });
  await req("/engine/cloud/roster/refresh", { method: "POST" });

  const res = await req("/engine/cloud/projects/cp-init/open", { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { localProjectId: string };

  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(body.localProjectId) as {
    path: string;
  };
  assert.ok(existsSync(join(row.path, ".git")), ".git present from a plain init");

  const integ = db
    .prepare("SELECT config FROM integrations WHERE project_id = ? AND kind = 'git'")
    .get(body.localProjectId) as { config: string | null } | undefined;
  assert.equal(integ?.config, null, "no remote config for a plain init");
});

test("clone into an existing non-empty directory returns 409", async () => {
  const barePath = makeBareRepo();
  const repoUrl = registerLocalHttpsAlias(barePath);
  const targetPath = mkdtempSync(join(tmpdir(), "pz-clone-target-"));
  // Make the target directory non-empty.
  mkdirSync(join(targetPath, "some-existing-file-holder"));

  cloud.projects.push({
    id: "cp-collide-clone",
    name: "Collide Clone Project",
    workspace_id: "ws-1",
    lifecycle_status: "repo_created",
    repo_url: repoUrl,
    repo_default_branch: "main",
  });
  await req("/engine/cloud/roster/refresh", { method: "POST" });

  const res = await req("/engine/cloud/projects/cp-collide-clone/open", {
    method: "POST",
    body: JSON.stringify({ path: targetPath }),
  });
  assert.equal(res.status, 409);
});

test.after(() => {
  server.close();
});
