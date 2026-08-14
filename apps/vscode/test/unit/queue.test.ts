// Run:  node --test apps/vscode/test/unit/queue.test.ts
//
// Clock and id generator are injected, so no timers and no randomness here.

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_ATTEMPTS, StatusQueue, type QueueEntry } from "../../src/tasks/queue.ts";

function makeQueue(startAt = 1_000) {
  let saved: QueueEntry[] = [];
  let now = startAt;
  let seq = 0;
  const queue = new StatusQueue({
    load: async () => saved,
    save: async (entries) => {
      saved = entries;
    },
    now: () => now,
    newId: () => `id-${(seq += 1)}`,
  });
  return {
    queue,
    advance: (ms: number) => {
      now += ms;
    },
    saved: () => saved,
  };
}

test("persists an enqueued write", async () => {
  const { queue, saved } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });
  assert.equal(queue.size(), 1);
  assert.equal(saved()[0].taskId, "t1");
});

test("a second write for the same task supersedes the first", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "todo" });
  assert.equal(queue.size(), 1);
  assert.equal(queue.list()[0].status, "todo");
});

test("superseding keeps the artifact when the newer write carries none", async () => {
  const { queue } = makeQueue();
  const artifact = { commit_sha: "abc", uri: "git: x", kind: "code" as const };
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented", artifact });
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "in_progress" });
  assert.equal(queue.list()[0].artifact?.commit_sha, "abc");
});

test("the same task in two projects is two entries", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p1", taskId: "t1", status: "todo" });
  await queue.enqueue({ projectId: "p2", taskId: "t1", status: "todo" });
  assert.equal(queue.size(), 2);
});

test("a successful flush empties the queue", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });
  const result = await queue.flush(async () => undefined);
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(queue.size(), 0);
});

test("a failure backs off rather than retrying immediately", async () => {
  const { queue, advance } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });

  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("offline");
  };

  await queue.flush(failing);
  assert.equal(calls, 1);

  // Still inside the first backoff window: the entry must not be retried.
  await queue.flush(failing);
  assert.equal(calls, 1);

  advance(5_001);
  await queue.flush(failing);
  assert.equal(calls, 2);
});

test("parks an entry after the last attempt instead of looping forever", async () => {
  const { queue, advance } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });
  const failing = async () => {
    throw new Error("offline");
  };

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await queue.flush(failing);
    advance(600_000);
  }
  assert.equal(queue.parked().length, 1);

  let calls = 0;
  await queue.flush(async () => {
    calls += 1;
  });
  assert.equal(calls, 0, "a parked entry needs an explicit retry");
});

test("retryAll un-parks", async () => {
  const { queue, advance } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });
  const failing = async () => {
    throw new Error("offline");
  };
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await queue.flush(failing);
    advance(600_000);
  }

  await queue.retryAll();
  const result = await queue.flush(async () => undefined);
  assert.equal(result.sent, 1);
});

test("one failing entry does not block the others", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p1", taskId: "t1", status: "implemented" });
  await queue.enqueue({ projectId: "p2", taskId: "t2", status: "implemented" });

  const result = await queue.flush(async (entry) => {
    if (entry.projectId === "p1") throw new Error("unreachable");
  });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.equal(queue.size(), 1);
  assert.equal(queue.list()[0].projectId, "p1");
});

test("clear drops everything (sign-out must not leak writes to the next user)", async () => {
  const { queue, saved } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });
  await queue.clear();
  assert.equal(queue.size(), 0);
  assert.deepEqual(saved(), []);
});
