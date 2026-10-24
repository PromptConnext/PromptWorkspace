// Which cloud project is the developer sitting in?
//
// apps/vscode answers this with a persisted, resource-scoped
// `promptworkspace.projectId` setting, discovered by matching git remotes and
// written only after the user confirms (src/link/projectLink.ts). None of that
// exists here: there is no settings store to write to, no folder scope, and no
// one to confirm — an MCP client calls a tool and expects an answer. So the
// discovery half is kept and the persistence half is replaced by the tool's own
// `project_id` argument, which is the developer saying the same thing the
// setting would have said, per call.
//
// Candidates come from the roster rather than from assigned tasks, matching
// apps/vscode for the same reason: a developer can be in a project's clone
// before any of its work is assigned to them, and "no tasks yet" must not read
// as "wrong folder".

import {
  isCloneableRepoUrl,
  projectsMatchingRemotes,
  type CloudClient,
  type LoggerLike,
} from "@promptworkspace/cloud-client";
import { readGitRemotes } from "./gitRemotes.ts";
import { resolveWorkspaceRoot } from "./repoDocs.ts";
import { optionalString } from "./toolResult.ts";

export interface ProjectCandidate {
  projectId: string;
  projectName: string;
  workspaceName: string;
  /** Guarded by `isCloneableRepoUrl`. Null means "no URL we are willing to act
   *  on" — the same gate apps/vscode/src/projects/roster.ts applies, because
   *  `repo_url` is cloud-supplied input and this one is compared against a
   *  string that came off the developer's disk. */
  repoUrl: string | null;
}

/** Every project the caller is a member of, flattened across workspaces. */
export async function listProjectCandidates(
  client: CloudClient,
  log: LoggerLike,
): Promise<ProjectCandidate[]> {
  const workspaces = await client.listWorkspaces();
  const out: ProjectCandidate[] = [];
  for (const workspace of workspaces) {
    let projects;
    try {
      projects = await client.listWorkspaceProjects(workspace.id);
    } catch (err) {
      // A revoked membership 403s on one workspace. Dropping that workspace is
      // right; dropping the roster because of it is not.
      log.info(`projects unavailable for workspace ${workspace.id}: ${String(err)}`);
      continue;
    }
    for (const project of projects) {
      out.push({
        projectId: project.id,
        projectName: project.name,
        workspaceName: workspace.name,
        repoUrl: isCloneableRepoUrl(project.repo_url) ? project.repo_url!.trim() : null,
      });
    }
  }
  return out;
}

/** Candidates whose repository is the one this folder's remotes point at.
 *  An SSH host alias (`github.com-work`) counts only when it fits exactly one
 *  project; the shared rule is `projectsMatchingRemotes`. */
export function matchCandidates(
  remotes: string[],
  candidates: ProjectCandidate[],
): ProjectCandidate[] {
  if (remotes.length === 0) return [];
  return projectsMatchingRemotes(remotes, candidates);
}

export type ResolvedProject = { root: string; project: ProjectCandidate } | { error: string };

/** The project a folder-scoped tool acts on: `project_id` when given, else the
 *  one project whose repository is `workspace_root`'s git remote. Every way
 *  that can fail is an `error` the tool returns as-is; `tool` names the tool to
 *  call again when several projects share the remote. */
export async function resolveProject(
  client: CloudClient,
  log: LoggerLike,
  args: Record<string, unknown>,
  tool: string,
): Promise<ResolvedProject> {
  const root = resolveWorkspaceRoot(optionalString(args, "workspace_root"));
  const explicitId = optionalString(args, "project_id");
  const candidates = await listProjectCandidates(client, log);

  if (explicitId) {
    const named = candidates.find((c) => c.projectId === explicitId);
    if (!named) {
      return {
        error:
          `No PromptWorkspace project ${explicitId} is visible to you. Either the id is ` +
          "wrong or you are not a member of its workspace.",
      };
    }
    return { root, project: named };
  }

  const { isRepository, remotes } = await readGitRemotes(root);
  if (!isRepository) {
    return {
      error:
        `${root} is not inside a git repository, so there is no remote to match a ` +
        "PromptWorkspace project against. Pass workspace_root for the developer's " +
        "clone, or project_id to name the project directly.",
    };
  }
  if (remotes.length === 0) {
    return {
      error:
        `The git repository at ${root} has no remote, so it cannot be matched to a ` +
        "PromptWorkspace project. Pass project_id to name the project directly.",
    };
  }

  const matches = matchCandidates(remotes, candidates);
  if (matches.length === 0) {
    return {
      error:
        `No PromptWorkspace project's repository matches the git remote of ${root} ` +
        `(${remotes.join(", ")}). Check that this is the right clone, or pass ` +
        "project_id to name the project directly.",
    };
  }
  if (matches.length > 1) {
    // A fork, or a monorepo holding several cloud projects. Guessing between
    // them would hand the agent another project's rules (or plan) and look
    // like it worked, so the developer disambiguates — the same job
    // apps/vscode's persisted `projectId` setting does when its own matcher
    // returns several.
    const listed = matches
      .map((m) => `  - ${m.projectId}: ${m.projectName} (${m.workspaceName})`)
      .join("\n");
    return {
      error:
        `${matches.length} PromptWorkspace projects share the git remote of ${root}. ` +
        `Call ${tool} again with project_id set to one of:\n${listed}`,
    };
  }

  return { root, project: matches[0] };
}
