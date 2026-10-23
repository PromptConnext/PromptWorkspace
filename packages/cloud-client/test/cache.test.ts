// Run:  node --test packages/cloud-client/test/cache.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { CACHE_FILES, JsonCache, type FileStoreLike } from "../src/cache.ts";
import { scopedFileName } from "../src/session.ts";

function memoryStore(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
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

test("round-trips data", async () => {
  const { store } = memoryStore();
  const cache = new JsonCache(store);
  await cache.write("tasks.json", [{ id: "t1" }]);
  assert.deepEqual(await cache.read("tasks.json"), [{ id: "t1" }]);
});

test("a missing file reads as undefined, not an error", async () => {
  const cache = new JsonCache(memoryStore().store);
  assert.equal(await cache.read("nope.json"), undefined);
});

test("drops a cache written by an older schema", async () => {
  const { store, files } = memoryStore({
    "tasks.json": JSON.stringify({ schemaVersion: 0, data: [{ id: "stale" }] }),
  });
  const cache = new JsonCache(store);
  assert.equal(await cache.read("tasks.json"), undefined);
  assert.equal(files.has("tasks.json"), false, "the unreadable file is removed");
});

test("drops a corrupt cache rather than throwing at activation", async () => {
  const { store, files } = memoryStore({ "tasks.json": "{ not json" });
  const cache = new JsonCache(store);
  assert.equal(await cache.read("tasks.json"), undefined);
  assert.equal(files.has("tasks.json"), false);
});

test("clear removes every named file", async () => {
  const { store, files } = memoryStore();
  const cache = new JsonCache(store);
  await cache.write("tasks.json", []);
  await cache.write("queue.json", []);
  await cache.clear(["tasks.json", "queue.json", "absent.json"]);
  assert.equal(files.size, 0);
});

test("a cache with a name mapper keeps each environment's files apart", async () => {
  const { store, files } = memoryStore();
  let scope = "a.supabase.co";
  const cache = new JsonCache(store, (name) => scopedFileName(name, scope));
  await cache.write(CACHE_FILES.tasks, [{ id: "a-task" }]);
  assert.ok(files.has("tasks@a.supabase.co.json"));

  scope = "localhost:8080";
  assert.equal(await cache.read(CACHE_FILES.tasks), undefined, "another environment reads nothing");
  await cache.write(CACHE_FILES.tasks, [{ id: "local-task" }]);
  await cache.clear([CACHE_FILES.tasks]);
  assert.equal(files.has("tasks@localhost_8080.json"), false, "clear removes only this scope's file");

  scope = "a.supabase.co";
  assert.deepEqual(await cache.read(CACHE_FILES.tasks), [{ id: "a-task" }]);
});
