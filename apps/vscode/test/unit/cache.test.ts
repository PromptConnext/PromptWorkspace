// Run:  node --test apps/vscode/test/unit/cache.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { JsonCache, type FileStoreLike } from "../../src/storage/cache.ts";

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
