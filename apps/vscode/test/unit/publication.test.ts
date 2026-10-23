// Run:  node --test apps/vscode/test/unit/publication.test.ts
//
// ADR 0022's publication gate. The cases that matter are the two the ADR
// singles out as exact — "just pushed" and "fell off the log page" — plus the
// no-upstream fallback, which is the one that silently changes when tasks
// close if it is wrong.

import test from "node:test";
import assert from "node:assert/strict";

import { aheadOf, partitionByPublication, partitionWithHeld } from "../../src/git/publication.ts";

const sha = (s: string) => ({ sha: s });

test("ahead of zero publishes everything, whatever the log says", () => {
  const pending = [sha("a"), sha("b")];
  const { published, unpublished, dropped } = partitionByPublication(
    pending,
    [sha("b"), sha("a")],
    0,
  );
  assert.deepEqual(dropped, []);
  assert.deepEqual(
    published.map((p) => p.sha),
    ["a", "b"],
  );
  assert.deepEqual(unpublished, []);
});

test("the newest `ahead` commits are the unpublished ones", () => {
  // log is newest-first: d, c, b, a. Two ahead means d and c are local only.
  const log = [sha("d"), sha("c"), sha("b"), sha("a")];
  const { published, unpublished } = partitionByPublication(
    [sha("a"), sha("b"), sha("c"), sha("d")],
    log,
    2,
  );
  assert.deepEqual(
    published.map((p) => p.sha),
    ["a", "b"],
  );
  assert.deepEqual(
    unpublished.map((p) => p.sha),
    ["c", "d"],
  );
});

test("an amended-away commit is dropped, never published", () => {
  // The regression this guards: `stale` is absent from the log because the
  // developer amended it, not because it is old. Treating "absent" as
  // "published" would close a task from a commit that no longer exists.
  const { published, unpublished, dropped } = partitionByPublication(
    [sha("stale"), sha("amended")],
    [sha("amended"), sha("older")],
    1,
  );
  assert.deepEqual(published, []);
  assert.deepEqual(
    unpublished.map((p) => p.sha),
    ["amended"],
  );
  assert.deepEqual(
    dropped.map((p) => p.sha),
    ["stale"],
  );
});

test("no upstream means no gate — everything publishes, so the caller falls back", () => {
  const { published, unpublished } = partitionByPublication(
    [sha("a")],
    [sha("a")],
    undefined,
  );
  assert.deepEqual(
    published.map((p) => p.sha),
    ["a"],
  );
  assert.deepEqual(unpublished, []);
});

test("the partition carries the whole entry, not just the sha", () => {
  const entry = { sha: "a", subject: "T1: work", refs: ["T1"] };
  const { published } = partitionByPublication([entry], [], 0);
  assert.deepEqual(published[0], entry);
});

test("aheadOf reads a count only when a branch is tracked", () => {
  assert.equal(aheadOf(undefined), undefined);
  // A branch with no upstream reports whatever `ahead` was last computed;
  // reading it would strand every un-tracked branch as permanently pending.
  assert.equal(aheadOf({ ahead: 3 }), undefined);
  assert.equal(aheadOf({ upstream: "origin/T1", ahead: 3 }), 3);
  // Tracked, but the Git extension has not filled the count in yet.
  assert.equal(aheadOf({ upstream: "origin/main" }), 0);
});

test("a held commit is published even when it has fallen off the log page", () => {
  // Held = published once, close not written yet. With ahead > 0 the plain
  // partition would read "absent from the page" as rewritten-away and drop it.
  const pending = [{ sha: "old", held: true }, sha("new")];
  const { published, unpublished, dropped } = partitionWithHeld(
    pending,
    [sha("new"), sha("mid")], // "old" is far down the history
    1,
  );
  assert.deepEqual(published.map((p) => p.sha), ["old"]);
  assert.deepEqual(unpublished.map((p) => p.sha), ["new"]);
  assert.deepEqual(dropped, []);
});

test("without held entries partitionWithHeld is partitionByPublication", () => {
  const pending = [sha("a"), sha("gone")];
  const log = [sha("a")];
  assert.deepEqual(partitionWithHeld(pending, log, 1), partitionByPublication(pending, log, 1));
});

test("a held commit stays published with no upstream or nothing ahead", () => {
  const pending = [{ sha: "h", held: true }];
  assert.deepEqual(partitionWithHeld(pending, [], undefined).published, pending);
  assert.deepEqual(partitionWithHeld(pending, [], 0).published, pending);
});
