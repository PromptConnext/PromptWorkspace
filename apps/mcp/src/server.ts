// The stdio MCP server.
//
// stdio only. Plan 0025 §4: it is the transport every target client can already
// launch, and M2 will need to read the developer's clone, which a remotely
// hosted endpoint cannot see. Streamable HTTP is M4 and earns its place there
// for one case — a workspace wanting a shared endpoint — which needs an OAuth
// resource-server story rather than a pasted token.
//
// Four tools, and the ceiling is deliberate (plan 0025 §1): M4 adds transports
// and reach, not vocabulary. Three read, and `close_task` writes exactly one
// field through the one endpoint that takes it. Above all: this server never
// touches `PUT /sync/projects/{id}/graph`. That is the same prohibition
// packages/cloud-client/src/client.ts writes down for the same reason — a task
// client with a full-graph push can overwrite the requirements and specs the
// cloud authored. There is no task-claim or task-assignment tool either:
// `/me/tasks` returns only tasks already assigned to the caller, so a claim tool
// would have no caller, and `close_task` inherits that constraint: the cloud
// refuses a status write on a task that is not the caller's, and that refusal is
// reported rather than worked around.
//
// The low-level `Server` rather than `McpServer`: the latter's `inputSchema`
// takes a Zod shape, and adding Zod as a direct dependency of this app would
// pin a second copy against the SDK's own `^3.25 || ^4.0` range for tools whose
// entire input is a handful of optional-or-required strings. JSON Schema is
// what goes over the wire regardless, so it is declared directly and validated
// by hand below.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CloudNotConfiguredError,
  CloudNotLoggedInError,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isTaskStatus,
  type AssignedTask,
  type CloudClient,
  type LoggerLike,
  type StatusArtifact,
  type TaskStatus,
} from "@promptworkspace/cloud-client";
import { createCloudContext, stderrLog } from "./cloud.ts";
import { readGitHead, readGitRemotes } from "./gitRemotes.ts";
import { buildProjectRules } from "./projectRules.ts";
import { listProjectCandidates, matchCandidates } from "./projectResolve.ts";
import { resolveWorkspaceRoot } from "./repoDocs.ts";
import { StatusWriter } from "./statusWriter.ts";
import { buildTaskContext, summarizeTasks } from "./taskContext.ts";

export const SERVER_NAME = "promptworkspace";
export const SERVER_VERSION = "0.1.0";

export const TOOLS: Tool[] = [
  {
    name: "list_my_tasks",
    title: "List my PromptWorkspace tasks",
    description:
      "The PromptWorkspace tasks assigned to the signed-in developer, across every " +
      "workspace and project. Defaults to open work (todo and in progress); pass " +
      "`status` explicitly to include completed tasks.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Restrict to one workspace. Omit for every workspace.",
        },
        status: {
          type: "array",
          items: { type: "string", enum: TASK_STATUSES },
          description:
            "Task statuses to include. Omit for the cloud's default of todo and in_progress.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_task",
    title: "Get one PromptWorkspace task with its context",
    description:
      "One assigned task with its acceptance criteria, an excerpt of the " +
      "specification it implements, and the project and repository it belongs to. " +
      "Take the id from list_my_tasks.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task's id, as reported by list_my_tasks.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_project_rules",
    title: "Get a PromptWorkspace project's coding rules",
    description:
      "The project's seeded coding-rules files — AGENTS.md, docs/conventions.md " +
      "and .specify/memory/constitution.md — read from the developer's clone. The " +
      "project is resolved from the folder's git remote unless `project_id` says " +
      "otherwise. Read these before writing code in this repository.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_root: {
          type: "string",
          description:
            "Absolute path to the clone to read. Defaults to this server's working " +
            "directory, which is whatever the MCP client launched it in — pass the " +
            "path explicitly if that is not the developer's project.",
        },
        project_id: {
          type: "string",
          description:
            "Use this project instead of resolving one from the folder's git remote. " +
            "Needed when several projects share a repository, or when the folder has " +
            "no remote at all.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "close_task",
    title: "Report a PromptWorkspace task's status",
    description:
      "Set the status of a task assigned to the signed-in developer, recording " +
      "the commit that implemented it. Use `implemented` when the work is " +
      "committed; `verified` is a reviewer's word and a workspace admin's to " +
      "say. Without `commit_sha` the commit at HEAD of `workspace_root` is " +
      "recorded, so call this after committing. Changes only the status and its " +
      "artifact — never the task's title, criteria or assignment.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task's id, as reported by list_my_tasks.",
        },
        status: {
          type: "string",
          enum: TASK_STATUSES,
          description:
            "The status to report. `implemented` for finished work; `verified` " +
            "is refused unless you are a workspace admin.",
        },
        commit_sha: {
          type: "string",
          description:
            "The commit that implemented the task. Omit to record the commit at " +
            "HEAD of workspace_root, which is the usual case.",
        },
        commit_message: {
          type: "string",
          description:
            "A description of that commit, shown beside it in the web app. " +
            "Ignored unless commit_sha is given — the HEAD commit brings its own.",
        },
        workspace_root: {
          type: "string",
          description:
            "Absolute path to the clone whose HEAD should be recorded. Defaults " +
            "to this server's working directory, which is whatever the MCP client " +
            "launched it in — pass the path explicitly if that is not the " +
            "developer's project. Unused when commit_sha is given.",
        },
      },
      required: ["task_id", "status"],
      additionalProperties: false,
    },
    // Not read-only, not destructive, and not idempotent in the sense that
    // matters: a second call with a different status changes the answer.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`\`${key}\` must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalStatuses(args: Record<string, unknown>): TaskStatus[] | undefined {
  const value = args.status;
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out: TaskStatus[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isTaskStatus(item)) {
      throw new Error(`\`status\` must be one of: ${TASK_STATUSES.join(", ")}.`);
    }
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

async function listMyTasks(
  client: CloudClient,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const entries = await client.listAssignedTasks({
    workspaceId: optionalString(args, "workspace_id"),
    statuses: optionalStatuses(args),
  });
  return text(summarizeTasks(entries));
}

function requiredStatus(args: Record<string, unknown>): TaskStatus {
  const value = args.status;
  if (typeof value !== "string" || !isTaskStatus(value)) {
    throw new Error(`\`status\` is required and must be one of: ${TASK_STATUSES.join(", ")}.`);
  }
  return value;
}

/** The caller's task with that id.
 *
 *  Every status, not the endpoint's open-work default: asking for a task by id
 *  is asking for that task, and refusing to show one because it is already
 *  implemented would be surprising. `/me/tasks` is still the only source —
 *  there is no per-task read that would not also need the project and workspace
 *  names this payload carries, and it is the same list `close_task` resolves a
 *  project id from, which is why neither tool takes one. */
async function findAssignedTask(
  client: CloudClient,
  taskId: string,
): Promise<AssignedTask | undefined> {
  const entries: AssignedTask[] = await client.listAssignedTasks({
    statuses: TASK_STATUSES,
  });
  return entries.find((e) => e.task.id === taskId);
}

function noSuchTask(taskId: string): string {
  return (
    `No task ${taskId} is assigned to you. Tasks are assigned in the web app; ` +
    "run list_my_tasks to see what you have."
  );
}

async function getTask(
  client: CloudClient,
  log: LoggerLike,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const taskId = optionalString(args, "task_id");
  if (!taskId) return failure("`task_id` is required. Take one from list_my_tasks.");

  const entry = await findAssignedTask(client, taskId);
  if (!entry) return failure(noSuchTask(taskId));
  return text(await buildTaskContext(entry, client, log));
}

async function getProjectRules(
  client: CloudClient,
  log: LoggerLike,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const root = resolveWorkspaceRoot(optionalString(args, "workspace_root"));
  const explicitId = optionalString(args, "project_id");
  const candidates = await listProjectCandidates(client, log);

  if (explicitId) {
    const named = candidates.find((c) => c.projectId === explicitId);
    if (!named) {
      return failure(
        `No PromptWorkspace project ${explicitId} is visible to you. Either the id is ` +
          "wrong or you are not a member of its workspace.",
      );
    }
    return text(await buildProjectRules(root, named, client, log));
  }

  const { isRepository, remotes } = await readGitRemotes(root);
  if (!isRepository) {
    return failure(
      `${root} is not inside a git repository, so there is no remote to match a ` +
        "PromptWorkspace project against. Pass workspace_root for the developer's " +
        "clone, or project_id to name the project directly.",
    );
  }
  if (remotes.length === 0) {
    return failure(
      `The git repository at ${root} has no remote, so it cannot be matched to a ` +
        "PromptWorkspace project. Pass project_id to name the project directly.",
    );
  }

  const matches = matchCandidates(remotes, candidates);
  if (matches.length === 0) {
    return failure(
      `No PromptWorkspace project's repository matches the git remote of ${root} ` +
        `(${remotes.join(", ")}). Check that this is the right clone, or pass ` +
        "project_id to name the project directly.",
    );
  }
  if (matches.length > 1) {
    // A fork, or a monorepo holding several cloud projects. Guessing between
    // them would hand the agent another project's rules and look like it
    // worked, so the developer disambiguates — the same job apps/vscode's
    // persisted `projectId` setting does when its own matcher returns several.
    const listed = matches
      .map((m) => `  - ${m.projectId}: ${m.projectName} (${m.workspaceName})`)
      .join("\n");
    return failure(
      `${matches.length} PromptWorkspace projects share the git remote of ${root}. ` +
        `Call get_project_rules again with project_id set to one of:\n${listed}`,
    );
  }

  return text(await buildProjectRules(root, matches[0], client, log));
}

const ARTIFACT_URI_CHARS = 100;

interface ResolvedArtifact {
  artifact?: StatusArtifact;
  /** One line for the tool's answer, so the developer can see which commit was
   *  attached — or that none was, and why. */
  note: string;
}

/** The commit to record against the close.
 *
 *  The caller's `commit_sha` wins; otherwise it is HEAD of the workspace root,
 *  because a developer closing a task has just committed the work and should not
 *  have to paste a sha their agent can read. The `uri` shape is
 *  apps/vscode/src/git/gitWatcher.ts's — `git: <subject>` — so an artifact from
 *  either surface renders identically in apps/web.
 *
 *  A root with no readable HEAD is not an error: the status is the point and the
 *  evidence is the bonus, so the write goes ahead without it and the answer says
 *  so. The cloud agrees — `artifact` is optional on the endpoint. */
async function resolveArtifact(args: Record<string, unknown>): Promise<ResolvedArtifact> {
  const sha = optionalString(args, "commit_sha");
  if (sha) {
    const message = optionalString(args, "commit_message");
    return {
      artifact: {
        commit_sha: sha,
        uri: `git: ${(message ?? sha).slice(0, ARTIFACT_URI_CHARS)}`,
        kind: "code",
      },
      note: `Commit recorded: ${sha}${message ? ` — ${message}` : ""}`,
    };
  }
  const root = resolveWorkspaceRoot(optionalString(args, "workspace_root"));
  const head = await readGitHead(root);
  if (!head) {
    return {
      note:
        `No commit recorded: ${root} has no readable git HEAD. Pass commit_sha, ` +
        "or workspace_root for the developer's clone.",
    };
  }
  return {
    artifact: {
      commit_sha: head.sha,
      uri: `git: ${head.subject.slice(0, ARTIFACT_URI_CHARS)}`,
      kind: "code",
    },
    note: `Commit recorded: ${head.sha} (HEAD of ${root}) — ${head.subject}`,
  };
}

function queueLine(state: { size: number; parked: number }): string {
  if (state.size === 0) return "Nothing is queued: every status write has reached the cloud.";
  const parked =
    state.parked > 0
      ? ` ${state.parked} of them stopped retrying after repeated failures — check that the cloud is reachable.`
      : "";
  return `${state.size} status write(s) still queued.${parked}`;
}

async function closeTask(
  client: CloudClient,
  writer: StatusWriter,
  log: LoggerLike,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const taskId = optionalString(args, "task_id");
  if (!taskId) return failure("`task_id` is required. Take one from list_my_tasks.");
  const status = requiredStatus(args);

  const entry = await findAssignedTask(client, taskId);
  // Refused before anything is queued: a task id the cloud does not hand back is
  // one the write would be refused for anyway, and a queue full of doomed
  // entries is the failure mode the 4xx rule exists to prevent.
  if (!entry) return failure(noSuchTask(taskId));

  // The lookup above just proved this process is signed in and can reach the
  // cloud, which is why the flush sits here rather than at the top: a flush
  // attempted while offline would spend the queue's four attempts on requests
  // that never had a chance, and park entries that were only ever waiting for a
  // network. Flushing before the new write also means a stale entry for this
  // same task lands before it is superseded, rather than replaying an older
  // status afterwards.
  const { sent, failed } = await writer.flush();
  if (sent > 0 || failed > 0) log.info(`queue flush: ${sent} sent, ${failed} failed`);

  const { artifact, note } = await resolveArtifact(args);
  const outcome = await writer.setStatus({
    projectId: entry.project_id,
    taskId,
    status,
    artifact,
  });
  const pending = await writer.pending();
  const label = TASK_STATUS_LABELS[status];
  const name = `${entry.task.feature_tag ?? taskId} (${entry.task.title})`;

  if (outcome.kind === "refused") {
    return failure(`${outcome.message}\n\nThe task's status is unchanged.`);
  }
  if (outcome.kind === "queued") {
    // Not an error: the write is accepted and durable, it simply has not landed.
    // Saying "failed" here would send the agent off to redo work that is done.
    return text(
      [
        `PromptWorkspace could not be reached (${outcome.reason}), so this write is ` +
          `queued rather than lost: ${name} -> ${label} in ${entry.project_name}.`,
        note,
        "It will be retried on the next close_task call or when this server next " +
          "starts, and the cloud still shows the task's old status until then.",
        queueLine(pending),
      ].join("\n\n"),
    );
  }
  return text(
    [
      `${name} is now ${label} in ${entry.project_name} (${entry.workspace_name}).`,
      note,
      queueLine(pending),
    ].join("\n\n"),
  );
}

export function createServer(
  client: CloudClient,
  log: LoggerLike,
  writer: StatusWriter,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "PromptWorkspace tasks assigned to this developer, the coding rules of the " +
        "project they are working in, and the one write that closes a task: its " +
        "status, with the commit that implemented it. Nothing else in the task " +
        "graph is writable from here — not a task's title, its acceptance " +
        "criteria, its assignment, nor the requirements and specs above it.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case "list_my_tasks":
          return await listMyTasks(client, args);
        case "get_task":
          return await getTask(client, log, args);
        case "get_project_rules":
          return await getProjectRules(client, log, args);
        case "close_task":
          return await closeTask(client, writer, log, args);
        default:
          return failure(`Unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      // Returned as tool errors rather than thrown, so the assistant can act on
      // them (sign in, fix the config) instead of the client surfacing a
      // protocol-level failure it cannot explain.
      if (err instanceof CloudNotLoggedInError) {
        return failure(
          "Not signed in to PromptWorkspace. Run `promptworkspace-mcp login` in a terminal, " +
            "then try again.",
        );
      }
      if (err instanceof CloudNotConfiguredError) {
        return failure(
          "PromptWorkspace cloud is not configured. Set cloudApiUrl in the config file or " +
            "PROMPTWORKSPACE_CLOUD_API_URL.",
        );
      }
      log.error(`${request.params.name} failed: ${String(err)}`);
      return failure(String(err instanceof Error ? err.message : err));
    }
  });

  return server;
}

export async function runServer(): Promise<number> {
  const { client, session, queue } = createCloudContext();
  const writer = new StatusWriter(client, queue, stderrLog);
  const server = createServer(client, stderrLog, writer);
  await server.connect(new StdioServerTransport());
  stderrLog.info("stdio server ready");

  // Best effort, never blocking: a write queued by a previous process should not
  // wait for the developer to close another task before it lands. Skipped when
  // signed out, because every attempt would fail and four of them park the entry
  // — and an MCP client restarts this process often enough for that to matter.
  if (session.read()) {
    void queueFlushOnStartup(writer);
  }

  // Resolves when the transport closes, which is when the client goes away.
  await new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  return 0;
}

async function queueFlushOnStartup(writer: StatusWriter): Promise<void> {
  try {
    const { sent, failed } = await writer.flush();
    if (sent > 0 || failed > 0) {
      stderrLog.info(`startup queue flush: ${sent} sent, ${failed} failed`);
    }
  } catch (err) {
    stderrLog.warn(`startup queue flush failed: ${String(err)}`);
  }
}
