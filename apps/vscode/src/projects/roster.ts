// What the Projects view knows, decided here rather than in the tree.
//
// Two rules shape this file. A project's local state is DERIVED at render time
// from git remotes and a path cache — never stored as truth — because the only
// thing that can be authoritative about a clone is the disk. And a repo_url
// that arrives from the cloud is untrusted input: it passes the clone guard
// before it is rendered, compared or handed to git, so a hostile URL cannot
// reach the UI, let alone a git process.

import {
  isCloneableRepoUrl,
  sameRepo,
  type CloudProject,
  type LifecycleStatus,
  type Workspace,
} from "@promptconnext/pz-cloud";
import type { ProjectCandidate } from "../link/projectLink.ts";

/** `local` = on this machine · `remote-only` = clonable · `no-repo` = nothing
 *  to clone yet, either because the project is still being planned or because
 *  its repo_url failed the guard. */
export type LocalState = "local" | "remote-only" | "no-repo";

export interface LocalRepoRef {
  path: string;
  remotes: string[];
}

export interface RosterEntry {
  workspace: Workspace;
  projects: CloudProject[];
}

export interface ProjectRow {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  /** Guarded. Null means "there is no URL we are willing to act on". */
  repoUrl: string | null;
  defaultBranch: string | null;
  lifecycleStatus: LifecycleStatus;
  localState: LocalState;
  localPath?: string;
  taskCount: number;
}

export interface WorkspaceRow {
  workspaceId: string;
  workspaceName: string;
  projects: ProjectRow[];
  /** Drives auto-expansion: a workspace with work waiting should not be closed. */
  hasAssignedTasks: boolean;
}

export interface RosterInput {
  entries: RosterEntry[];
  openRepos: LocalRepoRef[];
  knownClones: Record<string, string>;
  taskCounts: Record<string, number>;
  folderExists: (path: string) => boolean;
}

/** The single gate every cloud-supplied repository URL passes. Returns null
 *  instead of throwing because a bad URL is a row to render differently, not
 *  an error to propagate — one broken project must not empty the tree. */
export function safeRepoUrl(url: string | null | undefined): string | null {
  if (!url || !isCloneableRepoUrl(url)) return null;
  return url.trim();
}

function localStateFor(
  projectId: string,
  repoUrl: string | null,
  input: RosterInput,
): { localState: LocalState; localPath?: string } {
  if (!repoUrl) return { localState: "no-repo" };

  // An open repository is the strongest evidence: it is on disk right now and
  // its remote is being read from git itself.
  for (const repo of input.openRepos) {
    if (repo.remotes.some((remote) => sameRepo(remote, repoUrl))) {
      return { localState: "local", localPath: repo.path };
    }
  }

  // Then the cache, which is what lets a second window offer Open rather than
  // a duplicate Clone. Validated on every use: a folder the user moved or
  // deleted must degrade, never produce a dead action.
  const known = input.knownClones[projectId];
  if (known && input.folderExists(known)) {
    return { localState: "local", localPath: known };
  }

  return { localState: "remote-only" };
}

const STATE_RANK: Record<LocalState, number> = {
  local: 1,
  "remote-only": 2,
  "no-repo": 3,
};

/** Assigned work first, because scoping My Tasks to one project made this the
 *  only place a developer can see that another repository is waiting on them. */
function rank(row: ProjectRow): number {
  return row.taskCount > 0 ? 0 : STATE_RANK[row.localState];
}

function compareProjects(a: ProjectRow, b: ProjectRow): number {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  if (a.taskCount !== b.taskCount) return b.taskCount - a.taskCount;
  return a.projectName.localeCompare(b.projectName);
}

export function buildRoster(input: RosterInput): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [];
  for (const entry of input.entries) {
    const projects: ProjectRow[] = [];
    for (const project of entry.projects) {
      const repoUrl = safeRepoUrl(project.repo_url);
      const { localState, localPath } = localStateFor(project.id, repoUrl, input);
      projects.push({
        projectId: project.id,
        projectName: project.name,
        workspaceId: entry.workspace.id,
        workspaceName: entry.workspace.name,
        repoUrl,
        defaultBranch: project.repo_default_branch ?? null,
        lifecycleStatus: project.lifecycle_status,
        localState,
        localPath,
        taskCount: input.taskCounts[project.id] ?? 0,
      });
    }
    projects.sort(compareProjects);
    rows.push({
      workspaceId: entry.workspace.id,
      workspaceName: entry.workspace.name,
      projects,
      hasAssignedTasks: projects.some((p) => p.taskCount > 0),
    });
  }
  rows.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
  return rows;
}

/**
 * A clone this extension started, recorded before `git.clone` runs.
 *
 * `git.clone` usually opens the result in a NEW WINDOW, which is a different
 * extension host from the one that started it. This record is how the answer
 * the user already gave — "yes, this folder is that project" — survives the
 * jump. It lives in globalState because that is shared across windows;
 * workspaceState is not.
 */
export interface PendingClone {
  projectId: string;
  repoUrl: string;
  startedAt: number;
}

/** An abandoned clone must not silently link a folder days later, so the
 *  record expires rather than waiting forever for a match. */
export const PENDING_CLONE_TTL_MS = 60 * 60 * 1000;

export function pendingCloneMatches(
  pending: PendingClone | undefined,
  remotes: string[],
  now: number,
): boolean {
  if (!pending) return false;
  if (now - pending.startedAt > PENDING_CLONE_TTL_MS) return false;
  return remotes.some((remote) => sameRepo(remote, pending.repoUrl));
}

/** Every project the user could link a folder to. Projects with no usable
 *  repository are excluded: there is nothing to match a remote against, so
 *  offering them would be offering a guess. */
export function linkCandidatesFrom(rows: WorkspaceRow[]): ProjectCandidate[] {
  const out: ProjectCandidate[] = [];
  for (const workspace of rows) {
    for (const project of workspace.projects) {
      if (!project.repoUrl) continue;
      out.push({
        projectId: project.projectId,
        projectName: project.projectName,
        workspaceName: project.workspaceName,
        repoUrl: project.repoUrl,
      });
    }
  }
  return out;
}
