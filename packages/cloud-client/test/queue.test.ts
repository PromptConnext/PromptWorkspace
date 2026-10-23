// Run:  node --test packages/cloud-client/test/queue.test.ts
//
// Clock and id generator are injected, so no timers and no randomness here.

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_ATTEMPTS, StatusQueue, belongsTo, type QueueEntry } from "../src/queue.ts";

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

test("flush skips entries that belong to another environment", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "a", userId: "u1" });
  await queue.enqueue({ projectId: "p", taskId: "t2", status: "implemented", scope: "b", userId: "u1" });
  const seen: string[] = [];
  const result = await queue.flush(async (e) => {
    seen.push(e.taskId);
  }, belongsTo("a", "u1"));
  assert.deepEqual(seen, ["t1"]);
  assert.equal(result.sent, 1);
  assert.equal(queue.size(), 1);
  assert.equal(queue.list()[0].scope, "b");
  assert.equal(queue.list()[0].attempts, 0);
});

test("entries without an owner belong to every owner", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented" });
  const result = await queue.flush(async () => {}, belongsTo("a", "u1"));
  assert.equal(result.sent, 1);
  assert.equal(queue.size(), 0);
});

test("drop removes another user's entries and reports the count", async () => {
  const { queue, saved } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "a", userId: "u1" });
  await queue.enqueue({ projectId: "p", taskId: "t2", status: "implemented", scope: "b", userId: "u1" });
  const dropped = await queue.drop(
    (e) => e.scope === "a" && e.userId !== undefined && e.userId !== "u2",
  );
  assert.equal(dropped, 1);
  assert.equal(queue.size(), 1);
  assert.equal(saved()[0].scope, "b");
});

test("the same task on two environments queues twice", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "a" });
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "b" });
  assert.equal(queue.size(), 2);
});

test("count filters by owner", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "a", userId: "u1" });
  await queue.enqueue({ projectId: "p", taskId: "t2", status: "implemented", scope: "b", userId: "u1" });
  assert.equal(queue.count(), 2);
  assert.equal(queue.count(belongsTo("a", "u1")), 1);
});

/** Two windows over one queue file. The file holds JSON, as on disk, so
 *  neither queue can see the other's in-memory array. */
function twoWindowQueues() {
  let file = "[]";
  let seq = 0;
  const make = (name: string) =>
    new StatusQueue({
      load: async () => JSON.parse(file) as QueueEntry[],
      save: async (entries) => {
        file = JSON.stringify(entries);
      },
      now: () => 1_000,
      newId: () => `${name}-${(seq += 1)}`,
    });
  const a = make("a");
  const b = make("b");
  return { a, b, file: () => JSON.parse(file) as QueueEntry[] };
}

test("a drop in one window keeps an entry another window queued later", async () => {
  const { a, b, file } = twoWindowQueues();
  await b.load();
  await a.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "a", userId: "u1" });
  await b.drop((e) => e.scope === "b");
  assert.deepEqual(file().map((e) => e.taskId), ["t1"]);
});

test("a flush in one window keeps an entry another window queued later", async () => {
  const { a, b, file } = twoWindowQueues();
  await b.load();
  await a.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "a", userId: "u1" });
  await b.flush(async () => {}, belongsTo("b", "u1"));
  assert.deepEqual(file().map((e) => e.taskId), ["t1"]);
});

test("an enqueue in one window keeps an entry another window queued later", async () => {
  const { a, b, file } = twoWindowQueues();
  await b.load();
  await a.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "a" });
  await b.enqueue({ projectId: "p", taskId: "t2", status: "implemented", scope: "b" });
  assert.deepEqual(file().map((e) => e.taskId).sort(), ["t1", "t2"]);
});

test("an entry queued while a flush is in flight survives the flush", async () => {
  const { a, b, file } = twoWindowQueues();
  await b.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "b" });
  await b.flush(async () => {
    await a.enqueue({ projectId: "p", taskId: "t2", status: "implemented", scope: "a" });
  }, belongsTo("b", undefined));
  assert.deepEqual(file().map((e) => e.taskId), ["t2"]);
});

test("a write superseded while its flush was in flight is kept", async () => {
  const { a, b, file } = twoWindowQueues();
  await b.enqueue({ projectId: "p", taskId: "t1", status: "implemented", scope: "s" });
  await b.flush(async () => {
    await a.enqueue({ projectId: "p", taskId: "t1", status: "in_progress", scope: "s" });
  });
  assert.deepEqual(file().map((e) => e.status), ["in_progress"]);
});
