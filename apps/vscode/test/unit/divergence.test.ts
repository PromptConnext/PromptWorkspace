// Run:  node --test apps/vscode/test/unit/divergence.test.ts
//
// Finding #41: the first scan on a branch named `T1-…` attributed every commit
// on it to T1 — including the import and seed commits it had inherited from
// main — so T1's evidence was an unrelated commit. Branch attribution now stops
// at the merge-base with the default branch.

import test from "node:test";
import assert from "node:assert/strict";

import {
  attributeCommits,
  commitsSinceDivergence,
  mergeBaseCandidates,
} from "../../src/git/divergence.ts";

const c = (sha: string, subject = `work ${sha}`) => ({ sha, subject });

test("history already on main is never attributed to a task branch", () => {
  // Newest first, as the git log returns it. `base` is main's tip, where the
  // branch was cut; `seed` and `import` are main's own history.
  const log = [c("b2"), c("b1"), c("base"), c("seed", "Seed repository"), c("import")];
  assert.deepEqual(commitsSinceDivergence(log, "base").map((x) => x.sha), ["b2", "b1"]);

  const attributed = attributeCommits(log, "T1", "base");
  assert.deepEqual(
    attributed.filter((a) => a.refs.length > 0).map((a) => a.commit.sha),
    ["b1", "b2"],
  );
  // A fresh branch with nothing of its own attributes nothing at all.
  assert.deepEqual(
    attributeCommits([c("base"), c("seed"), c("import")], "T1", "base").filter(
      (a) => a.refs.length > 0,
    ),
    [],
  );
});

test("a branch created at HEAD attributes its new commits", () => {
  const log = [c("n1"), c("head"), c("older")];
  const attributed = attributeCommits(log, "T14", "head");
  assert.deepEqual(
    attributed.map((a) => [a.commit.sha, a.refs]),
    [
      ["older", []],
      ["head", []],
      ["n1", ["T14"]],
    ],
  );
});

test("a subject ref is honoured anywhere; only the branch fallback stops at the branch point", () => {
  const log = [c("b1"), c("base"), c("m1", "T7: fix on main")];
  const refs = Object.fromEntries(
    attributeCommits(log, "T1", "base").map((a) => [a.commit.sha, a.refs]),
  );
  assert.deepEqual(refs, { m1: ["T7"], base: [], b1: ["T1"] });
});

test("with no merge-base the old behaviour stands", () => {
  // getMergeBase missing (a fork's git API) or no default branch to compare
  // with: every fresh commit may use the branch ref, as before.
  const log = [c("b1"), c("m1")];
  assert.deepEqual(
    attributeCommits(log, "T1", undefined).map((a) => a.refs),
    [["T1"], ["T1"]],
  );
  // A merge-base older than the page: everything on the page is the branch's.
  assert.deepEqual(commitsSinceDivergence(log, "far-back").map((x) => x.sha), ["b1", "m1"]);
});

test("merge-base is taken against origin's default branch first, then the upstream's, then the local one", () => {
  // A fork remote's `main` can be weeks stale; measuring against it would put
  // the branch point back in old history and bring #41 back.
  assert.deepEqual(mergeBaseCandidates("develop", "fork/T1-x"), [
    "origin/develop",
    "fork/develop",
    "develop",
  ]);
  assert.deepEqual(mergeBaseCandidates("main", "origin/T1-x"), ["origin/main", "main"]);
  assert.deepEqual(mergeBaseCandidates(null, undefined), [
    "origin/main",
    "main",
    "origin/master",
    "master",
  ]);
});
