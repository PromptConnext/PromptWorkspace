// Run:  node --test packages/pz-cloud/test/taskRefs.test.ts
//
// Pins the two edges ADR 0019 names in the engine's syncTasksFromGit — the
// three-digit-only regex, and the fact that widening it is not enough because
// the cloud's feature_tag is zero-padded and the commit subject usually is not.

import test from "node:test";
import assert from "node:assert/strict";

import {
  branchNameForTask,
  collidingRefs,
  isRevertSubject,
  normalizeTaskRef,
  refsForCommit,
  taskRefFromBranch,
  taskRefFromFeatureTag,
  taskRefsInSubject,
} from "../src/taskRefs.ts";

test("normalises padded and unpadded refs to the same key", () => {
  assert.equal(normalizeTaskRef("T001"), "T1");
  assert.equal(normalizeTaskRef("T1"), "T1");
  assert.equal(normalizeTaskRef("T0001"), "T1");
  assert.equal(normalizeTaskRef("T012"), "T12");
});

test("matches the two refs the engine's /\\bT\\d{3}\\b/ silently ignored", () => {
  assert.deepEqual(taskRefsInSubject("T12: add retry"), ["T12"]);
  assert.deepEqual(taskRefsInSubject("T0003: add retry"), ["T3"]);
});

test("a feature_tag with a parallel marker still resolves", () => {
  assert.equal(taskRefFromFeatureTag("T001 [P]"), "T1");
  assert.equal(taskRefFromFeatureTag(null), null);
  assert.equal(taskRefFromFeatureTag(""), null);
});

test("a commit may close several tasks, de-duplicated", () => {
  assert.deepEqual(taskRefsInSubject("T1 T002 T1: sweep"), ["T1", "T2"]);
});

test("caps refs per subject so a pathological message cannot fan out", () => {
  const subject = Array.from({ length: 30 }, (_, i) => `T${i + 1}`).join(" ");
  assert.equal(taskRefsInSubject(subject).length, 10);
});

test("a revert does not re-close the task it reverts", () => {
  assert.deepEqual(taskRefsInSubject('Revert "T1: add retry"'), []);
});

test("ignores refs that are not word-bounded task ids", () => {
  assert.deepEqual(taskRefsInSubject("CONNECT1 does not count"), []);
  assert.deepEqual(taskRefsInSubject("xT1 is not a ref"), []);
  assert.deepEqual(taskRefsInSubject("nothing here"), []);
});

test("reports refs two distinct tasks would collide on", () => {
  const collisions = collidingRefs(["T012", "T12", "T003"]);
  assert.ok(collisions.has("T12"));
  assert.equal(collisions.has("T3"), false);
});

test("no collision when tags are distinct", () => {
  assert.equal(collidingRefs(["T001", "T002", null]).size, 0);
});

// --------------------------------------------------------------- ADR 0022

test("a branch ref must be a whole segment, not a substring", () => {
  assert.equal(taskRefFromBranch("T12-add-retry"), "T12");
  assert.equal(taskRefFromBranch("feature/T012_retry"), "T12");
  assert.equal(taskRefFromBranch("T12"), "T12");
  // Lowercase is the same ref spelled differently, not a second vocabulary.
  assert.equal(taskRefFromBranch("t12-add-retry"), "T12");
  // The failures that matter: none of these name a task.
  assert.equal(taskRefFromBranch("TEST-12"), null);
  assert.equal(taskRefFromBranch("release/v1.2"), null);
  assert.equal(taskRefFromBranch("T12abc"), null);
  assert.equal(taskRefFromBranch("sprint12"), null);
  assert.equal(taskRefFromBranch(undefined), null);
});

test("the subject wins over the branch, and a branch alone still counts", () => {
  assert.deepEqual(refsForCommit("T5: unrelated fix", "T12"), ["T5"]);
  assert.deepEqual(refsForCommit("tidy up imports", "T12"), ["T12"]);
  assert.deepEqual(refsForCommit("tidy up imports", null), []);
  // A subject naming several tasks keeps naming several.
  assert.deepEqual(refsForCommit("T1 and T2: split", "T12"), ["T1", "T2"]);
});

test("a revert closes nothing, including on the task's own branch", () => {
  // The branch fallback is exactly where this could have regressed: a revert
  // made while sitting on T12's branch must not re-close T12.
  assert.deepEqual(refsForCommit('Revert "T12: add retry"', "T12"), []);
  assert.equal(isRevertSubject('Revert "T12: add retry"'), true);
  assert.equal(isRevertSubject("T12: add retry"), false);
});

test("the offered branch name is a legal ref and keeps the task number", () => {
  assert.equal(
    branchNameForTask("T12", "Add a retry to the uploader"),
    "T12-add-a-retry-to-the-uploader",
  );
  // Punctuation collapses rather than producing `..`, a trailing dot, or any
  // of the other sequences git rejects.
  assert.equal(branchNameForTask("T3", "Fix: the  parser... again!"), "T3-fix-the-parser-again");
  // A title that survives none of that still leaves a usable branch.
  assert.equal(branchNameForTask("T7", "！？"), "T7");
  // Long titles are cut without leaving a trailing separator.
  const long = branchNameForTask("T1", "a".repeat(80));
  assert.ok(long.length <= 44, long);
  assert.ok(!long.endsWith("-"), long);
  // And the round trip holds: what startTask writes, the watcher reads back.
  assert.equal(taskRefFromBranch(branchNameForTask("T012", "Add retry")), "T12");
});
