// Run:  node --test apps/mcp/test/tools.test.ts
//
// Same strategy as packages/cloud-client's suite and apps/engine's: no mocking
// library, a real http.createServer on port 0 standing in for the cloud, and the
// code under test genuinely making requests. The tools are driven through the
// SDK's own in-memory transport rather than called directly, so what is asserted
// is what a client would actually receive.
//
// `get_project_rules` extends that to the disk: the clones below are real git
// repositories in a temp directory with real remotes, because the thing most
// likely to be wrong is the remote parsing and the URL matching, and a stubbed
// `git remote -v` would test neither. `close_task` extends it again — its
// artifact comes from a real `HEAD`, and its queue from a real file that a
// second server instance reads back.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CloudClient,
  PRODUCTION_DEFAULTS,
  SessionStore,
  type AssignedTask,
  type LoggerLike,
  type QueueEntry,
  type SecretsLike,
  type StorageLike,
} from "@promptworkspace/cloud-client";
import { createStatusQueue } from "../src/cloud.ts";
import { readConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { StatusWriter } from "../src/statusWriter.ts";

const silent: LoggerLike = { info: () => {}, warn: () => {}, error: () => {} };

function memorySecrets(): SecretsLike {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async store(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function memoryState(): StorageLike {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async update(key, value) {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
}

const TASK: AssignedTask = {
  task: {
    id: "task-1",
    project_id: "proj-1",
    spec_id: "spec-1",
    title: "Add a retry to the uploader",
    status: "in_progress",
    feature_tag: "T012",
    acceptance_criteria: [{ text: "Retries three times" }, { text: "Backs off" }],
  },
  project_id: "proj-1",
  project_name: "Uploader",
  workspace_id: "ws-1",
  workspace_name: "Acme",
  repo_url: "https://github.com/acme/uploader",
};

const REPO_URL = "https://github.com/acme/uploader";

const PROJECT = {
  id: "proj-1",
  name: "Uploader",
  workspace_id: "ws-1",
  repo_url: REPO_URL,
  repo_default_branch: "main",
  lifecycle_status: "repo_created",
};

interface Recorded {
  path: string;
  method: string;
  body?: Record<string, unknown>;
}

interface Harness {
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  listToolNames: () => Promise<string[]>;
  seen: Recorded[];
  /** The queue as it is on disk, which is the only copy that survives this
   *  process. */
  queued: () => QueueEntry[];
  queueDir: string;
}

interface HarnessOptions {
  /** Extra projects in the same workspace — a fork or a monorepo sharing a
   *  remote with `PROJECT`. */
  extraProjects?: unknown[];
  /** How the fake cloud answers `PATCH …/status`. A function so a test can
   *  change its mind between calls. Default: accept. */
  statusReply?: () => { code: number; detail?: string };
  /** Share one queue file between two harnesses, standing in for two runs of
   *  the server against the same config directory. */
  queueDir?: string;
}

function readQueueFile(dir: string): QueueEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as {
      entries?: QueueEntry[];
    };
    return parsed.entries ?? [];
  } catch {
    // No file at all is the same answer as an empty one: nothing is queued.
    return [];
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  clones.push(dir);
  return dir;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function withTools(
  fn: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const seen: Recorded[] = [];
  const http: HttpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    const method = req.method ?? "GET";
    res.setHeader("content-type", "application/json");
    if (method === "PATCH" && /^\/projects\/[^/]+\/tasks\/[^/]+\/status$/.test(path)) {
      void readBody(req).then((body) => {
        seen.push({ path, method, body });
        const reply = options.statusReply?.() ?? { code: 200 };
        res.statusCode = reply.code;
        if (reply.code >= 400) {
          res.end(JSON.stringify({ detail: reply.detail ?? "refused" }));
        } else {
          res.end(JSON.stringify({ ...TASK.task, status: (body?.status as string) ?? "todo" }));
        }
      });
      return;
    }
    seen.push({ path, method });
    if (path.startsWith("/me/tasks")) {
      res.end(JSON.stringify([TASK]));
    } else if (path.startsWith("/workspaces/ws-1/projects")) {
      res.end(JSON.stringify([PROJECT, ...(options.extraProjects ?? [])]));
    } else if (path.startsWith("/workspaces")) {
      res.end(JSON.stringify([{ id: "ws-1", name: "Acme" }]));
    } else if (path.startsWith("/sync/projects/proj-1/graph")) {
      res.end(
        JSON.stringify({
          tasks: [],
          spec_documents: [
            { id: "spec-1", project_id: "proj-1", requirement_id: "r1", content: "Upload spec body.", version: 1 },
          ],
        }),
      );
    } else if (path.startsWith("/projects/proj-1/stage-documents/constitution")) {
      res.end(JSON.stringify({ id: "c1", stage: "constitution", content: "Prefer small diffs.", updated_at: null }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "not found" }));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const session = new SessionStore(memorySecrets(), memoryState());
  await session.store({ mode: "stub", userId: "dev-user" });
  const client = new CloudClient({
    session,
    config: () => ({
      apiUrl: `http://127.0.0.1:${port}`,
      supabaseUrl: "",
      supabaseAnonKey: "",
    }),
    fetch: (input, init) => fetch(input, init),
    log: silent,
  });

  const queueDir = options.queueDir ?? tempDir("pz-mcp-queue-");
  const writer = new StatusWriter(client, createStatusQueue(queueDir), silent);
  const server = createServer(client, silent, writer);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  try {
    await fn({
      call: async (name, args) =>
        (await mcp.callTool({ name, arguments: args })) as CallToolResult,
      listToolNames: async () => (await mcp.listTools()).tools.map((t) => t.name),
      seen,
      queued: () => readQueueFile(queueDir),
      queueDir,
    });
  } finally {
    await mcp.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

/** A real git repository, with the seeded files the test asks for. */
function makeClone(files: Record<string, string>, remote: string | null = REPO_URL): string {
  const root = mkdtempSync(join(tmpdir(), "pz-mcp-clone-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root, stdio: "pipe" });
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  clones.push(root);
  return root;
}

/** Commit everything in a clone, and hand back the sha `HEAD` now points at.
 *  `-c` rather than a written config, so a machine with no `user.email` (CI)
 *  behaves like one that has. */
function commitAll(root: string, subject: string): string {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", subject],
    { cwd: root, stdio: "pipe" },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: "pipe" })
    .toString()
    .trim();
}

function bodyOf(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

function statusWrites(seen: Recorded[]): Recorded[] {
  return seen.filter((s) => s.method === "PATCH");
}

const clones: string[] = [];

after(() => {
  for (const root of clones) rmSync(root, { recursive: true, force: true });
});

test("the server advertises exactly the four tools of plan 0025", async () => {
  await withTools(async ({ listToolNames }) => {
    // A fifth name appearing here means a tool was invented outside plan 0025
    // §1 — most likely a claim or assignment tool, for which /me/tasks gives no
    // caller, or something that writes the graph.
    assert.deepEqual(await listToolNames(), [
      "list_my_tasks",
      "get_task",
      "get_project_rules",
      "close_task",
    ]);
  });
});

test("list_my_tasks names the id an assistant needs for get_task", async () => {
  await withTools(async ({ call }) => {
    const result = await call("list_my_tasks", {});
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /T012: Add a retry to the uploader/);
    assert.match(body, /id: task-1/);
    assert.match(body, /project: Uploader \(Acme\)/);
  });
});

test("list_my_tasks passes its filters through as query parameters", async () => {
  await withTools(async ({ call, seen }) => {
    await call("list_my_tasks", { workspace_id: "ws-1", status: ["todo", "verified"] });
    const request = seen.find((s) => s.path.startsWith("/me/tasks"));
    assert.ok(request);
    assert.match(request.path, /workspace_id=ws-1/);
    assert.match(request.path, /status=todo/);
    assert.match(request.path, /status=verified/);
  });
});

test("an unknown status is refused rather than silently dropped", async () => {
  await withTools(async ({ call }) => {
    const result = await call("list_my_tasks", { status: ["done"] });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /must be one of/);
  });
});

test("get_task assembles criteria, spec excerpt and repository", async () => {
  await withTools(async ({ call }) => {
    const result = await call("get_task", { task_id: "task-1" });
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /# Task T012: Add a retry to the uploader/);
    assert.match(body, /- \[ \] Retries three times/);
    assert.match(body, /## Specification/);
    assert.match(body, /Upload spec body\./);
    assert.match(body, /- Repository: https:\/\/github\.com\/acme\/uploader/);
    assert.match(body, /## Project coding rules/);
    assert.match(body, /Prefer small diffs\./);
  });
});

test("get_task asks for every status, so an implemented task is still readable", async () => {
  await withTools(async ({ call, seen }) => {
    await call("get_task", { task_id: "task-1" });
    const request = seen.find((s) => s.path.startsWith("/me/tasks"));
    assert.ok(request);
    for (const status of ["todo", "in_progress", "implemented", "verified"]) {
      assert.match(request.path, new RegExp(`status=${status}`));
    }
  });
});

test("a task that is not assigned to the caller is a tool error, not a throw", async () => {
  await withTools(async ({ call }) => {
    const result = await call("get_task", { task_id: "nope" });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /No task nope is assigned to you/);
  });
});

test("get_project_rules resolves the project from the clone's git remote", async () => {
  // An SSH shorthand against the cloud's https repo_url, which is the shape a
  // real developer's remote actually has — string equality would miss it.
  const root = makeClone(
    {
      "AGENTS.md": "Always write a test.",
      "docs/conventions.md": "Prose-forward docs.",
      ".specify/memory/constitution.md": "Prefer small diffs.",
    },
    "git@github.com:acme/uploader.git",
  );
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root });
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /# Coding rules for Uploader \(Acme\)/);
    assert.match(body, /- Project id: proj-1/);
    assert.match(body, new RegExp(`- Workspace root: ${root}`));
    assert.match(body, /## AGENTS\.md \(`AGENTS\.md`\)/);
    assert.match(body, /Always write a test\./);
    assert.match(body, /## Conventions \(`docs\/conventions\.md`\)/);
    assert.match(body, /Prose-forward docs\./);
    assert.match(body, /## Constitution \(`\.specify\/memory\/constitution\.md`\)/);
  });
});

test("a seeded file that is missing is stated as missing, not omitted", async () => {
  const root = makeClone({ "AGENTS.md": "Always write a test." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    // The heading is present for all three regardless — "this project has no
    // conventions doc" is an answer, and silence is one an agent fills in by
    // guessing.
    assert.match(body, /## Conventions \(`docs\/conventions\.md`\)\n\n_Not present in this clone\._/);
    assert.match(body, /Always write a test\./);
  });
});

test("a constitution matching the cloud's stage document is reported as unchanged", async () => {
  // Reflowed, not rewritten: the comparison is whitespace-normalised, because
  // reporting a reflow as drift trains the developer to ignore the notice.
  const root = makeClone({ ".specify/memory/constitution.md": "Prefer   small\n  diffs." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    assert.match(body, /unchanged from the cloud's constitution stage document/);
  });
});

test("a constitution that has moved on from the cloud's is flagged as diverged", async () => {
  const root = makeClone({ ".specify/memory/constitution.md": "Ship large rewrites." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    assert.match(body, /diverged from the cloud's constitution stage document/);
    // The file is the authority, so it — not the cloud copy — is what is shown.
    assert.match(body, /Ship large rewrites\./);
    assert.doesNotMatch(body, /Prefer small diffs\./);
  });
});

test("a constitution absent from the clone falls back to the cloud, and says so", async () => {
  const root = makeClone({ "AGENTS.md": "Always write a test." });
  await withTools(async ({ call }) => {
    const body = (
      (await call("get_project_rules", { workspace_root: root })).content[0] as { text: string }
    ).text;
    assert.match(body, /shown from the cloud's constitution stage document/);
    assert.match(body, /Prefer small diffs\./);
  });
});

test("a folder whose remote matches no project is a tool error naming the remote", async () => {
  const root = makeClone({ "AGENTS.md": "x" }, "https://github.com/someone/unrelated.git");
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root });
    assert.equal(result.isError, true);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /No PromptWorkspace project's repository matches the git remote/);
    assert.match(body, /someone\/unrelated/);
  });
});

test("project_id overrides remote matching, so an unrelated folder still answers", async () => {
  const root = makeClone({ "AGENTS.md": "Always write a test." }, "https://github.com/someone/unrelated.git");
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root, project_id: "proj-1" });
    assert.equal(result.isError, undefined);
    const body = (result.content[0] as { text: string }).text;
    assert.match(body, /# Coding rules for Uploader \(Acme\)/);
    assert.match(body, /Always write a test\./);
  });
});

test("an unknown project_id is refused rather than silently falling back to the remote", async () => {
  const root = makeClone({ "AGENTS.md": "x" });
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root, project_id: "proj-9" });
    assert.equal(result.isError, true);
    assert.match(
      (result.content[0] as { text: string }).text,
      /No PromptWorkspace project proj-9 is visible to you/,
    );
  });
});

test("two projects sharing one remote ask the developer to disambiguate", async () => {
  const root = makeClone({ "AGENTS.md": "x" });
  await withTools(
    async ({ call }) => {
      const result = await call("get_project_rules", { workspace_root: root });
      assert.equal(result.isError, true);
      const body = (result.content[0] as { text: string }).text;
      // Guessing between them would hand the agent another project's rules and
      // look like it worked.
      assert.match(body, /2 PromptWorkspace projects share the git remote/);
      assert.match(body, /proj-1: Uploader/);
      assert.match(body, /proj-2: Uploader fork/);
    },
    {
      extraProjects: [
        {
          id: "proj-2",
          name: "Uploader fork",
          workspace_id: "ws-1",
          repo_url: `${REPO_URL}.git`,
          lifecycle_status: "repo_created",
        },
      ],
    },
  );
});

test("a folder that is not a git repository says so rather than reporting no match", async () => {
  const root = mkdtempSync(join(tmpdir(), "pz-mcp-plain-"));
  clones.push(root);
  await withTools(async ({ call }) => {
    const result = await call("get_project_rules", { workspace_root: root });
    assert.equal(result.isError, true);
    assert.match(
      (result.content[0] as { text: string }).text,
      /is not inside a git repository/,
    );
  });
});

// --------------------------------------------------------------- close_task

test("close_task writes the status with the commit the caller names", async () => {
  await withTools(async ({ call, seen, queued }) => {
    const result = await call("close_task", {
      task_id: "task-1",
      status: "implemented",
      commit_sha: "1a2b3c4d5e6f",
      commit_message: "T012: retry the upload",
    });
    assert.equal(result.isError, undefined);
    const body = bodyOf(result);
    assert.match(body, /T012 \(Add a retry to the uploader\) is now Implemented/);
    assert.match(body, /Commit recorded: 1a2b3c4d5e6f/);
    assert.match(body, /Nothing is queued/);

    const writes = statusWrites(seen);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/projects/proj-1/tasks/task-1/status");
    assert.deepEqual(writes[0].body, {
      status: "implemented",
      // Same `git: <subject>` shape apps/vscode's watcher writes, so an
      // artifact from either surface renders identically in apps/web.
      artifact: { commit_sha: "1a2b3c4d5e6f", uri: "git: T012: retry the upload", kind: "code" },
    });
    assert.deepEqual(queued(), []);
  });
});

test("close_task records HEAD when the caller names no commit", async () => {
  const root = makeClone({ "src/retry.ts": "export const retries = 3;\n" });
  const sha = commitAll(root, "T012: retry the upload");
  await withTools(async ({ call, seen }) => {
    const result = await call("close_task", {
      task_id: "task-1",
      status: "implemented",
      workspace_root: root,
    });
    assert.equal(result.isError, undefined);
    assert.match(bodyOf(result), new RegExp(`Commit recorded: ${sha} \\(HEAD of ${root}\\)`));
    assert.deepEqual(statusWrites(seen)[0].body, {
      status: "implemented",
      artifact: { commit_sha: sha, uri: "git: T012: retry the upload", kind: "code" },
    });
  });
});

test("a workspace root with no commits closes the task and says no commit was recorded", async () => {
  // The status is the point; the evidence is the bonus. Refusing the close
  // because a folder has no HEAD would strand the developer's work as open.
  const root = makeClone({ "AGENTS.md": "x" });
  await withTools(async ({ call, seen }) => {
    const result = await call("close_task", {
      task_id: "task-1",
      status: "implemented",
      workspace_root: root,
    });
    assert.equal(result.isError, undefined);
    assert.match(bodyOf(result), /No commit recorded/);
    assert.deepEqual(statusWrites(seen)[0].body, { status: "implemented" });
  });
});

test("a 4xx refusal is an error and never enters the queue", async () => {
  // The whole point of the ported rule: a 403 will not succeed on the tenth
  // attempt either, so it is surfaced and dropped.
  await withTools(
    async ({ call, queued, seen }) => {
      const result = await call("close_task", {
        task_id: "task-1",
        status: "implemented",
        commit_sha: "deadbeef",
      });
      assert.equal(result.isError, true);
      const body = bodyOf(result);
      assert.match(body, /assigned to someone else, or to nobody/);
      assert.match(body, /status is unchanged/);
      assert.equal(statusWrites(seen).length, 1);
      assert.deepEqual(queued(), []);
    },
    { statusReply: () => ({ code: 403, detail: "status_forbidden" }) },
  );
});

test("verified without admin is reported in the cloud's own terms", async () => {
  await withTools(
    async ({ call, queued }) => {
      const result = await call("close_task", { task_id: "task-1", status: "verified" });
      assert.equal(result.isError, true);
      assert.match(bodyOf(result), /Only a workspace admin can mark a task verified/);
      assert.deepEqual(queued(), []);
    },
    { statusReply: () => ({ code: 403, detail: "verified_requires_admin" }) },
  );
});

test("an unreachable cloud queues the write instead of failing it", async () => {
  await withTools(
    async ({ call, queued }) => {
      const result = await call("close_task", {
        task_id: "task-1",
        status: "implemented",
        commit_sha: "deadbeef",
      });
      // Not an error: the write is accepted and durable, it simply has not
      // landed. Calling it a failure would send the agent off to redo work.
      assert.equal(result.isError, undefined);
      const body = bodyOf(result);
      assert.match(body, /queued rather than lost/);
      assert.match(body, /still shows the task's old status/);
      assert.match(body, /1 status write\(s\) still queued/);

      const entries = queued();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].taskId, "task-1");
      assert.equal(entries[0].projectId, "proj-1");
      assert.equal(entries[0].status, "implemented");
      assert.equal(entries[0].artifact?.commit_sha, "deadbeef");
    },
    { statusReply: () => ({ code: 503, detail: "upstream unavailable" }) },
  );
});

test("a second close for the same task supersedes the queued one", async () => {
  await withTools(
    async ({ call, queued }) => {
      await call("close_task", { task_id: "task-1", status: "todo", commit_sha: "aaa" });
      await call("close_task", { task_id: "task-1", status: "implemented", commit_sha: "bbb" });
      // Status is a scalar, so last write wins; a queue that replayed both
      // would flap the task through a state the developer left behind.
      const entries = queued();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, "implemented");
      assert.equal(entries[0].artifact?.commit_sha, "bbb");
    },
    { statusReply: () => ({ code: 500 }) },
  );
});

test("a queued write survives the server that made it and flushes from the next one", async () => {
  // Two server instances over one config directory, which is what an MCP client
  // actually does: it starts and kills this process around a conversation.
  const queueDir = tempDir("pz-mcp-queue-shared-");
  await withTools(
    async ({ call, queued }) => {
      await call("close_task", { task_id: "task-1", status: "implemented", commit_sha: "aaa" });
      assert.equal(queued().length, 1);
    },
    { queueDir, statusReply: () => ({ code: 503 }) },
  );

  await withTools(
    async ({ call, seen, queued }) => {
      const result = await call("close_task", { task_id: "task-1", status: "verified", commit_sha: "bbb" });
      assert.equal(result.isError, undefined);
      const writes = statusWrites(seen);
      // The parked write goes first, read back off disk by a process that never
      // enqueued it, and the new one follows.
      assert.equal(writes.length, 2);
      assert.equal((writes[0].body?.artifact as { commit_sha: string }).commit_sha, "aaa");
      assert.equal(writes[1].body?.status, "verified");
      assert.deepEqual(queued(), []);
      assert.match(bodyOf(result), /Nothing is queued/);
    },
    { queueDir },
  );
});

test("close_task refuses an unknown task id without queueing anything", async () => {
  await withTools(async ({ call, queued, seen }) => {
    const result = await call("close_task", { task_id: "nope", status: "implemented" });
    assert.equal(result.isError, true);
    assert.match(bodyOf(result), /No task nope is assigned to you/);
    assert.equal(statusWrites(seen).length, 0);
    assert.deepEqual(queued(), []);
  });
});

test("close_task refuses a status outside the one vocabulary", async () => {
  await withTools(async ({ call, seen }) => {
    const result = await call("close_task", { task_id: "task-1", status: "done" });
    assert.equal(result.isError, true);
    assert.match(bodyOf(result), /must be one of: todo, in_progress, implemented, verified/);
    assert.equal(statusWrites(seen).length, 0);
  });
});

test("config precedence is default, then file, then environment", () => {
  const withEnv = readConfig({
    PROMPTWORKSPACE_MCP_CONFIG_DIR: "/nonexistent-promptworkspace-mcp",
    PROMPTWORKSPACE_CLOUD_API_URL: "http://localhost:8080/",
  } as NodeJS.ProcessEnv);
  // Env wins, and a trailing slash is trimmed the way apps/vscode trims it.
  assert.equal(withEnv.cloudApiUrl, "http://localhost:8080");
  // Anything unset falls back to the shared production defaults apps/vscode ships.
  assert.equal(withEnv.cloudWebUrl, PRODUCTION_DEFAULTS.cloudWebUrl);
  assert.equal(withEnv.supabaseUrl, PRODUCTION_DEFAULTS.supabaseUrl);
  assert.equal(withEnv.supabaseAnonKey, PRODUCTION_DEFAULTS.supabaseAnonKey);
});

test("with no file and no env the config is exactly the production defaults", () => {
  const bare = readConfig({
    PROMPTWORKSPACE_MCP_CONFIG_DIR: "/nonexistent-promptworkspace-mcp",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(bare, { ...PRODUCTION_DEFAULTS });
  assert.equal(bare.cloudApiUrl, "https://workspace-api.promptconnext.com");
});
