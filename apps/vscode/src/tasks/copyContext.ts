// "Copy task context" — the universal fallback.
//
// ADR 0019 calls this unglamorous, universal, and the thing developers will
// actually use most. It has to work when everything else is degraded: no spec
// pulled, no repo linked, offline. Every lookup below is therefore optional and
// failure-tolerant by construction.
//
// No `vscode` import, so the text is unit-tested; the clipboard write and the
// toast live with the command in extension.ts.

import type { CloudClient, LoggerLike } from "@promptworkspace/cloud-client";
import type { AssignedTask } from "@promptworkspace/cloud-client";
import {
  CloudHttpError,
  CloudNotLoggedInError,
  TASK_STATUS_LABELS,
  branchNameForTask,
  taskRefFromFeatureTag,
} from "@promptworkspace/cloud-client";
import type { RepoDocs } from "../context/repoDocs.ts";

const SPEC_EXCERPT_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 5000;

export type MissingPart = "specification" | "plan" | "rules";

export interface TaskContext {
  text: string;
  /** Parts whose fetch failed or timed out. A document that does not exist is not listed. */
  missing: MissingPart[];
  /** A part went missing because no one is signed in, not because the cloud
   *  was slow: the message then asks for a sign-in instead of blaming it. */
  signedOut: boolean;
}

/** Facts only the extension host knows; passed in as data so this file never imports vscode. */
export interface TaskContextExtra {
  branch?: string;
  webUrl?: string;
  /** How long each fetch may take before its part is reported missing. Default 5000. */
  timeoutMs?: number;
}

export async function buildTaskContext(
  entry: AssignedTask,
  client: CloudClient,
  docs: RepoDocs,
  log: LoggerLike,
  extra: TaskContextExtra = {},
): Promise<TaskContext> {
  const { task } = entry;
  const ref = taskRefFromFeatureTag(task.feature_tag);
  // The heading and "What to do" spell the task the same way (the normalised
  // ref); the board tag follows in parentheses only when it differs.
  const tag = task.feature_tag;
  const label = ref ?? tag ?? task.id;
  const heading = tag && tag !== label ? `${label} (${tag})` : label;
  const lines: string[] = [`# Task ${heading}: ${task.title}`, ""];
  if (ref) {
    // Finding #38: an agent given this text committed `T014:` on another
    // task's branch. Name the branch Start Task uses and the subject prefix
    // the close-on-push watcher reads, before anything else.
    lines.push(
      `Work on branch \`${branchNameForTask(ref, task.title)}\`; ` +
        `start commit subjects with \`${ref}:\`.`,
      "",
    );
  }
  lines.push(
    `- Project: ${entry.project_name} (${entry.workspace_name})`,
    `- Status: ${TASK_STATUS_LABELS[task.status]}`,
  );
  if (entry.repo_url) lines.push(`- Repository: ${entry.repo_url}`);
  if (extra.branch) lines.push(`- Branch: ${extra.branch}`);
  if (extra.webUrl) lines.push(`- Web: ${extra.webUrl}`);
  lines.push("");

  if (task.acceptance_criteria.length > 0) {
    lines.push("## Acceptance criteria", "");
    for (const criterion of task.acceptance_criteria) {
      lines.push(`- [ ] ${criterion.text}`);
    }
    lines.push("");
  }

  const timeoutMs = extra.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [spec, plan, constitution] = await Promise.all([
    settle(specifyExcerpt(entry, client, log), timeoutMs),
    settle(planExcerpt(entry, client, log), timeoutMs),
    settle(docs.read(entry.project_id, "constitution"), timeoutMs),
  ]);
  const missing: MissingPart[] = [];
  if (!spec.ok) missing.push("specification");
  if (!plan.ok) missing.push("plan");
  if (!constitution.ok) missing.push("rules");
  const signedOut = [spec, plan, constitution].some(
    (part) => !part.ok && part.error instanceof CloudNotLoggedInError,
  );

  if (spec.ok && spec.value) lines.push("## Specification (excerpt)", "", spec.value, "");
  if (plan.ok && plan.value) {
    lines.push("## Implementation plan (excerpt)", "", plan.value, "");
  }
  if (constitution.ok && constitution.value) {
    lines.push("## Project coding rules", "", constitution.value.trim(), "");
  }

  lines.push(
    "## What to do",
    "",
    `Implement this task in the current workspace. When it is done, commit with ` +
      `\`${ref ?? "T?"}: <what you did>\` in the subject so PromptWorkspace ` +
      `closes the task automatically.`,
    "",
    "The specification, plan and rules above are the whole context. They are not files " +
      "in this repository, so do not search the disk for spec.md, plan.md or tasks.md.",
    "",
  );
  return { text: lines.join("\n"), missing, signedOut };
}

/** The sentence the command shows once the context is on the clipboard. */
export function copiedMessage(
  tag: string,
  missing: readonly MissingPart[],
  signedOut = false,
): string {
  if (missing.length === 0) return `Copied context for ${tag}.`;
  const why = signedOut
    ? "Sign in to PromptWorkspace to include them."
    : "PromptWorkspace did not answer in time.";
  return `Copied context for ${tag} without the ${missing.join(" and ")}. ${why}`;
}

/** `error` is what the promise rejected with; absent on a timeout. */
type Settled<T> = { ok: true; value: T } | { ok: false; error?: unknown };

/** Resolves with the value, or `{ ok: false }` if the promise rejects or does not settle in time. */
function settle<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      },
    );
  });
}

function isNotFound(err: unknown): boolean {
  return err instanceof CloudHttpError && err.status === 404;
}

/** The task page in the web app; shared by "Open in the web app" and the copied context. */
export function taskWebUrl(webUrl: string, entry: AssignedTask): string {
  return `${webUrl}/w/${entry.workspace_id}/p/${entry.project_id}?tab=tasks`;
}

function capped(text: string): string {
  return text.length > SPEC_EXCERPT_CHARS
    ? `${text.slice(0, SPEC_EXCERPT_CHARS)}\n\n…(truncated)`
    : text;
}

async function specifyExcerpt(
  entry: AssignedTask,
  client: CloudClient,
  log: LoggerLike,
): Promise<string | null> {
  try {
    const stage = await client.getStageDocument(entry.project_id, "specify");
    return stage.content ? capped(stage.content) : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    log.info(`specification unavailable: ${String(err)}`);
    throw err;
  }
}

async function planExcerpt(
  entry: AssignedTask,
  client: CloudClient,
  log: LoggerLike,
): Promise<string | null> {
  if (!entry.task.spec_id) return null;
  try {
    const graph = await client.getProjectGraph(entry.project_id);
    const spec = graph.spec_documents.find((s) => s.id === entry.task.spec_id);
    if (!spec?.content) return null;
    return capped(spec.content);
  } catch (err) {
    // The caller turns a throw into "missing": the copy degrades, never fails.
    if (isNotFound(err)) return null;
    log.info(`plan excerpt unavailable: ${String(err)}`);
    throw err;
  }
}
