// The `get_task` payload.
//
// This is apps/vscode/src/tasks/copyContext.ts::buildTaskContext, duplicated
// rather than extracted. Plan 0025 §2 recommends exactly that: the ~90 lines of
// prompt assembly are cheaper to duplicate than to generalise, unlike the
// refresh coalescing and the 4xx rule, which must only ever be fixed once and
// therefore moved to packages/cloud-client. The divergence to expect is the coding
// rules section — there, not here, the extension reads the clone.
//
// Same contract as the original: every lookup is optional and failure-tolerant.
// A task with no spec, no repository and no constitution still returns its title
// and its acceptance criteria.

import {
  TASK_STATUS_LABELS,
  type AssignedTask,
  type CloudClient,
  type LoggerLike,
} from "@promptworkspace/cloud-client";

const SPEC_EXCERPT_CHARS = 4000;

export async function buildTaskContext(
  entry: AssignedTask,
  client: CloudClient,
  log: LoggerLike,
): Promise<string> {
  const { task } = entry;
  const lines: string[] = [
    `# Task ${task.feature_tag ?? task.id}: ${task.title}`,
    "",
    `- Task id: ${task.id}`,
    `- Project: ${entry.project_name} (${entry.workspace_name})`,
    `- Status: ${TASK_STATUS_LABELS[task.status]}`,
  ];
  if (entry.repo_url) lines.push(`- Repository: ${entry.repo_url}`);
  lines.push("");

  if (task.acceptance_criteria.length > 0) {
    lines.push("## Acceptance criteria", "");
    for (const criterion of task.acceptance_criteria) {
      lines.push(`- [ ] ${criterion.text}`);
    }
    lines.push("");
  }

  const spec = await specExcerpt(entry, client, log);
  if (spec) lines.push("## Specification", "", spec, "");

  const constitution = await cloudConstitution(entry.project_id, client, log);
  if (constitution) {
    lines.push(
      "## Project coding rules",
      "",
      "_From the cloud's constitution stage document. The repository's own seeded",
      "files are the authority and may have moved on — call get_project_rules to",
      "read them from the clone._",
      "",
      constitution.trim(),
      "",
    );
  }

  lines.push(
    "## What to do",
    "",
    `Implement this task in the current workspace. When it is done, commit with ` +
      `\`${task.feature_tag ?? "T?"}: <what you did>\` in the subject so PromptWorkspace ` +
      `closes the task automatically.`,
    "",
  );
  return lines.join("\n");
}

async function specExcerpt(
  entry: AssignedTask,
  client: CloudClient,
  log: LoggerLike,
): Promise<string | null> {
  if (!entry.task.spec_id) return null;
  try {
    const graph = await client.getProjectGraph(entry.project_id);
    const spec = graph.spec_documents.find((s) => s.id === entry.task.spec_id);
    if (!spec?.content) return null;
    return spec.content.length > SPEC_EXCERPT_CHARS
      ? `${spec.content.slice(0, SPEC_EXCERPT_CHARS)}\n\n…(truncated)`
      : spec.content;
  } catch (err) {
    // A missing excerpt degrades the answer; it must never fail it.
    log.info(`spec excerpt unavailable: ${String(err)}`);
    return null;
  }
}

/** The constitution, from the cloud only.
 *
 *  apps/vscode prefers the clone and falls back to this. `get_task` cannot: it
 *  is answered from the task id alone, with no workspace root to look in — the
 *  caller need not even be standing in the project's clone to ask about a task.
 *  Reading the clone is `get_project_rules`, which takes that root as an
 *  argument, so the section above names its source rather than implying the
 *  file on disk was consulted. */
async function cloudConstitution(
  projectId: string,
  client: CloudClient,
  log: LoggerLike,
): Promise<string | null> {
  try {
    const stage = await client.getStageDocument(projectId, "constitution");
    return stage.content || null;
  } catch (err) {
    log.info(`constitution unavailable from cloud: ${String(err)}`);
    return null;
  }
}

/** One line per task for `list_my_tasks`. Carries the id, because the id is
 *  what `get_task` needs next and an assistant should not have to guess it. */
export function summarizeTasks(entries: AssignedTask[]): string {
  if (entries.length === 0) {
    return "No tasks are assigned to you in the statuses requested.";
  }
  const lines = [`${entries.length} task(s) assigned to you:`, ""];
  for (const entry of entries) {
    const { task } = entry;
    lines.push(
      `- ${task.feature_tag ?? task.id}: ${task.title}`,
      `  - id: ${task.id}`,
      `  - status: ${TASK_STATUS_LABELS[task.status]}`,
      `  - project: ${entry.project_name} (${entry.workspace_name})`,
    );
    if (entry.repo_url) lines.push(`  - repository: ${entry.repo_url}`);
  }
  return lines.join("\n");
}
