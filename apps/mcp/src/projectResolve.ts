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
  sameRepo,
  type CloudClient,
  type LoggerLike,
} from "@promptworkspace/cloud-client";

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

/** Candidates whose repository is the one this folder's remotes point at. */
export function matchCandidates(
  remotes: string[],
  candidates: ProjectCandidate[],
): ProjectCandidate[] {
  if (remotes.length === 0) return [];
  return candidates.filter(
    (candidate) =>
      candidate.repoUrl !== null &&
      remotes.some((remote) => sameRepo(remote, candidate.repoUrl)),
  );
}
