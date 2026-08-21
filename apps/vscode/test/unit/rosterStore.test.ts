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
