// The three local-agent planning tools.
//
// For an imported project before `repo_created`, the developer's own agent
// reads the clone and does the planning the cloud would otherwise generate:
// `start_planning` hands it the brief (instructions, templates, PRDs, the
// baseline and the drafts already submitted), `submit_repo_analysis` stores
// its repository snapshot and baseline, and `submit_stage_draft` stores one
// stage's Markdown as a pending draft a human accepts or rejects in the web
// app. None of them touches the graph.
//
// Nothing here is queued. Unlike `close_task`, a draft or a baseline that did
// not land is not a fact the developer already established — it is work the
// agent should see fail and resubmit — so every cloud error is a tool error,
// and the expected refusals are reworded into something the agent can act on.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CloudHttpError,
  PLANNING_STAGES,
  type AgentRepoAnalysisIn,
  type CloudClient,
  type LoggerLike,
  type PlanningBrief,
  type PlanningStage,
  type StageDraftWarning,
} from "@promptworkspace/cloud-client";
import { resolveProject } from "./projectResolve.ts";
import { failure, optionalString, text } from "./toolResult.ts";

const CONFLICT_SENTENCES: Record<string, string> = {
  repo_not_imported: "this project was started from scratch, so there is nothing to analyze",
  repo_already_created:
    "the repository is already created, so planning drafts are no longer accepted",
};

/** The cloud refusals every planning tool shares, as tool errors; anything else
 *  is rethrown to the server's generic failure path. */
function planningRefusal(err: unknown, field: "baseline" | "markdown", forbidden: string): CallToolResult {
  if (err instanceof CloudHttpError) {
    if (err.status === 403) return failure(forbidden);
    const sentence = err.status === 409 ? CONFLICT_SENTENCES[err.message] : undefined;
    if (sentence) return failure(`${err.message}: ${sentence}`);
    if (err.status === 422) {
      return failure(`The ${field} is longer than 100,000 characters; shorten it.`);
    }
  }
  throw err;
}

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`\`${key}\` is required and must be a non-empty string.`);
  }
  return value;
}

function optionalStrings(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`\`${key}\` must be an array of strings.`);
  }
  return value as string[];
}

// ------------------------------------------------------------ start_planning

function fence(body: string): string {
  // Longer than any backtick run in the template, so a template that itself
  // shows a fenced example cannot close this one early.
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}markdown\n${body.trim()}\n${ticks}`;
}

function orNone(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : "none";
}

function renderBrief(brief: PlanningBrief): string {
  const lines: string[] = ["## Instructions", "", brief.instructions.trim(), ""];

  lines.push(
    "## Project",
    "",
    `- name: ${brief.project_name}`,
    `- repo_url: ${orNone(brief.repo_url)}`,
    `- default_branch: ${brief.default_branch}`,
    `- can_submit_analysis: ${brief.can_submit_analysis}`,
    `- analysis_status: ${brief.analysis_status}`,
    `- submittable_stages: ${brief.submittable_stages.join(", ") || "none"}`,
    "",
  );

  lines.push("## Drafts", "");
  if (brief.drafts.length === 0) lines.push("none");
  for (const d of brief.drafts) {
    lines.push(
      `- ${d.stage}: ${d.status}, stale: ${d.stale}, ` +
        `rejection_note: ${orNone(d.rejection_note)}, last_error: ${orNone(d.last_error)}`,
    );
  }
  lines.push("");

  lines.push("## Baseline", "", orNone(brief.baseline), "");
  lines.push("## Policy context", "", orNone(brief.policy_context), "");

  lines.push("## PRDs", "");
  if (brief.prd_texts.length === 0) lines.push("none", "");
  for (const prd of brief.prd_texts) {
    lines.push(`### ${prd.title}`, "", prd.text.trim(), "");
  }

  lines.push("## Templates", "");
  for (const stage of PLANNING_STAGES) {
    lines.push(`### ${stage}`, "", fence(brief.templates[stage] ?? ""), "");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export async function startPlanning(
  client: CloudClient,
  log: LoggerLike,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const resolved = await resolveProject(client, log, args, "start_planning");
  if ("error" in resolved) return failure(resolved.error);
  try {
    return text(renderBrief(await client.getPlanningBrief(resolved.project.projectId)));
  } catch (err) {
    // The brief is a read: 403 here is membership, which the resolver has
    // already ruled out, so only the 409s get plain words.
    if (err instanceof CloudHttpError && err.status === 409) {
      const sentence = CONFLICT_SENTENCES[err.message];
      if (sentence) return failure(`${err.message}: ${sentence}`);
    }
    throw err;
  }
}

// ------------------------------------------------------ submit_repo_analysis

function analysisBody(args: Record<string, unknown>): AgentRepoAnalysisIn {
  const paths = optionalStrings(args.paths, "paths");
  if (!paths) throw new Error("`paths` is required and must be an array of strings.");
  const fileCount = args.file_count;
  if (typeof fileCount !== "number" || !Number.isInteger(fileCount) || fileCount < 0) {
    throw new Error("`file_count` is required and must be a non-negative integer.");
  }
  const body: AgentRepoAnalysisIn = {
    default_branch: requiredText(args, "default_branch").trim(),
    commit_sha: requiredText(args, "commit_sha").trim(),
    paths,
    file_count: fileCount,
    baseline: requiredText(args, "baseline"),
  };
  if (args.tree_truncated !== undefined && args.tree_truncated !== null) {
    if (typeof args.tree_truncated !== "boolean") {
      throw new Error("`tree_truncated` must be a boolean.");
    }
    body.tree_truncated = args.tree_truncated;
  }
  if (args.stack !== undefined && args.stack !== null) {
    if (typeof args.stack !== "object" || Array.isArray(args.stack)) {
      throw new Error("`stack` must be an object.");
    }
    const raw = args.stack as Record<string, unknown>;
    const stack: NonNullable<AgentRepoAnalysisIn["stack"]> = {};
    const runtime = optionalString(raw, "runtime");
    if (runtime) stack.runtime = runtime;
    const manifests = optionalStrings(raw.manifests, "stack.manifests");
    if (manifests) stack.manifests = manifests;
    const languages = optionalStrings(raw.languages, "stack.languages");
    if (languages) stack.languages = languages;
    body.stack = stack;
  }
  const treeSummary = optionalString(args, "tree_summary");
  if (treeSummary) body.tree_summary = treeSummary;
  const model = optionalString(args, "model");
  if (model) body.model = model;
  return body;
}

export async function submitRepoAnalysis(
  client: CloudClient,
  log: LoggerLike,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const body = analysisBody(args);
  const resolved = await resolveProject(client, log, args, "submit_repo_analysis");
  if ("error" in resolved) return failure(resolved.error);
  try {
    const out = await client.postAgentRepoAnalysis(resolved.project.projectId, body);
    return text(
      `Baseline accepted for ${resolved.project.projectName} at ` +
        `${out.commit_sha ?? body.commit_sha}; the plan and tasks stages are now open for drafts.`,
    );
  } catch (err) {
    return planningRefusal(
      err,
      "baseline",
      "Only a workspace admin can submit the repository analysis; ask one to run this step.",
    );
  }
}

// -------------------------------------------------------- submit_stage_draft

function warningLines(warning: StageDraftWarning): string[] {
  if (warning.code === "missing_task_numbers") {
    return [`- Task numbers missing: ${warning.items.map(String).join(", ")}`];
  }
  return warning.items.map((item) => {
    const { ref, path } = (item ?? {}) as { ref?: unknown; path?: unknown };
    return (
      `- ${String(ref)} names a path not in the repository: ${String(path)} — ` +
      "mark it (new) or use an existing path"
    );
  });
}

function requiredStage(args: Record<string, unknown>): PlanningStage {
  const value = args.stage;
  if (typeof value !== "string" || !(PLANNING_STAGES as string[]).includes(value)) {
    throw new Error(`\`stage\` is required and must be one of: ${PLANNING_STAGES.join(", ")}.`);
  }
  return value as PlanningStage;
}

export async function submitStageDraft(
  client: CloudClient,
  log: LoggerLike,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const stage = requiredStage(args);
  const markdown = requiredText(args, "markdown");
  const model = optionalString(args, "model");
  const resolved = await resolveProject(client, log, args, "submit_stage_draft");
  if ("error" in resolved) return failure(resolved.error);
  try {
    const out = await client.postStageDraft(resolved.project.projectId, {
      stage,
      markdown,
      ...(model ? { model } : {}),
    });
    const lines = [`Draft for ${stage} is pending review in PromptWorkspace.`];
    const warnings = (out.warnings ?? []).flatMap(warningLines);
    if (warnings.length > 0) lines.push("", "Warnings to fix and resubmit:", ...warnings);
    return text(lines.join("\n"));
  } catch (err) {
    return planningRefusal(
      err,
      "markdown",
      `You may not author ${stage} in this project; ask a workspace admin.`,
    );
  }
}
