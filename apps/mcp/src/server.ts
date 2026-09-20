// The stdio MCP server.
//
// stdio only. Plan 0025 §4: it is the transport every target client can already
// launch, and M2 will need to read the developer's clone, which a remotely
// hosted endpoint cannot see. Streamable HTTP is M4 and earns its place there
// for one case — a workspace wanting a shared endpoint — which needs an OAuth
// resource-server story rather than a pasted token.
//
// Three tools, and the ceiling is deliberate (plan 0025 §1). `close_task` is
// M3 and is the only one still missing. Above all: this server never touches
// `PUT /sync/projects/{id}/graph`. That is the same prohibition
// packages/pz-cloud/src/client.ts writes down for the same reason — a task
// client with a full-graph push can overwrite the requirements and specs the
// cloud authored. There is no task-claim or task-assignment tool either:
// `/me/tasks` returns only tasks already assigned to the caller, so a claim tool
// would have no caller.
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
  isTaskStatus,
  type AssignedTask,
  type CloudClient,
  type LoggerLike,
  type TaskStatus,
} from "@promptconnext/pz-cloud";
import { createCloudContext, stderrLog } from "./cloud.ts";
import { readGitRemotes } from "./gitRemotes.ts";
import { buildProjectRules } from "./projectRules.ts";
import { listProjectCandidates, matchCandidates } from "./projectResolve.ts";
import { resolveWorkspaceRoot } from "./repoDocs.ts";
import { buildTaskContext, summarizeTasks } from "./taskContext.ts";

export const SERVER_NAME = "promptconnext";
export const SERVER_VERSION = "0.1.0";

export const TOOLS: Tool[] = [
  {
    name: "list_my_tasks",
    title: "List my PromptConnext tasks",
    description:
      "The PromptConnext tasks assigned to the signed-in developer, across every " +
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
    title: "Get one PromptConnext task with its context",
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
    title: "Get a PromptConnext project's coding rules",
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

async function getTask(
  client: CloudClient,
  log: LoggerLike,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const taskId = optionalString(args, "task_id");
  if (!taskId) return failure("`task_id` is required. Take one from list_my_tasks.");

  // Every status, not the endpoint's open-work default: asking for a task by id
  // is asking for that task, and refusing to show one because it is already
  // implemented would be surprising. `/me/tasks` is still the only source —
  // there is no per-task read that would not also need the project and
  // workspace names this payload carries.
  const entries: AssignedTask[] = await client.listAssignedTasks({
    statuses: TASK_STATUSES,
  });
  const entry = entries.find((e) => e.task.id === taskId);
  if (!entry) {
    return failure(
      `No task ${taskId} is assigned to you. Tasks are assigned in the web app; ` +
        "run list_my_tasks to see what you have.",
    );
  }
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
        `No PromptConnext project ${explicitId} is visible to you. Either the id is ` +
          "wrong or you are not a member of its workspace.",
      );
    }
    return text(await buildProjectRules(root, named, client, log));
  }

  const { isRepository, remotes } = await readGitRemotes(root);
  if (!isRepository) {
    return failure(
      `${root} is not inside a git repository, so there is no remote to match a ` +
        "PromptConnext project against. Pass workspace_root for the developer's " +
        "clone, or project_id to name the project directly.",
    );
  }
  if (remotes.length === 0) {
    return failure(
      `The git repository at ${root} has no remote, so it cannot be matched to a ` +
        "PromptConnext project. Pass project_id to name the project directly.",
    );
  }

  const matches = matchCandidates(remotes, candidates);
  if (matches.length === 0) {
    return failure(
      `No PromptConnext project's repository matches the git remote of ${root} ` +
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
      `${matches.length} PromptConnext projects share the git remote of ${root}. ` +
        `Call get_project_rules again with project_id set to one of:\n${listed}`,
    );
  }

  return text(await buildProjectRules(root, matches[0], client, log));
}

export function createServer(
  client: CloudClient,
  log: LoggerLike = stderrLog,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "PromptConnext tasks assigned to this developer, and the coding rules of " +
        "the project they are working in. Read-only: this server reports work and " +
        "its context, and never writes to the task graph.",
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
        default:
          return failure(`Unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      // Returned as tool errors rather than thrown, so the assistant can act on
      // them (sign in, fix the config) instead of the client surfacing a
      // protocol-level failure it cannot explain.
      if (err instanceof CloudNotLoggedInError) {
        return failure(
          "Not signed in to PromptConnext. Run `promptconnext-mcp login` in a terminal, " +
            "then try again.",
        );
      }
      if (err instanceof CloudNotConfiguredError) {
        return failure(
          "PromptConnext cloud is not configured. Set cloudApiUrl in the config file or " +
            "PROMPTCONNEXT_CLOUD_API_URL.",
        );
      }
      log.error(`${request.params.name} failed: ${String(err)}`);
      return failure(String(err instanceof Error ? err.message : err));
    }
  });

  return server;
}

export async function runServer(): Promise<number> {
  const { client } = createCloudContext();
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  stderrLog.info("stdio server ready");
  // Resolves when the transport closes, which is when the client goes away.
  await new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  return 0;
}
