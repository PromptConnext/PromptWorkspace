// Run:  node --test apps/vscode/test/unit/roster.test.ts
//
// Everything the Projects view decides lives here, because the unit runner has
// no editor host and a TreeDataProvider cannot be reached from it. The rules
// under test are the ones a wrong answer makes expensive: offering Clone for a
// project with no repository, offering Open for a folder that is gone, and
// letting a hostile repo_url reach the UI at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PENDING_CLONE_TTL_MS,
  buildRoster,
  linkCandidatesFrom,
  pendingCloneMatches,
  safeRepoUrl,
  type RosterInput,
} from "../../src/projects/roster.ts";

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
        // Tie-breaker: two remote-only projects with taskCount 0, names out of order.
        project({ id: "remote-tie1", name: "Zulu", repo_url: "https://github.com/acme/zulu.git" }),
        project({ id: "remote-tie2", name: "Alpha", repo_url: "https://github.com/acme/alpha-remote.git" }),
        project({ id: "local", name: "Design", repo_url: "https://github.com/acme/design.git" }),
        project({ id: "mine1", name: "Zebra", repo_url: "https://github.com/acme/zebra.git" }),
        project({ id: "mine3", name: "Alpha", repo_url: "https://github.com/acme/alpha.git" }),
        // Tie-breaker: two assigned projects with same taskCount, names out of order.
        project({ id: "mine-tie2", name: "Yankee", repo_url: "https://github.com/acme/yankee.git" }),
        project({ id: "mine-tie1", name: "Bravo", repo_url: "https://github.com/acme/bravo.git" }),
      ],
    },
  ];
  const [ws] = buildRoster(
    input({
      entries,
      knownClones: { local: "/src/design" },
      taskCounts: { mine1: 1, mine3: 3, "mine-tie1": 2, "mine-tie2": 2 },
    }),
  );
  assert.deepEqual(
    ws.projects.map((p) => p.projectId),
    // Order: assigned by count desc (3, 2, 2, 1), local (1), remote-only by name asc, no-repo
    ["mine3", "mine-tie1", "mine-tie2", "mine1", "local", "remote-tie2", "remote-tie1", "no-repo"],
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
