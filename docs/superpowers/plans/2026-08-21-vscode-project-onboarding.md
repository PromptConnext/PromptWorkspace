# VS Code Project Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer sign in to the PromptConnext VS Code extension, browse the workspaces and projects they belong to, clone a project that is not on their machine yet, and land in a window scoped to that project's tasks and coding rules.

**Architecture:** A new Projects tree view (workspace node → project node) backed by two cloud reads that already exist. Every project row's local state — cloned, not cloned, no repository yet — is *derived* at render time from open git remotes plus a `knownClones` map, never stored as truth. Cloning delegates to the built-in Git extension's `git.clone` command; because that opens a new window, the project link is carried across the jump by a short-lived `pendingClone` record in globalState. My Tasks and Project Context stop reading `workspaceFolders[0]` and read the *active project* instead.

**Tech Stack:** TypeScript run natively on Node 24 (no build step for tests), esbuild for the VSIX bundle, VS Code extension API ^1.85.0, the built-in `vscode.git` extension behind the existing vendored `git.d.ts` wrapper, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-21-vscode-project-onboarding-design.md`

## Global Constraints

- **No new runtime dependencies.** `apps/vscode/package.json` has `devDependencies` only, and it stays that way.
- **No sidecar, no spawned process, no local server** (ADR 0019). Cloning goes through a VS Code command, never a `git` subprocess of ours.
- **Pure modules must not `import * as vscode`.** The unit runner has no editor host. Anything holding logic worth testing goes in a vscode-free file; vscode-facing files stay as thin wrappers with no logic.
- **Never feature-detect with `typeof vscode.`** — `apps/vscode/scripts/check-feature-detection.mjs` runs as `pretest` and fails the build on it. Detect by invoking and inspecting the result.
- **Every `repo_url` from the cloud passes `assertCloneableRepoUrl` / `isCloneableRepoUrl` before it is rendered, compared, or handed to git.** A failing URL degrades the row to `no-repo`; it never reaches `git.clone`.
- **`engines.vscode` stays `^1.85.0`.** Do not raise it; do not use API newer than that floor.
- **Task `acceptance_criteria` stays `{text: string}[]`.** Do not flatten it anywhere.
- **Comment style is prose-forward** — full sentences explaining *why*, matching the surrounding files. Match the density of the file you are editing.
- **`vscode.git` is only ever imported by `src/git/gitBridge.ts`.** No feature code touches `git.d.ts`.
- Commands to know:
  - Full test suite: `pnpm --dir apps/vscode test`
  - One test file: `node --test apps/vscode/test/unit/<name>.test.ts`
  - Typecheck: `pnpm --dir apps/vscode typecheck`
  - Bundle: `pnpm --dir apps/vscode build`

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/vscode/src/projects/roster.ts` | All roster logic, vscode-free: URL guarding, local-state derivation, sort order, pending-clone matching, link-candidate mapping. |
| `apps/vscode/src/projects/rosterStore.ts` | Cache-first, coalesced, never-rejecting store for workspaces + their projects. vscode-free (own listener set, injected cache). |
| `apps/vscode/src/projects/rosterTree.ts` | `TreeDataProvider` for the Projects view. Rendering only. |
| `apps/vscode/src/projects/cloneProject.ts` | Guard the URL, detect `git.clone`, write `pendingClone`, invoke. |
| `apps/vscode/src/projects/knownClones.ts` | Read/write the projectId → path map and the `pendingClone` record in globalState. Thin. |
| `apps/vscode/src/link/activeProject.ts` | "Which project am I in?" — one answer, two consumers. |
| `apps/vscode/test/unit/roster.test.ts` | Tests for `roster.ts`. |
| `apps/vscode/test/unit/rosterStore.test.ts` | Tests for `rosterStore.ts`. |

**Modified**

| File | Change |
|---|---|
| `apps/vscode/src/cloud/types.ts` | Add `Workspace`, `CloudProject`. |
| `apps/vscode/src/cloud/client.ts` | Add `listWorkspaces()`, `listWorkspaceProjects()`. |
| `apps/vscode/src/storage/cache.ts` | Add `roster` to `CACHE_FILES`. |
| `apps/vscode/src/link/projectLink.ts` | Candidates come from the roster; add silent pending-clone linking. |
| `apps/vscode/src/tasks/treeProvider.ts` | Flat, scoped to the active project. |
| `apps/vscode/src/context/contextView.ts` | Read the active project's folder, not `workspaceFolders[0]`. |
| `apps/vscode/src/extension.ts` | Wire everything; extend sign-out scrubbing. |
| `apps/vscode/package.json` | New view, commands, menus, welcome contents. |
| `apps/vscode/README.md`, `apps/vscode/CHANGELOG.md` | Document the flow. |

---

### Task 1: Cloud types and the two roster reads

**Files:**
- Modify: `apps/vscode/src/cloud/types.ts` (append after `AssignedTask`)
- Modify: `apps/vscode/src/cloud/client.ts:213-217` (the `// ---- reads` section, after `listAssignedTasks`)
- Test: `apps/vscode/test/unit/client.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface Workspace { id: string; name: string }`
  - `interface CloudProject { id: string; name: string; workspace_id: string; repo_url?: string | null; repo_default_branch?: string | null; lifecycle_status: LifecycleStatus }`
  - `type LifecycleStatus = "planning" | "pending_tech_review" | "tech_review" | "repo_created"`
  - `CloudClient.listWorkspaces(): Promise<Workspace[]>`
  - `CloudClient.listWorkspaceProjects(workspaceId: string): Promise<CloudProject[]>`

- [ ] **Step 1: Write the failing test**

Append to `apps/vscode/test/unit/client.test.ts`. Read the top of that file first — it already has a helper for building a client with a fake `fetch`; reuse it exactly rather than inventing a second one. If the helper is named differently from `makeClient` below, use the existing name.

```ts
test("reads the workspace roster from the two membership-gated routes", async () => {
  const calls: string[] = [];
  const { client } = makeClient({
    fetch: async (url: string) => {
      calls.push(url);
      const body = url.endsWith("/workspaces")
        ? [{ id: "w1", name: "Acme Corp" }]
        : [{ id: "p1", name: "Checkout API", workspace_id: "w1", repo_url: null, lifecycle_status: "planning" }];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });

  assert.deepEqual(await client.listWorkspaces(), [{ id: "w1", name: "Acme Corp" }]);
  const projects = await client.listWorkspaceProjects("w1");
  assert.equal(projects[0].name, "Checkout API");
  assert.deepEqual(calls, [
    "https://cloud.test/workspaces",
    "https://cloud.test/workspaces/w1/projects",
  ]);
});

test("a workspace id is escaped into the projects path", async () => {
  const calls: string[] = [];
  const { client } = makeClient({
    fetch: async (url: string) => {
      calls.push(url);
      return new Response("[]", { status: 200 });
    },
  });
  await client.listWorkspaceProjects("a b/c");
  assert.deepEqual(calls, ["https://cloud.test/workspaces/a%20b%2Fc/projects"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/vscode/test/unit/client.test.ts`
Expected: FAIL — `client.listWorkspaces is not a function`.

- [ ] **Step 3: Add the types**

Append to `apps/vscode/src/cloud/types.ts`:

```ts
/** The cloud Planner's project lifecycle. Only `repo_created` guarantees a
 *  `repo_url`; every earlier state is a project that exists but has nothing to
 *  clone yet, which the Projects view has to render rather than hide. */
export type LifecycleStatus =
  | "planning"
  | "pending_tech_review"
  | "tech_review"
  | "repo_created";

/** Just enough of apps/cloud's Workspace to name it in a tree. */
export interface Workspace {
  id: string;
  name: string;
}

/** Deliberately a subset of apps/cloud's `Project`. The cloud row also carries
 *  stage state, policy scope and deployment config; none of that is rendered
 *  here, and naming a field we do not use is an invitation to start using it. */
export interface CloudProject {
  id: string;
  name: string;
  workspace_id: string;
  repo_url?: string | null;
  repo_default_branch?: string | null;
  lifecycle_status: LifecycleStatus;
}
```

- [ ] **Step 4: Add the two reads**

In `apps/vscode/src/cloud/client.ts`, extend the type import at the top to include `CloudProject` and `Workspace`, then add to the `// ---- reads` section, directly after `listAssignedTasks`:

```ts
  /** Every workspace the caller is a member of. The cloud auto-provisions a
   *  personal workspace on a first resolve with zero memberships (ADR 0015),
   *  so an empty array here means a real failure, not a new account. */
  listWorkspaces(): Promise<Workspace[]> {
    return this.cloudFetch<Workspace[]>("/workspaces");
  }

  /** Membership-gated on the cloud side by `require_workspace`, so a 403 here
   *  is a revoked membership and must drop that one workspace, never the tree. */
  listWorkspaceProjects(workspaceId: string): Promise<CloudProject[]> {
    return this.cloudFetch<CloudProject[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/projects`,
    );
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test apps/vscode/test/unit/client.test.ts` → Expected: PASS
Run: `pnpm --dir apps/vscode typecheck` → Expected: no output, exit 0

- [ ] **Step 6: Commit**

```bash
git add apps/vscode/src/cloud/types.ts apps/vscode/src/cloud/client.ts apps/vscode/test/unit/client.test.ts
git commit -m "feat(vscode): read the workspace and project roster from the cloud"
```

---

### Task 2: The pure roster module — guard, local state, sort

**Files:**
- Create: `apps/vscode/src/projects/roster.ts`
- Test: `apps/vscode/test/unit/roster.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `CloudProject` (Task 1); `isCloneableRepoUrl`, `sameRepo` from `src/link/repoUrl.ts`.
- Produces:
  - `type LocalState = "local" | "remote-only" | "no-repo"`
  - `interface LocalRepoRef { path: string; remotes: string[] }`
  - `interface RosterEntry { workspace: Workspace; projects: CloudProject[] }`
  - `interface ProjectRow { projectId, projectName, workspaceId, workspaceName, repoUrl: string | null, defaultBranch: string | null, lifecycleStatus, localState, localPath?: string, taskCount: number }`
  - `interface WorkspaceRow { workspaceId, workspaceName, projects: ProjectRow[], hasAssignedTasks: boolean }`
  - `function safeRepoUrl(url: string | null | undefined): string | null`
  - `function buildRoster(input: RosterInput): WorkspaceRow[]`
  - `interface RosterInput { entries: RosterEntry[]; openRepos: LocalRepoRef[]; knownClones: Record<string, string>; taskCounts: Record<string, number>; folderExists: (path: string) => boolean }`

- [ ] **Step 1: Write the failing test**

Create `apps/vscode/test/unit/roster.test.ts`:

```ts
// Run:  node --test apps/vscode/test/unit/roster.test.ts
//
// Everything the Projects view decides lives here, because the unit runner has
// no editor host and a TreeDataProvider cannot be reached from it. The rules
// under test are the ones a wrong answer makes expensive: offering Clone for a
// project with no repository, offering Open for a folder that is gone, and
// letting a hostile repo_url reach the UI at all.

import test from "node:test";
import assert from "node:assert/strict";

import { buildRoster, safeRepoUrl, type RosterInput } from "../../src/projects/roster.ts";

const WS = { id: "w1", name: "Acme Corp" };

function project(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Checkout API",
    workspace_id: "w1",
    repo_url: "https://github.com/acme/checkout.git",
    repo_default_branch: "main",
    lifecycle_status: "repo_created" as const,
    ...over,
  };
}

function input(over: Partial<RosterInput> = {}): RosterInput {
  return {
    entries: [{ workspace: WS, projects: [project()] }],
    openRepos: [],
    knownClones: {},
    taskCounts: {},
    folderExists: () => true,
    ...over,
  };
}

test("a project with no repo_url is no-repo, and carries no URL to act on", () => {
  const [ws] = buildRoster(
    input({ entries: [{ workspace: WS, projects: [project({ repo_url: null, lifecycle_status: "planning" })] }] }),
  );
  assert.equal(ws.projects[0].localState, "no-repo");
  assert.equal(ws.projects[0].repoUrl, null);
});

test("a repo_url that fails the clone guard degrades to no-repo", () => {
  for (const hostile of ["ext::sh -c 'touch /tmp/pwned'", "file:///etc/passwd", "-u./payload"]) {
    const [ws] = buildRoster(
      input({ entries: [{ workspace: WS, projects: [project({ repo_url: hostile })] }] }),
    );
    assert.equal(ws.projects[0].localState, "no-repo", hostile);
    assert.equal(ws.projects[0].repoUrl, null, hostile);
  }
});

test("an open folder's SSH remote matches an https repo_url", () => {
  const [ws] = buildRoster(
    input({ openRepos: [{ path: "/src/checkout", remotes: ["git@github.com:acme/checkout.git"] }] }),
  );
  assert.equal(ws.projects[0].localState, "local");
  assert.equal(ws.projects[0].localPath, "/src/checkout");
});

test("a knownClones entry makes a project local even with nothing open", () => {
  const [ws] = buildRoster(input({ knownClones: { p1: "/src/checkout" } }));
  assert.equal(ws.projects[0].localState, "local");
  assert.equal(ws.projects[0].localPath, "/src/checkout");
});

test("a knownClones entry pointing at a vanished folder degrades to remote-only", () => {
  const [ws] = buildRoster(
    input({ knownClones: { p1: "/src/gone" }, folderExists: () => false }),
  );
  assert.equal(ws.projects[0].localState, "remote-only");
  assert.equal(ws.projects[0].localPath, undefined);
});

test("mine first by count, then local, then remote-only, then no-repo, name breaking ties", () => {
  const entries = [
    {
      workspace: WS,
      projects: [
        project({ id: "no-repo", name: "Marketing", repo_url: null, lifecycle_status: "planning" }),
        project({ id: "remote", name: "Billing", repo_url: "https://github.com/acme/billing.git" }),
        project({ id: "local", name: "Design", repo_url: "https://github.com/acme/design.git" }),
        project({ id: "mine1", name: "Zebra", repo_url: "https://github.com/acme/zebra.git" }),
        project({ id: "mine3", name: "Alpha", repo_url: "https://github.com/acme/alpha.git" }),
      ],
    },
  ];
  const [ws] = buildRoster(
    input({
      entries,
      knownClones: { local: "/src/design" },
      taskCounts: { mine1: 1, mine3: 3 },
    }),
  );
  assert.deepEqual(
    ws.projects.map((p) => p.projectId),
    ["mine3", "mine1", "local", "remote", "no-repo"],
  );
});

test("a workspace holding assigned work is flagged, so the tree can auto-expand it", () => {
  const [quiet] = buildRoster(input());
  assert.equal(quiet.hasAssignedTasks, false);
  const [busy] = buildRoster(input({ taskCounts: { p1: 2 } }));
  assert.equal(busy.hasAssignedTasks, true);
});

test("workspaces are ordered by name", () => {
  const rows = buildRoster(
    input({
      entries: [
        { workspace: { id: "w2", name: "Zeta" }, projects: [] },
        { workspace: WS, projects: [] },
      ],
    }),
  );
  assert.deepEqual(rows.map((w) => w.workspaceName), ["Acme Corp", "Zeta"]);
});

test("safeRepoUrl is the single gate: it returns null rather than throwing", () => {
  assert.equal(safeRepoUrl("https://github.com/acme/app.git"), "https://github.com/acme/app.git");
  assert.equal(safeRepoUrl("ext::sh -c 'x'"), null);
  assert.equal(safeRepoUrl(null), null);
  assert.equal(safeRepoUrl(undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/vscode/test/unit/roster.test.ts`
Expected: FAIL — cannot find module `../../src/projects/roster.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/vscode/src/projects/roster.ts`:

```ts
// What the Projects view knows, decided here rather than in the tree.
//
// Two rules shape this file. A project's local state is DERIVED at render time
// from git remotes and a path cache — never stored as truth — because the only
// thing that can be authoritative about a clone is the disk. And a repo_url
// that arrives from the cloud is untrusted input: it passes the clone guard
// before it is rendered, compared or handed to git, so a hostile URL cannot
// reach the UI, let alone a git process.

import { isCloneableRepoUrl, sameRepo } from "../link/repoUrl.ts";
import type { CloudProject, LifecycleStatus, Workspace } from "../cloud/types.ts";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/vscode/test/unit/roster.test.ts` → Expected: PASS, 9 tests
Run: `pnpm --dir apps/vscode typecheck` → Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add apps/vscode/src/projects/roster.ts apps/vscode/test/unit/roster.test.ts
git commit -m "feat(vscode): derive project local state and roster ordering"
```

---

### Task 3: The pending-clone seam

**Files:**
- Modify: `apps/vscode/src/projects/roster.ts` (append)
- Test: `apps/vscode/test/unit/roster.test.ts` (append)

**Interfaces:**
- Consumes: `sameRepo` (already imported in `roster.ts` by Task 2).
- Produces:
  - `interface PendingClone { projectId: string; repoUrl: string; startedAt: number }`
  - `const PENDING_CLONE_TTL_MS = 3_600_000`
  - `function pendingCloneMatches(pending: PendingClone | undefined, remotes: string[], now: number): boolean`
  - `function linkCandidatesFrom(rows: WorkspaceRow[]): ProjectCandidate[]` where `ProjectCandidate` is imported from `../link/projectLink.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/vscode/test/unit/roster.test.ts`. Extend the existing import at the top of the file rather than adding a second one from the same module:

```ts
import {
  PENDING_CLONE_TTL_MS,
  buildRoster,
  linkCandidatesFrom,
  pendingCloneMatches,
  safeRepoUrl,
  type RosterInput,
} from "../../src/projects/roster.ts";
```

Then append the tests:

```ts
const NOW = 1_700_000_000_000;
const pending = {
  projectId: "p1",
  repoUrl: "https://github.com/acme/checkout.git",
  startedAt: NOW,
};

test("a clone we started links silently when the new folder's remote matches", () => {
  assert.equal(pendingCloneMatches(pending, ["git@github.com:acme/checkout.git"], NOW + 5_000), true);
});

test("a pending clone older than the TTL is ignored", () => {
  assert.equal(
    pendingCloneMatches(pending, ["https://github.com/acme/checkout.git"], NOW + PENDING_CLONE_TTL_MS + 1),
    false,
  );
});

test("a folder matching no pending clone is not linked silently", () => {
  assert.equal(pendingCloneMatches(pending, ["https://github.com/acme/other.git"], NOW), false);
  assert.equal(pendingCloneMatches(undefined, ["https://github.com/acme/checkout.git"], NOW), false);
  assert.equal(pendingCloneMatches(pending, [], NOW), false);
});

test("link candidates carry every project with a usable repo, not just assigned ones", () => {
  const rows = buildRoster(
    input({
      entries: [
        {
          workspace: WS,
          projects: [
            project(),
            project({ id: "p2", name: "Marketing", repo_url: null, lifecycle_status: "planning" }),
          ],
        },
      ],
    }),
  );
  const candidates = linkCandidatesFrom(rows);
  assert.deepEqual(candidates.map((c) => c.projectId), ["p1"]);
  assert.equal(candidates[0].projectName, "Checkout API");
  assert.equal(candidates[0].workspaceName, "Acme Corp");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/vscode/test/unit/roster.test.ts`
Expected: FAIL — `pendingCloneMatches` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/vscode/src/projects/roster.ts`, and add `import type { ProjectCandidate } from "../link/projectLink.ts";` to its imports:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/vscode/test/unit/roster.test.ts` → Expected: PASS, 13 tests
Run: `pnpm --dir apps/vscode typecheck` → Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add apps/vscode/src/projects/roster.ts apps/vscode/test/unit/roster.test.ts
git commit -m "feat(vscode): carry a clone's project link across the new-window jump"
```

---

### Task 4: The roster store, its cache file, and sign-out scrubbing

**Files:**
- Modify: `apps/vscode/src/storage/cache.ts:69-75` (the `CACHE_FILES` object)
- Create: `apps/vscode/src/projects/rosterStore.ts`
- Test: `apps/vscode/test/unit/rosterStore.test.ts`

**Interfaces:**
- Consumes: `CloudClient.listWorkspaces` / `listWorkspaceProjects` (Task 1), `RosterEntry` (Task 2), `JsonCache`, `CACHE_FILES`.
- Produces:
  - `class RosterStore` with `all(): RosterEntry[]`, `loadFromCache(): Promise<void>`, `refresh(): Promise<void>`, `refreshOnFocus(): Promise<void>`, `clear(): Promise<void>`, `onDidChange(listener: () => void): { dispose(): void }`, `get lastRefreshError(): string | null`, `get refreshedAt(): number`.

Note the deliberate difference from `TaskStore`: this store owns a plain listener set instead of a `vscode.EventEmitter`, which is what keeps the file importable by `node --test`. `TaskStore` is not refactored to match — that is unrelated churn.

- [ ] **Step 1: Write the failing test**

Create `apps/vscode/test/unit/rosterStore.test.ts`:

```ts
// Run:  node --test apps/vscode/test/unit/rosterStore.test.ts
//
// The contract copied from TaskStore, and the two things that are new: one
// workspace failing must not empty the tree (a revoked membership is a 403 on
// exactly one route), and sign-out must scrub the file — workspace and project
// names are the previous user's data.

import test from "node:test";
import assert from "node:assert/strict";

import { JsonCache, CACHE_FILES, type FileStoreLike } from "../../src/storage/cache.ts";
import { RosterStore } from "../../src/projects/rosterStore.ts";

function memoryStore() {
  const files = new Map<string, string>();
  const store: FileStoreLike = {
    async read(name) {
      return files.get(name);
    },
    async write(name, contents) {
      files.set(name, contents);
    },
    async delete(name) {
      files.delete(name);
    },
  };
  return { store, files };
}

const silentLog = { info() {}, warn() {}, error() {} };

function fakeClient(over: Partial<{
  listWorkspaces: () => Promise<unknown>;
  listWorkspaceProjects: (id: string) => Promise<unknown>;
}> = {}) {
  return {
    listWorkspaces: over.listWorkspaces ?? (async () => [{ id: "w1", name: "Acme" }]),
    listWorkspaceProjects:
      over.listWorkspaceProjects ??
      (async (id: string) => [
        { id: `${id}-p1`, name: "Checkout", workspace_id: id, repo_url: null, lifecycle_status: "planning" },
      ]),
  } as never;
}

test("a refresh stores workspaces with their projects and notifies", async () => {
  const { store } = memoryStore();
  const roster = new RosterStore(fakeClient(), new JsonCache(store), silentLog);
  let fired = 0;
  roster.onDidChange(() => (fired += 1));

  await roster.refresh();

  assert.equal(roster.all().length, 1);
  assert.equal(roster.all()[0].workspace.name, "Acme");
  assert.equal(roster.all()[0].projects[0].name, "Checkout");
  assert.equal(roster.lastRefreshError, null);
  assert.ok(fired > 0);
});

test("the cache paints before the cloud answers", async () => {
  const { store, files } = memoryStore();
  const roster = new RosterStore(fakeClient(), new JsonCache(store), silentLog);
  await roster.refresh();
  assert.ok(files.has(CACHE_FILES.roster));

  const second = new RosterStore(fakeClient(), new JsonCache(store), silentLog);
  await second.loadFromCache();
  assert.equal(second.all()[0].workspace.name, "Acme");
});

test("a failing refresh keeps the cache and records why, rather than throwing", async () => {
  const { store } = memoryStore();
  const roster = new RosterStore(fakeClient(), new JsonCache(store), silentLog);
  await roster.refresh();

  const offline = new RosterStore(
    fakeClient({ listWorkspaces: async () => { throw new Error("offline"); } }),
    new JsonCache(store),
    silentLog,
  );
  await offline.loadFromCache();
  await offline.refresh();

  assert.equal(offline.all().length, 1, "cache survives");
  assert.match(offline.lastRefreshError ?? "", /offline/);
});

test("one workspace failing drops that workspace, not the tree", async () => {
  const { store } = memoryStore();
  const roster = new RosterStore(
    fakeClient({
      listWorkspaces: async () => [
        { id: "w1", name: "Acme" },
        { id: "w2", name: "Revoked" },
      ],
      listWorkspaceProjects: async (id: string) => {
        if (id === "w2") throw new Error("cloud HTTP 403");
        return [];
      },
    }),
    new JsonCache(store),
    silentLog,
  );

  await roster.refresh();

  assert.deepEqual(roster.all().map((e) => e.workspace.id), ["w1"]);
  assert.equal(roster.lastRefreshError, null, "a partial roster is not an offline roster");
});

test("clear drops everything (sign-out must not leak the previous user's projects)", async () => {
  const { store, files } = memoryStore();
  const roster = new RosterStore(fakeClient(), new JsonCache(store), silentLog);
  await roster.refresh();

  await roster.clear();

  assert.deepEqual(roster.all(), []);
  assert.equal(files.has(CACHE_FILES.roster), false);
});

test("concurrent refreshes are coalesced into one round of requests", async () => {
  let calls = 0;
  const { store } = memoryStore();
  const roster = new RosterStore(
    fakeClient({
      listWorkspaces: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return [{ id: "w1", name: "Acme" }];
      },
    }),
    new JsonCache(store),
    silentLog,
  );

  await Promise.all([roster.refresh(), roster.refresh(), roster.refresh()]);

  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/vscode/test/unit/rosterStore.test.ts`
Expected: FAIL — cannot find module `../../src/projects/rosterStore.ts`.

- [ ] **Step 3: Add the cache file name**

In `apps/vscode/src/storage/cache.ts`, extend `CACHE_FILES`:

```ts
export const CACHE_FILES = {
  tasks: "tasks.json",
  queue: "queue.json",
  gitState: "git-state.json",
  roster: "roster.json",
} as const;
```

`ALL_CACHE_FILES` already derives from it, so nothing else changes here.

- [ ] **Step 4: Write the store**

Create `apps/vscode/src/projects/rosterStore.ts`:

```ts
// Workspaces and their projects: cache for instant paint, cloud for truth.
//
// The contract is TaskStore's, deliberately — the two stores back sibling views
// and an inconsistency between them would show as one view claiming to be
// offline while the other silently disagrees. Refresh never rejects, records
// its failure instead, and keeps whatever it had.
//
// One difference: this file owns a plain listener set rather than a
// vscode.EventEmitter, which is what lets `node --test` import it with no
// editor host. TaskStore is not being retrofitted to match; that is unrelated.

import type { CloudClient, LoggerLike } from "../cloud/client.ts";
import { CACHE_FILES, type JsonCache } from "../storage/cache.ts";
import type { RosterEntry } from "./roster.ts";

const FOCUS_REFRESH_THROTTLE_MS = 60_000;

export class RosterStore {
  private entries: RosterEntry[] = [];
  private lastRefreshedAt = 0;
  private lastError: string | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  private readonly client: CloudClient;
  private readonly cache: JsonCache;
  private readonly log: LoggerLike;

  constructor(client: CloudClient, cache: JsonCache, log: LoggerLike) {
    this.client = client;
    this.cache = cache;
    this.log = log;
  }

  all(): RosterEntry[] {
    return this.entries;
  }

  get lastRefreshError(): string | null {
    return this.lastError;
  }

  get refreshedAt(): number {
    return this.lastRefreshedAt;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async loadFromCache(): Promise<void> {
    const cached = await this.cache.read<RosterEntry[]>(CACHE_FILES.roster);
    if (cached && this.entries.length === 0) {
      this.entries = cached;
      this.emit();
    }
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async refreshOnFocus(): Promise<void> {
    if (Date.now() - this.lastRefreshedAt < FOCUS_REFRESH_THROTTLE_MS) return;
    await this.refresh();
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.lastRefreshedAt = 0;
    this.lastError = null;
    await this.cache.clear([CACHE_FILES.roster]);
    this.emit();
  }

  private async doRefresh(): Promise<void> {
    try {
      const workspaces = await this.client.listWorkspaces();
      // allSettled, not all: `require_workspace` answers 403 for a membership
      // revoked mid-session, and that is one workspace disappearing — not the
      // roster failing. A rejected member is dropped and logged.
      const settled = await Promise.allSettled(
        workspaces.map(async (workspace) => ({
          workspace,
          projects: await this.client.listWorkspaceProjects(workspace.id),
        })),
      );
      const entries: RosterEntry[] = [];
      settled.forEach((result, i) => {
        if (result.status === "fulfilled") {
          entries.push(result.value);
        } else {
          this.log.warn(
            `roster: dropping workspace ${workspaces[i].id}: ${String(result.reason)}`,
          );
        }
      });
      this.entries = entries;
      this.lastRefreshedAt = Date.now();
      this.lastError = null;
      await this.cache.write(CACHE_FILES.roster, this.entries);
      this.emit();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.info(`roster refresh failed, keeping cache: ${String(err)}`);
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test apps/vscode/test/unit/rosterStore.test.ts` → Expected: PASS, 6 tests
Run: `pnpm --dir apps/vscode test` → Expected: all files pass, `pretest` grep clean
Run: `pnpm --dir apps/vscode typecheck` → Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add apps/vscode/src/storage/cache.ts apps/vscode/src/projects/rosterStore.ts apps/vscode/test/unit/rosterStore.test.ts
git commit -m "feat(vscode): cache-first roster store with per-workspace failure isolation"
```

---

### Task 5: globalState helpers for knownClones and pendingClone

**Files:**
- Create: `apps/vscode/src/projects/knownClones.ts`

**Interfaces:**
- Consumes: `PendingClone` (Task 3); `StorageLike` from `src/cloud/session.ts`.
- Produces:
  - `const KNOWN_CLONES_KEY = "promptconnext.knownClones"`
  - `const PENDING_CLONE_KEY = "promptconnext.pendingClone"`
  - `function readKnownClones(state: StorageLike): Record<string, string>`
  - `function rememberClone(state: StorageLike, projectId: string, path: string): Promise<void>`
  - `function readPendingClone(state: StorageLike): PendingClone | undefined`
  - `function writePendingClone(state: StorageLike, pending: PendingClone | undefined): Promise<void>`
  - `function clearCloneState(state: StorageLike): Promise<void>`

This task has no test of its own: every function is a two-line Memento read or write with no branching worth asserting, and `StorageLike` is already exercised through `SessionStore`. Its behavior is covered where it matters — the silent-link path in Task 8.

- [ ] **Step 1: Write the implementation**

Create `apps/vscode/src/projects/knownClones.ts`:

```ts
// Two small pieces of cross-window state, both in globalState.
//
// globalState and not workspaceState, for the same reason in both cases: the
// window that starts a clone is not the window that receives it. Neither value
// is a secret — a project id and a folder path — so SecretStorage would be the
// wrong home and would cost a Linux keyring gap for nothing.
//
// Both are caches. A knownClones entry is validated against the disk before it
// is believed (see roster.ts), and a pendingClone expires. Losing either costs
// a duplicate Clone offer, never correctness.

import type { StorageLike } from "../cloud/session.ts";
import type { PendingClone } from "./roster.ts";

export const KNOWN_CLONES_KEY = "promptconnext.knownClones";
export const PENDING_CLONE_KEY = "promptconnext.pendingClone";

export function readKnownClones(state: StorageLike): Record<string, string> {
  return state.get<Record<string, string>>(KNOWN_CLONES_KEY) ?? {};
}

export async function rememberClone(
  state: StorageLike,
  projectId: string,
  path: string,
): Promise<void> {
  await state.update(KNOWN_CLONES_KEY, { ...readKnownClones(state), [projectId]: path });
}

export function readPendingClone(state: StorageLike): PendingClone | undefined {
  return state.get<PendingClone>(PENDING_CLONE_KEY);
}

export async function writePendingClone(
  state: StorageLike,
  pending: PendingClone | undefined,
): Promise<void> {
  await state.update(PENDING_CLONE_KEY, pending);
}

/** Sign-out. The path map names another account's machine layout and the
 *  pending record names another account's project; neither may survive into
 *  the next session. */
export async function clearCloneState(state: StorageLike): Promise<void> {
  await state.update(KNOWN_CLONES_KEY, undefined);
  await state.update(PENDING_CLONE_KEY, undefined);
}
```

- [ ] **Step 2: Verify it compiles and the suite is still green**

Run: `pnpm --dir apps/vscode typecheck` → Expected: exit 0
Run: `pnpm --dir apps/vscode test` → Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/vscode/src/projects/knownClones.ts
git commit -m "feat(vscode): cross-window storage for known clones and pending clones"
```

---

### Task 6: The active project, and scoping the two existing views to it

**Files:**
- Create: `apps/vscode/src/link/activeProject.ts`
- Modify: `apps/vscode/src/tasks/treeProvider.ts` (whole file)
- Modify: `apps/vscode/src/context/contextView.ts:52-66` (`render`) and `:36-44` (the `open` message handler)
- Modify: `apps/vscode/src/extension.ts` (tree construction, context key, reactions)

**Interfaces:**
- Consumes: `projectIdFor` from `src/config.ts`; `TaskStore`.
- Produces:
  - `interface ActiveProject { projectId: string; folder: vscode.WorkspaceFolder }`
  - `function activeProject(): ActiveProject | undefined`
  - `TaskTreeProvider` constructor becomes `(store: TaskStore, active: () => ActiveProject | undefined)`
  - `ContextViewProvider` constructor becomes `(extensionUri, docs, active: () => ActiveProject | undefined)`
  - `TreeNode` narrows to `TaskNode` only — `ProjectNode` is deleted.

There is no unit test here: every line touches `vscode`, which the host-free runner cannot load. The gate is typecheck, bundle, the existing suite staying green, and the manual Extension Host checklist in Step 6. Do not fake a test by mocking the whole `vscode` module — the repo has no such harness and adding one for three files is a bigger change than the change.

- [ ] **Step 1: Write the active-project resolver**

Create `apps/vscode/src/link/activeProject.ts`:

```ts
// Which project am I in?
//
// Asked by both the task tree and the context webview, and answered here once
// so the two cannot disagree — a sidebar showing project A's tasks above
// project B's coding rules is worse than either being empty.
//
// The answer follows the editor rather than any stored selection. That is the
// whole design: a stored "active project" can drift out of step with the folder
// you are typing in, and there is no way for the user to notice until it has
// misled them. Switching projects is opening a file in the other folder, which
// is a gesture VS Code already owns.

import * as vscode from "vscode";
import { projectIdFor } from "../config.ts";

export interface ActiveProject {
  projectId: string;
  folder: vscode.WorkspaceFolder;
}

export function activeProject(): ActiveProject | undefined {
  const open = vscode.window.activeTextEditor?.document.uri;
  if (open) {
    const folder = vscode.workspace.getWorkspaceFolder(open);
    const projectId = folder ? projectIdFor(folder.uri) : undefined;
    if (folder && projectId) return { projectId, folder };
  }
  // No editor, or an editor outside any linked folder (an output pane, a file
  // opened from disk): fall back to the first linked folder, which in a
  // single-root window is the only one there is.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const projectId = projectIdFor(folder.uri);
    if (projectId) return { projectId, folder };
  }
  return undefined;
}
```

- [ ] **Step 2: Flatten and scope the task tree**

Replace `apps/vscode/src/tasks/treeProvider.ts` entirely:

```ts
// The task tree: the active project's tasks, with a checkbox per task.
//
// It used to group by project, because it rendered every assigned task across
// every project. It no longer does: the tree is scoped to the project the
// editor is in, so a project node would be a permanent single-child parent —
// a click to open something that is already open. The project's identity moved
// to the view description, where it is visible without expanding anything.
//
// TreeItem.checkboxState is stable since VS Code 1.80 and is the natural
// affordance for "done", which is why engines.vscode floors at 1.85.

import * as vscode from "vscode";
import type { AssignedTask } from "../cloud/types.ts";
import { TASK_STATUS_LABELS, isClosed } from "../cloud/types.ts";
import type { ActiveProject } from "../link/activeProject.ts";
import type { TaskStore } from "./taskStore.ts";

export class TaskNode {
  readonly kind = "task";
  readonly entry: AssignedTask;

  constructor(entry: AssignedTask) {
    this.entry = entry;
  }
}

export type TreeNode = TaskNode;

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly store: TaskStore;
  private readonly active: () => ActiveProject | undefined;

  constructor(store: TaskStore, active: () => ActiveProject | undefined) {
    this.store = store;
    this.active = active;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const { task } = node.entry;
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${task.id}`;
    item.description = [task.feature_tag, TASK_STATUS_LABELS[task.status]]
      .filter(Boolean)
      .join(" · ");
    item.contextValue = "promptconnext.task";
    item.checkboxState = isClosed(task.status)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.tooltip = this.tooltip(node.entry);
    item.command = {
      command: "promptconnext.copyTaskContext",
      title: "Copy Task Context",
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return [];
    const current = this.active();
    if (!current) return [];
    return this.store.forProject(current.projectId).map((entry) => new TaskNode(entry));
  }

  private tooltip(entry: AssignedTask): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.task.title}**\n\n`);
    md.appendMarkdown(`${entry.project_name} · ${entry.workspace_name}\n\n`);
    md.appendMarkdown(`Status: ${TASK_STATUS_LABELS[entry.task.status]}\n\n`);
    // `criterion.text` — the shape apps/cloud stores and warns against
    // flattening. Read the field; never assume a bare string.
    if (entry.task.acceptance_criteria.length > 0) {
      md.appendMarkdown("Acceptance criteria:\n");
      for (const criterion of entry.task.acceptance_criteria) {
        md.appendMarkdown(`- ${criterion.text}\n`);
      }
    }
    return md;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
```

- [ ] **Step 3: Point the context webview at the active project's folder**

In `apps/vscode/src/context/contextView.ts`:

Add the import and constructor parameter:

```ts
import type { ActiveProject } from "../link/activeProject.ts";
```

```ts
  private readonly extensionUri: vscode.Uri;
  private readonly docs: RepoDocs;
  private readonly active: () => ActiveProject | undefined;

  constructor(
    extensionUri: vscode.Uri,
    docs: RepoDocs,
    active: () => ActiveProject | undefined,
  ) {
    this.extensionUri = extensionUri;
    this.docs = docs;
    this.active = active;
  }
```

Replace the body of `render()` down to the `this.watch(folder)` line:

```ts
  async render(): Promise<void> {
    if (!this.view) return;
    const current = this.active();
    if (!current) {
      this.view.webview.html = this.page(
        "<p class='empty'>Open a project folder to see its coding rules.</p>",
      );
      return;
    }
    const folder = current.folder.uri;
    const docs = await this.docs.readAll(folder);
    const drifted = await this.docs.constitutionDrifted(current.projectId, folder);
    this.view.webview.html = this.page(this.body(docs, drifted));
    this.watch(current.folder);
  }
```

And in the `onDidReceiveMessage` handler, replace `vscode.workspace.workspaceFolders?.[0]` with the active project's folder — this is the multi-root bug the spec calls out, where Open in editor opens the wrong repository's file:

```ts
      if (msg.type === "open" && msg.path) {
        const current = this.active();
        if (!current) return;
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(current.folder.uri, msg.path),
        );
        await vscode.window.showTextDocument(doc, { preview: true });
      }
```

- [ ] **Step 4: Rewire `extension.ts`**

Three edits.

Construct the two providers with the resolver, and drop the now-deleted `ProjectNode` import:

```ts
import { TaskTreeProvider, type TreeNode } from "./tasks/treeProvider.ts";
import { activeProject, type ActiveProject } from "./link/activeProject.ts";
```

```ts
  const tree = new TaskTreeProvider(store, activeProject);
  const contextView = new ContextViewProvider(context.extensionUri, docs, activeProject);
```

Replace `showTitle` so the description names the scope. An empty tree that does not say *which* project it is empty for is the failure this prevents:

```ts
  const setActiveProjectContext = (active: ActiveProject | undefined) =>
    vscode.commands.executeCommand(
      "setContext",
      "promptconnext.hasActiveProject",
      active !== undefined,
    );

  const showTitle = () => {
    const current = session.read();
    if (!current) {
      treeView.description = undefined;
      return;
    }
    const active = activeProject();
    const project = active
      ? store.forProject(active.projectId)[0]?.project_name ?? "this project"
      : undefined;
    if (store.lastRefreshError) {
      treeView.description = project ? `${project} · offline` : "offline";
      return;
    }
    const at = store.refreshedAt;
    const when = at ? `updated ${new Date(at).toLocaleTimeString()}` : undefined;
    treeView.description = [project, when].filter(Boolean).join(" · ") || undefined;
  };
```

Note the account no longer appears in the description — the project does. Sign-out is still discoverable from the view title menu, and *who am I* moves to the Projects view in Task 7.

Add the editor reaction, so switching files switches scope:

```ts
    vscode.window.onDidChangeActiveTextEditor(async () => {
      const active = activeProject();
      await setActiveProjectContext(active);
      tree.refresh();
      showTitle();
      await contextView.render();
    }),
```

And at start-up, next to `await setSignedInContext(...)`:

```ts
  await setActiveProjectContext(activeProject());
```

Finally, delete the two dead helpers at the bottom of `extension.ts`. `nodeTarget()` and `pickProject()` both branch on a `"project"` node kind that no longer exists, and `pickProject` derives a project list from tasks — the job the roster now does. `openProjectInWeb` loses its node argument and reads the active project instead, which is also what makes it correct from the welcome view, where there was never a node to right-click:

```ts
    vscode.commands.registerCommand("promptconnext.openProjectInWeb", async () => {
      const { webUrl } = readConfig();
      if (!webUrl) {
        void vscode.window.showErrorMessage(
          "Set promptconnext.cloudWebUrl before opening the web app.",
        );
        return;
      }
      const active = activeProject();
      const entry = active ? store.forProject(active.projectId)[0] : undefined;
      // With no project in view, the web root is the workspace list, which is
      // a useful answer rather than a failure.
      const path = entry ? `/w/${entry.workspace_id}/p/${entry.project_id}` : "";
      await vscode.env.openExternal(vscode.Uri.parse(`${webUrl}${path}`));
    }),
```

Remove the `WebTarget` interface, `nodeTarget` and `pickProject` along with the now-unused `AssignedTask` import. Task 7 re-registers a node-aware version of this command for the Projects view; until then the palette and welcome entries are the only callers, and both are node-free.

- [ ] **Step 5: Verify**

Run: `pnpm --dir apps/vscode typecheck` → Expected: exit 0
Run: `pnpm --dir apps/vscode test` → Expected: PASS
Run: `pnpm --dir apps/vscode build` → Expected: bundle written, exit 0

- [ ] **Step 6: Manual check in the Extension Host**

Press F5 in `apps/vscode`. In the Extension Development Host:
1. Open a folder that has `promptconnext.projectId` set in `.vscode/settings.json`. My Tasks lists that project's tasks with no project parent row, and the view description names the project.
2. Add a second folder to the workspace (multi-root) that is *not* linked. Open a file in it. My Tasks stays on the linked project (the fallback), and Project Context still shows the linked folder's rules.
3. Link the second folder to a different project, open a file in each in turn: both views follow the editor.
4. Confirm Project Context's "Open in editor" opens the file from the *active* folder, not always the first one.

- [ ] **Step 7: Commit**

```bash
git add apps/vscode/src/link/activeProject.ts apps/vscode/src/tasks/treeProvider.ts apps/vscode/src/context/contextView.ts apps/vscode/src/extension.ts
git commit -m "feat(vscode): scope tasks and context to the active project

Also fixes the multi-root bug where Project Context rendered and opened
files from workspaceFolders[0] regardless of which repository the editor
was in."
```

---

### Task 7: The Projects view

**Files:**
- Create: `apps/vscode/src/projects/rosterTree.ts`
- Modify: `apps/vscode/package.json` (`views`, `viewsWelcome`, `commands`, `menus`)
- Modify: `apps/vscode/src/extension.ts` (construct and register)

**Interfaces:**
- Consumes: `RosterStore` (Task 4), `buildRoster` / `WorkspaceRow` / `ProjectRow` (Task 2), `readKnownClones` (Task 5), `GitBridge`, `TaskStore`.
- Produces:
  - `class RosterTreeProvider implements vscode.TreeDataProvider<RosterNode>` with `refresh(): void`, `rows(): WorkspaceRow[]` (Task 8 builds link candidates from it), `dispose(): void`
  - `class WorkspaceTreeNode { kind: "workspace"; row: WorkspaceRow }`
  - `class ProjectTreeNode { kind: "project"; row: ProjectRow }`
  - `type RosterNode = WorkspaceTreeNode | ProjectTreeNode`
  - Commands: `promptconnext.refreshProjects`, `promptconnext.openProjectFolder`

- [ ] **Step 1: Write the tree provider**

Create `apps/vscode/src/projects/rosterTree.ts`:

```ts
// The Projects view: workspaces over projects, with the local state of each
// project written into the row rather than hidden behind a click.
//
// Selecting a workspace is expanding it. That is the whole mechanism, and it is
// deliberate: a workspace picker implies a stored selection, and a stored
// selection can be stale, can survive a membership change, and can disagree
// with the folder the developer has open. A collapsible node holds no state.

import * as vscode from "vscode";
import { existsSync } from "node:fs";
import type { GitBridge } from "../git/gitBridge.ts";
import type { TaskStore } from "../tasks/taskStore.ts";
import { buildRoster, type ProjectRow, type WorkspaceRow } from "./roster.ts";
import { readKnownClones } from "./knownClones.ts";
import type { StorageLike } from "../cloud/session.ts";
import type { RosterStore } from "./rosterStore.ts";

export class WorkspaceTreeNode {
  readonly kind = "workspace";
  readonly row: WorkspaceRow;
  constructor(row: WorkspaceRow) {
    this.row = row;
  }
}

export class ProjectTreeNode {
  readonly kind = "project";
  readonly row: ProjectRow;
  constructor(row: ProjectRow) {
    this.row = row;
  }
}

export type RosterNode = WorkspaceTreeNode | ProjectTreeNode;

const STATE_ICON: Record<ProjectRow["localState"], string> = {
  local: "repo",
  "remote-only": "cloud-download",
  "no-repo": "circle-slash",
};

const STATE_TEXT: Record<ProjectRow["localState"], string> = {
  local: "cloned",
  "remote-only": "not cloned",
  "no-repo": "no repo yet",
};

export class RosterTreeProvider implements vscode.TreeDataProvider<RosterNode> {
  private readonly emitter = new vscode.EventEmitter<RosterNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly roster: RosterStore;
  private readonly tasks: TaskStore;
  private readonly git: GitBridge;
  private readonly state: StorageLike;

  constructor(roster: RosterStore, tasks: TaskStore, git: GitBridge, state: StorageLike) {
    this.roster = roster;
    this.tasks = tasks;
    this.git = git;
    this.state = state;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** Rebuilt on every read rather than memoised: the inputs are open git
   *  remotes and a task list that both change under us, and the cost is a sort
   *  over a handful of rows. */
  rows(): WorkspaceRow[] {
    const taskCounts: Record<string, number> = {};
    for (const entry of this.tasks.all()) {
      taskCounts[entry.project_id] = (taskCounts[entry.project_id] ?? 0) + 1;
    }
    return buildRoster({
      entries: this.roster.all(),
      openRepos: this.git.repositories().map((repo) => ({
        path: repo.root.fsPath,
        remotes: repo.remotes
          .map((r) => r.fetchUrl ?? r.pushUrl)
          .filter((u): u is string => Boolean(u)),
      })),
      knownClones: readKnownClones(this.state),
      taskCounts,
      // Sync existence check: the tree is built synchronously and this is a
      // stat on a path we wrote ourselves, not a directory walk. Imported at
      // the top of the file rather than `require`d here — esbuild's output
      // format is not something a call site should depend on.
      folderExists: (path) => {
        try {
          return existsSync(path);
        } catch {
          return false;
        }
      },
    });
  }

  getTreeItem(node: RosterNode): vscode.TreeItem {
    if (node.kind === "workspace") {
      const item = new vscode.TreeItem(
        node.row.workspaceName,
        // A workspace with work waiting should not need a click to reveal it,
        // and a lone workspace should never look like a folder to open.
        node.row.hasAssignedTasks
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `workspace:${node.row.workspaceId}`;
      item.contextValue = "promptconnext.workspace";
      item.iconPath = new vscode.ThemeIcon("organization");
      return item;
    }

    const { row } = node;
    const item = new vscode.TreeItem(row.projectName, vscode.TreeItemCollapsibleState.None);
    item.id = `project:${row.projectId}`;
    const tasks =
      row.taskCount === 1 ? "1 task" : row.taskCount > 1 ? `${row.taskCount} tasks` : undefined;
    const lifecycle = row.localState === "no-repo" ? row.lifecycleStatus.replace(/_/g, " ") : undefined;
    item.description = [tasks, lifecycle, STATE_TEXT[row.localState]].filter(Boolean).join(" · ");
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[row.localState]);
    // The context value IS the action: package.json binds Clone to
    // remote-only, Open to local, and web-only to no-repo, so a row can never
    // offer an action its state cannot honour.
    item.contextValue = `promptconnext.project.${row.localState}`;
    item.tooltip = this.tooltip(row);
    return item;
  }

  getChildren(node?: RosterNode): RosterNode[] {
    if (!node) return this.rows().map((row) => new WorkspaceTreeNode(row));
    if (node.kind === "workspace") {
      return node.row.projects.map((row) => new ProjectTreeNode(row));
    }
    return [];
  }

  private tooltip(row: ProjectRow): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${row.projectName}**\n\n${row.workspaceName}\n\n`);
    if (row.localPath) md.appendMarkdown(`Cloned to \`${row.localPath}\`\n\n`);
    // Rendered as code, never as a link: this string came from the cloud and
    // markdown link syntax in a name is not something to hand a click to.
    if (row.repoUrl) md.appendMarkdown(`\`${row.repoUrl}\`\n\n`);
    if (row.localState === "no-repo") {
      md.appendMarkdown("No repository yet — this project is still being planned.");
    }
    return md;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
```

- [ ] **Step 2: Contribute the view and its commands**

In `apps/vscode/package.json`, put the new view **first** in the `promptconnext` container so a new user lands on it:

```json
      "promptconnext": [
        {
          "id": "promptconnext.projects",
          "name": "Projects"
        },
        {
          "id": "promptconnext.tasks",
          "name": "My Tasks"
        },
        {
          "id": "promptconnext.context",
          "name": "Project Context",
          "type": "webview"
        }
      ]
```

Replace `viewsWelcome` entirely:

```json
    "viewsWelcome": [
      {
        "view": "promptconnext.projects",
        "when": "!promptconnext.signedIn",
        "contents": "Sign in to see your workspaces and projects.\n[Sign in](command:promptconnext.signIn)\n\nAlready have a code from the browser?\n[Paste a sign-in code](command:promptconnext.signInWithCode)"
      },
      {
        "view": "promptconnext.projects",
        "when": "promptconnext.signedIn",
        "contents": "No workspaces yet.\n[Refresh](command:promptconnext.refreshProjects)\n\nWorkspaces and projects are created in the web app.\n[Open the web app](command:promptconnext.openProjectInWeb)"
      },
      {
        "view": "promptconnext.tasks",
        "when": "!promptconnext.signedIn",
        "contents": "Sign in to see the tasks assigned to you.\n[Sign in](command:promptconnext.signIn)\n\nAlready have a code from the browser?\n[Paste a sign-in code](command:promptconnext.signInWithCode)"
      },
      {
        "view": "promptconnext.tasks",
        "when": "promptconnext.signedIn && !promptconnext.hasActiveProject",
        "contents": "This folder is not linked to a PromptConnext project yet.\n\nPick a project to clone or open in the Projects view above, or link the folder you already have.\n[Link This Folder to a Project…](command:promptconnext.linkProject)"
      },
      {
        "view": "promptconnext.tasks",
        "when": "promptconnext.signedIn && promptconnext.hasActiveProject",
        "contents": "No tasks are assigned to you in this project.\n[Refresh](command:promptconnext.refreshTasks)\n\nPlan and assign work in the web app.\n[Open the web app](command:promptconnext.openProjectInWeb)"
      }
    ]
```

Add three commands to `contributes.commands`:

```json
      {
        "command": "promptconnext.refreshProjects",
        "title": "Refresh Projects",
        "category": "PromptConnext",
        "icon": "$(refresh)"
      },
      {
        "command": "promptconnext.cloneProject",
        "title": "Clone Repository",
        "category": "PromptConnext",
        "icon": "$(repo-clone)"
      },
      {
        "command": "promptconnext.openProjectFolder",
        "title": "Open Project Folder",
        "category": "PromptConnext",
        "icon": "$(folder-opened)"
      }
```

In `contributes.menus`, add to `view/title`:

```json
        {
          "command": "promptconnext.refreshProjects",
          "when": "view == promptconnext.projects",
          "group": "navigation"
        },
        {
          "command": "promptconnext.signIn",
          "when": "view == promptconnext.projects && !promptconnext.signedIn",
          "group": "1_account@1"
        },
        {
          "command": "promptconnext.signOut",
          "when": "view == promptconnext.projects && promptconnext.signedIn",
          "group": "1_account@1"
        },
        {
          "command": "promptconnext.showLog",
          "when": "view == promptconnext.projects",
          "group": "9_diagnostics@1"
        }
```

Replace the two `viewItem == promptconnext.project` entries in `view/item/context` (they referenced the deleted project node in the task tree) with state-bound rows in the new view:

```json
        {
          "command": "promptconnext.cloneProject",
          "when": "view == promptconnext.projects && viewItem == promptconnext.project.remote-only",
          "group": "inline"
        },
        {
          "command": "promptconnext.openProjectFolder",
          "when": "view == promptconnext.projects && viewItem == promptconnext.project.local",
          "group": "inline"
        },
        {
          "command": "promptconnext.openProjectInWeb",
          "when": "view == promptconnext.projects && viewItem =~ /^promptconnext\\.project\\./",
          "group": "inline"
        },
        {
          "command": "promptconnext.openProjectInWeb",
          "when": "view == promptconnext.projects && viewItem =~ /^promptconnext\\.project\\./",
          "group": "1_open@1"
        },
        {
          "command": "promptconnext.linkProject",
          "when": "view == promptconnext.projects && viewItem == promptconnext.project.remote-only",
          "group": "1_open@2"
        }
```

And in `commandPalette`, hide the two node-only commands:

```json
        {
          "command": "promptconnext.cloneProject",
          "when": "false"
        },
        {
          "command": "promptconnext.openProjectFolder",
          "when": "false"
        },
        {
          "command": "promptconnext.refreshProjects",
          "when": "promptconnext.signedIn"
        }
```

- [ ] **Step 3: Wire it up in `extension.ts`**

Construct the store and tree next to their task counterparts:

```ts
import { RosterStore } from "./projects/rosterStore.ts";
import { RosterTreeProvider, ProjectTreeNode, type RosterNode } from "./projects/rosterTree.ts";
```

```ts
  const roster = new RosterStore(client, cache, log);
  const rosterTree = new RosterTreeProvider(roster, store, git, context.globalState);
  const projectsView = vscode.window.createTreeView("promptconnext.projects", {
    treeDataProvider: rosterTree,
  });
  context.subscriptions.push(projectsView, rosterTree);
```

Add reactions — the roster changing repaints the tree, and so does the task list (task counts are part of a row) and any repository state change (a new remote changes local state):

```ts
    roster.onDidChange(() => {
      rosterTree.refresh();
      projectsView.description = describeRoster();
    }),
    git.onDidChangeRepositoryState(() => rosterTree.refresh()),
```

with, next to `showTitle`:

```ts
  // The Projects view carries the account, now that the task view's description
  // carries the project instead. Both also have to say when they last reached
  // the cloud, or a refresh that legitimately changes nothing looks broken.
  const describeRoster = () => {
    const current = session.read();
    if (!current) return undefined;
    const who = current.email ?? current.userId;
    if (roster.lastRefreshError) return `${who} · offline`;
    return roster.refreshedAt
      ? `${who} · updated ${new Date(roster.refreshedAt).toLocaleTimeString()}`
      : who;
  };
```

Extend the existing `store.onDidChange` reaction with `rosterTree.refresh()`, extend the `session.onDidChange` reaction so signing in refreshes the roster and signing out clears it, and extend the focus handler:

```ts
    session.onDidChange((current) => {
      void setSignedInContext(current !== null);
      showTitle();
      if (current) {
        void store.refresh().then(() => writer.flush());
        void roster.refresh();
      } else {
        void store.clear();
        void roster.clear();
        void clearCloneState(context.globalState);
        void queue.clear().then(refreshStatusBar);
      }
    }),
```

```ts
    vscode.window.onDidChangeWindowState(async (state) => {
      if (!state.focused) return;
      await store.refreshOnFocus();
      await roster.refreshOnFocus();
      await writer.flush();
    }),
```

Register the two new commands (clone lands in Task 8; register a placeholder-free version now that only handles Open and Refresh):

```ts
    vscode.commands.registerCommand("promptconnext.refreshProjects", async () => {
      await vscode.window.withProgress(
        { location: { viewId: "promptconnext.projects" } },
        () => roster.refresh(),
      );
      projectsView.description = describeRoster();
      const failure = roster.lastRefreshError;
      if (!failure) return;
      const choice = await vscode.window.showWarningMessage(
        `PromptConnext could not reach the cloud: ${failure}. Showing the projects it had.`,
        "Show Log",
      );
      if (choice === "Show Log") log.show();
    }),
    vscode.commands.registerCommand(
      "promptconnext.openProjectFolder",
      async (node?: RosterNode) => {
        if (!(node instanceof ProjectTreeNode) || !node.row.localPath) return;
        const uri = vscode.Uri.file(node.row.localPath);
        // Already open in this window: reveal rather than reopen, which would
        // throw away the user's editor layout to show them what they can see.
        const alreadyOpen = (vscode.workspace.workspaceFolders ?? []).some(
          (f) => f.uri.fsPath === uri.fsPath,
        );
        if (alreadyOpen) {
          await vscode.commands.executeCommand("revealInExplorer", uri);
          return;
        }
        await vscode.commands.executeCommand("vscode.openFolder", uri, {
          forceNewWindow: true,
        });
      },
    ),
```

Task 6 reduced `openProjectInWeb` to the active project, because there was no node to receive. Now there is, so replace that registration with a node-aware one — a right-click on a project row must open *that* project, not whichever one the editor happens to be in:

```ts
    vscode.commands.registerCommand(
      "promptconnext.openProjectInWeb",
      async (node?: RosterNode) => {
        const { webUrl } = readConfig();
        if (!webUrl) {
          void vscode.window.showErrorMessage(
            "Set promptconnext.cloudWebUrl before opening the web app.",
          );
          return;
        }
        let path = "";
        if (node instanceof ProjectTreeNode) {
          path = `/w/${node.row.workspaceId}/p/${node.row.projectId}`;
        } else {
          const active = activeProject();
          const entry = active ? store.forProject(active.projectId)[0] : undefined;
          if (entry) path = `/w/${entry.workspace_id}/p/${entry.project_id}`;
        }
        await vscode.env.openExternal(vscode.Uri.parse(`${webUrl}${path}`));
      },
    ),
```

Add to start-up, after `await store.loadFromCache();`:

```ts
  await roster.loadFromCache();
  projectsView.description = describeRoster();
```

and inside the `if (session.read())` block, alongside the task refresh:

```ts
    await roster.refresh();
```

Add the import for `clearCloneState`:

```ts
import { clearCloneState } from "./projects/knownClones.ts";
```

- [ ] **Step 4: Verify**

Run: `pnpm --dir apps/vscode typecheck` → Expected: exit 0
Run: `pnpm --dir apps/vscode test` → Expected: PASS
Run: `pnpm --dir apps/vscode build` → Expected: exit 0

- [ ] **Step 5: Manual check in the Extension Host**

Press F5. Signed out: the Projects view offers sign-in. Signed in:
1. Workspaces appear, sorted by name; one holding assigned tasks is expanded.
2. A project you have tasks in sorts above one you do not, and shows `N tasks`.
3. A project whose repository is open in this window shows `cloned` with a repo icon and an **Open Project Folder** inline action.
4. A project with a repository you have not cloned shows `not cloned` with a **Clone Repository** action (which does nothing yet — Task 8).
5. A project still in planning shows `planning · no repo yet`, dimmed icon, and only **Open in the Web App**.
6. Sign out, then sign in as a different account: no project or workspace name from the first account survives.

- [ ] **Step 6: Commit**

```bash
git add apps/vscode/src/projects/rosterTree.ts apps/vscode/src/extension.ts apps/vscode/package.json
git commit -m "feat(vscode): browse workspaces and projects in a Projects view"
```

---

### Task 8: Clone, and the silent link when the clone lands

**Files:**
- Create: `apps/vscode/src/projects/cloneProject.ts`
- Modify: `apps/vscode/src/link/projectLink.ts` (candidate source + pending-clone linking)
- Modify: `apps/vscode/src/extension.ts` (command registration, link wiring, start-up)
- Modify: `apps/vscode/README.md`, `apps/vscode/CHANGELOG.md`
- Test: `apps/vscode/test/unit/roster.test.ts` — already covers the matching rules from Task 3; no new pure logic is added here.

**Interfaces:**
- Consumes: `safeRepoUrl`, `PendingClone`, `pendingCloneMatches`, `linkCandidatesFrom` (Tasks 2–3); `readPendingClone` / `writePendingClone` / `rememberClone` (Task 5); `ProjectLink`.
- Produces:
  - `function cloneProject(row: ProjectRow, state: StorageLike, log: LoggerLike): Promise<void>`
  - `ProjectLink.offerLinks(candidates: ProjectCandidate[]): Promise<void>` — signature changes from `(tasks: AssignedTask[])`
  - `ProjectLink.linkInteractively(candidates: ProjectCandidate[]): Promise<void>` — same change
  - `ProjectLink.applyPendingClone(state: StorageLike, candidates: ProjectCandidate[]): Promise<void>`

- [ ] **Step 1: Write the clone command**

Create `apps/vscode/src/projects/cloneProject.ts`:

```ts
// Clone, delegated.
//
// `git.clone` is the Git extension's own command: it owns the folder picker,
// the progress notification, credential prompts, and the "open the result
// where?" question. Reimplementing any of that would be reimplementing it
// worse, and a `git` subprocess of ours would be the sidecar ADR 0019 removed.
//
// It is a CONTRIBUTED COMMAND, not published API — the same stability class as
// the vendored git.d.ts. So it is detected by asking for the command list and
// looking, never by `typeof`, and its absence degrades to the clipboard.

import * as vscode from "vscode";
import type { LoggerLike } from "../cloud/client.ts";
import type { StorageLike } from "../cloud/session.ts";
import { writePendingClone } from "./knownClones.ts";
import { safeRepoUrl, type ProjectRow } from "./roster.ts";

export async function cloneProject(
  row: ProjectRow,
  state: StorageLike,
  log: LoggerLike,
): Promise<void> {
  // Guarded a second time at the point of use. The row was built from a guarded
  // URL, but this is the call that reaches git, and that is where the check has
  // to be true rather than have been true earlier.
  const url = safeRepoUrl(row.repoUrl);
  if (!url) {
    void vscode.window.showErrorMessage(
      `${row.projectName} has no repository that can be cloned.`,
    );
    return;
  }

  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes("git.clone")) {
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showWarningMessage(
      `This editor has no Git clone command. The repository URL for ${row.projectName} was copied to the clipboard.`,
    );
    log.warn("git.clone is unavailable; fell back to the clipboard");
    return;
  }

  // Written BEFORE the command runs: `git.clone` usually opens the result in a
  // new window, and once it does, this window may never see the folder at all.
  await writePendingClone(state, {
    projectId: row.projectId,
    repoUrl: url,
    startedAt: Date.now(),
  });
  log.info(`cloning ${row.projectName} (${row.projectId})`);
  await vscode.commands.executeCommand("git.clone", url);
}
```

- [ ] **Step 2: Move `ProjectLink` onto roster candidates and teach it the silent path**

In `apps/vscode/src/link/projectLink.ts`:

Update the header comment's first paragraph to record the change:

```ts
// Which cloud project does this folder belong to?
//
// Answer: a resource-scoped `promptconnext.projectId` setting, discovered by
// matching git remotes against the workspace roster, and written only after the
// user confirms — with one exception, `applyPendingClone`, where the user
// already confirmed by clicking Clone and a second prompt would be asking the
// same question twice.
//
// Candidates come from the roster rather than from assigned tasks, which is
// what lets a folder be linked to a project that has no work assigned to this
// developer yet.
```

Replace the imports of `AssignedTask` with the pending-clone helpers:

```ts
import type { StorageLike } from "../cloud/session.ts";
import { pendingCloneMatches, type PendingClone } from "../projects/roster.ts";
import { readPendingClone, rememberClone, writePendingClone } from "../projects/knownClones.ts";
```

Replace `candidatesFor` so it filters a candidate list instead of a task list:

```ts
  /** Candidates whose repo_url matches this folder's remotes. */
  candidatesFor(folder: vscode.Uri, candidates: ProjectCandidate[]): ProjectCandidate[] {
    const remotes = this.remotesFor(folder);
    if (remotes.length === 0) return [];
    return candidates.filter(
      (candidate) =>
        candidate.repoUrl != null &&
        isCloneableRepoUrl(candidate.repoUrl) &&
        remotes.some((remote) => sameRepo(remote, candidate.repoUrl)),
    );
  }

  private remotesFor(folder: vscode.Uri): string[] {
    const repo = this.git.repositoryFor(folder);
    if (!repo) return [];
    return repo.remotes
      .map((r) => r.fetchUrl ?? r.pushUrl)
      .filter((u): u is string => Boolean(u));
  }
```

Change `offerLinks` and `linkInteractively` to take `candidates: ProjectCandidate[]` directly. `offerLinks` keeps its body except for the `candidatesFor` call; `linkInteractively` loses its task-to-candidate loop and becomes:

```ts
  /** The explicit command: pick from every project in the roster. */
  async linkInteractively(candidates: ProjectCandidate[]): Promise<void> {
    const folder = await pickFolder();
    if (!folder) return;
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        "No PromptConnext projects with a repository to link to.",
      );
      return;
    }
    await this.pick(folder, candidates);
  }
```

Add the silent path:

```ts
  /**
   * Link a folder this extension just cloned, without asking again.
   *
   * The prompt `offerLinks` shows is the right default for a folder we merely
   * recognise. It is the wrong one here: the user clicked Clone on a named
   * project seconds ago, and asking "is this that project?" invites the answer
   * "why are you asking?". The record expires so an abandoned clone cannot
   * make this silent write happen days later.
   */
  async applyPendingClone(
    state: StorageLike,
    candidates: ProjectCandidate[],
  ): Promise<void> {
    const pending: PendingClone | undefined = readPendingClone(state);
    if (!pending) return;
    const now = Date.now();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (projectIdFor(folder.uri)) continue;
      if (!pendingCloneMatches(pending, this.remotesFor(folder.uri), now)) continue;
      const candidate = candidates.find((c) => c.projectId === pending.projectId);
      await setProjectId(folder, pending.projectId);
      await rememberClone(state, pending.projectId, folder.uri.fsPath);
      await writePendingClone(state, undefined);
      this.promptedFolders.add(folder.uri.toString());
      const name = candidate?.projectName ?? "the project you cloned";
      this.log.info(`pending clone linked ${folder.name} -> ${pending.projectId}`);
      void vscode.window.showInformationMessage(`Linked "${folder.name}" to ${name}.`);
      return;
    }
    // Expired records are dropped on sight so they cannot fire later.
    if (now - pending.startedAt > PENDING_CLONE_TTL_MS) {
      await writePendingClone(state, undefined);
    }
  }
```

(Add `PENDING_CLONE_TTL_MS` to the `roster.ts` import.)

Finally, in the private `link()` method, record the path so a future window can offer **Open** rather than a second **Clone**:

```ts
  private async link(
    folder: vscode.WorkspaceFolder,
    candidate: ProjectCandidate,
    state?: StorageLike,
  ): Promise<void> {
    await setProjectId(folder, candidate.projectId);
    if (state) await rememberClone(state, candidate.projectId, folder.uri.fsPath);
    this.log.info(`linked ${folder.name} -> ${candidate.projectId}`);
    void vscode.window.showInformationMessage(
      `Linked "${folder.name}" to ${candidate.projectName}.`,
    );
  }
```

Thread `state` through `pick()` and its two callers so every confirmed link records its path too.

- [ ] **Step 3: Wire the command and the start-up link**

In `apps/vscode/src/extension.ts`:

```ts
import { cloneProject } from "./projects/cloneProject.ts";
import { linkCandidatesFrom } from "./projects/roster.ts";
```

Replace the `link.offerLinks(store.all())` call inside the `store.onDidChange` reaction, and add the same to the roster reaction — candidates now come from the roster:

```ts
  const candidates = () => linkCandidatesFrom(rosterTree.rows());
```

```ts
    roster.onDidChange(() => {
      rosterTree.refresh();
      projectsView.description = describeRoster();
      void link.offerLinks(candidates());
    }),
```

and drop `void link.offerLinks(store.all())` from the task reaction, which was only ever a proxy for the roster.

Update the link command:

```ts
    vscode.commands.registerCommand("promptconnext.linkProject", () =>
      link.linkInteractively(candidates()),
    ),
```

Register clone:

```ts
    vscode.commands.registerCommand(
      "promptconnext.cloneProject",
      async (node?: RosterNode) => {
        if (!(node instanceof ProjectTreeNode)) return;
        await cloneProject(node.row, context.globalState, log);
      },
    ),
```

At start-up, after the roster has been loaded from cache — this is the step that makes the freshly cloned window link itself, and it must work with no network, which is why it runs off the cache rather than after the refresh:

```ts
  await roster.loadFromCache();
  await link.applyPendingClone(context.globalState, candidates());
```

- [ ] **Step 4: Verify**

Run: `pnpm --dir apps/vscode test` → Expected: PASS (the `pretest` grep must stay clean — `getCommands` is invoke-and-inspect)
Run: `pnpm --dir apps/vscode typecheck` → Expected: exit 0
Run: `pnpm --dir apps/vscode build` → Expected: exit 0

- [ ] **Step 5: Manual end-to-end check — this is the deliverable**

Press F5 with **no folder open**.
1. Sign in. The Projects view lists your workspaces.
2. Expand one, find a project showing `not cloned`, click **Clone Repository**.
3. VS Code's own folder picker appears; choose a parent folder. Progress is VS Code's.
4. Choose **Open** when it offers. In the new window: a notification says *Linked "<folder>" to <project>*, `.vscode/settings.json` has `promptconnext.projectId`, My Tasks shows that project's tasks, and Project Context shows the repository's `AGENTS.md`.
5. Back in the first window, Refresh Projects: that project now reads `cloned` and offers **Open Project Folder**.
6. Close the cloned window, reopen the first: the row still reads `cloned` — that is `knownClones` doing its job.
7. Move the cloned folder on disk, Refresh: the row degrades back to `not cloned`.
8. Sign out, sign in again: the row is `not cloned` and no path from the previous session survives.

- [ ] **Step 6: Document the flow**

In `apps/vscode/README.md`, replace the getting-started section so it describes: sign in → Projects view → expand a workspace → Clone or Open a project → My Tasks and Project Context follow the folder you are in. Note explicitly that My Tasks is scoped to the project of the folder you have open, and that the Projects view is where work waiting in another repository shows up.

In `apps/vscode/CHANGELOG.md`, add an `Unreleased` entry:

```markdown
## Unreleased

### Added
- **Projects view** — browse the workspaces and projects you belong to, and clone a project's repository without leaving the editor. Projects with tasks assigned to you sort first.
- Cloning a project links the resulting folder automatically; no confirmation prompt for a clone you started.

### Changed
- **My Tasks is now scoped to the project of the folder you have open**, rather than listing every assigned task across every project. Work waiting in another repository appears as a task count in the Projects view.

### Fixed
- Project Context rendered, watched and opened files from the first workspace folder in a multi-root window regardless of which repository the editor was in.
```

- [ ] **Step 7: Commit**

```bash
git add apps/vscode/src/projects/cloneProject.ts apps/vscode/src/link/projectLink.ts apps/vscode/src/extension.ts apps/vscode/README.md apps/vscode/CHANGELOG.md
git commit -m "feat(vscode): clone a project and link the clone automatically

Cloning delegates to vscode.git's git.clone command, which usually opens
the result in a new window. A short-lived pendingClone record in
globalState carries the project link across that jump, so the new window
links itself without asking a question the user already answered."
```

---

## Verification

After Task 8, from the repo root:

```bash
pnpm --dir apps/vscode test        # pretest grep + all unit tests
pnpm --dir apps/vscode typecheck   # the vendored git.d.ts drift tripwire
pnpm --dir apps/vscode build       # esbuild bundle
pnpm --dir apps/vscode package     # VSIX, from macOS or Linux only
```

The manual checklists in Tasks 6, 7 and 8 are part of the definition of done: three of the four behaviors this plan adds — cross-window linking, tree state after a folder moves, and scope following the editor — cannot be reached by a host-free unit runner, and claiming them green off a passing `node --test` would be claiming something the suite never ran.
