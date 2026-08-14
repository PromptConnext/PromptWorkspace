// Run:  node --test apps/vscode/test/unit/taskRefs.test.ts
//
// Pins the two edges ADR 0019 names in the engine's syncTasksFromGit — the
// three-digit-only regex, and the fact that widening it is not enough because
// the cloud's feature_tag is zero-padded and the commit subject usually is not.

import test from "node:test";
import assert from "node:assert/strict";

import {
  collidingRefs,
  normalizeTaskRef,
  taskRefFromFeatureTag,
  taskRefsInSubject,
} from "../../src/git/taskRefs.ts";

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
