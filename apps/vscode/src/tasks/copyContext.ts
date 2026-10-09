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
  TASK_STATUS_LABELS,
  branchNameForTask,
  taskRefFromFeatureTag,
} from "@promptworkspace/cloud-client";
import type { RepoDocs } from "../context/repoDocs.ts";

const SPEC_EXCERPT_CHARS = 4000;

export async function buildTaskContext(
  entry: AssignedTask,
  client: CloudClient,
  docs: RepoDocs,
  log: LoggerLike,
): Promise<string> {
  const { task } = entry;
  const ref = taskRefFromFeatureTag(task.feature_tag);
  const lines: string[] = [`# Task ${task.feature_tag ?? task.id}: ${task.title}`, ""];
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

  const constitution = await docs.read(entry.project_id, "constitution");
  if (constitution) {
    lines.push("## Project coding rules", "", constitution.trim(), "");
  }

  lines.push(
    "## What to do",
    "",
    `Implement this task in the current workspace. When it is done, commit with ` +
      `\`${ref ?? "T?"}: <what you did>\` in the subject so PromptWorkspace ` +
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
    // A missing excerpt degrades the copy; it must never fail it.
    log.info(`spec excerpt unavailable: ${String(err)}`);
    return null;
  }
}
