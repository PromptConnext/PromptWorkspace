// Run:  node --test packages/cloud-client/test/session.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  SessionStore,
  environmentScope,
  fileLeaseStorage,
  issuerHost,
  memoryLeaseStorage,
  scopedFileName,
} from "../src/session.ts";
import { memorySecrets, memoryState } from "./helpers.ts";

function jwt(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `h.${body}.s`;
}

const A = "a.supabase.co";
const B = "b.supabase.co";

function twoStores() {
  const secrets = memorySecrets();
  const state = memoryState();
  const make = (scope: string) => new SessionStore(secrets, state, undefined, () => scope);
  return { secrets, state, a: make(A), b: make(B), make };
}

test("environmentScope prefers the Supabase host", () => {
  assert.equal(environmentScope({ supabaseUrl: "https://abc.supabase.co", apiUrl: "https://api.x" }), "abc.supabase.co");
  assert.equal(environmentScope({ supabaseUrl: "", apiUrl: "https://api.x" }), "api.x");
  assert.equal(environmentScope({ supabaseUrl: "", apiUrl: "" }), "");
  assert.equal(environmentScope({ supabaseUrl: "nope", apiUrl: "also nope" }), "");
});

test("issuerHost reads the iss claim", () => {
  assert.equal(issuerHost(jwt({ iss: "https://abc.supabase.co/auth/v1" })), "abc.supabase.co");
  assert.equal(issuerHost("nopayload"), undefined);
});

test("stores under the scope and reads nothing from another scope", async () => {
  const { a, b } = twoStores();
  await a.store({ mode: "supabase", userId: "u1" }, "a1", "r1");
  assert.equal(b.read(), null);
  assert.equal(await b.accessToken(), undefined);
  await b.clear();
  assert.equal(a.read()?.userId, "u1");
  assert.equal(await a.refreshToken(), "r1");
});

test("clearIfRefreshToken only clears its own scope", async () => {
  const { a, b } = twoStores();
  await a.store({ mode: "supabase", userId: "u1" }, "a1", "ra");
  await b.store({ mode: "supabase", userId: "u2" }, "b1", "rb");
  assert.equal(await b.clearIfRefreshToken("rb"), true);
  assert.equal(await a.refreshToken(), "ra");
  assert.equal(b.read(), null);
});

test("adopts a legacy session only into the environment that minted it", async () => {
  const { secrets, state, a, b } = twoStores();
  const legacy = new SessionStore(secrets, state);
  const record = { mode: "supabase" as const, userId: "u1" };
  await legacy.store(record, jwt({ iss: `https://${A}/auth/v1` }), "r1");
  assert.equal(await b.adoptLegacySession(), false);
  assert.equal(legacy.read()?.userId, "u1", "the unscoped keys remain");
  assert.equal(await a.adoptLegacySession(), true);
  assert.deepEqual(a.read(), record);
  assert.equal(await a.refreshToken(), "r1");
  assert.equal(legacy.read(), null);
  assert.equal(await legacy.accessToken(), undefined);
  assert.equal(await legacy.refreshToken(), undefined);
  assert.equal(await a.adoptLegacySession(), false);
});

test("adoptLegacySession takes a stub session, and does nothing for an empty scope", async () => {
  const { secrets, state, a, make } = twoStores();
  const legacy = new SessionStore(secrets, state);
  await legacy.store({ mode: "stub", userId: "dev" }, "a1", "r1");
  assert.equal(await make("").adoptLegacySession(), false);
  assert.equal(await a.adoptLegacySession(), true);
  assert.equal(a.read()?.mode, "stub");
});

test("rescope emits the session under the current scope", async () => {
  const secrets = memorySecrets();
  const state = memoryState();
  let scope = A;
  const s = new SessionStore(secrets, state, undefined, () => scope);
  await s.store({ mode: "supabase", userId: "u1" }, "a1", "r1");
  const seen: (string | undefined)[] = [];
  s.onDidChange((x) => seen.push(x?.userId));
  s.rescope();
  scope = B;
  s.rescope();
  assert.deepEqual(seen, ["u1", undefined]);
});

test("an empty scope keeps the 0.3.0 keys", async () => {
  const secrets = memorySecrets();
  const state = memoryState();
  const store = new SessionStore(secrets, state);
  await store.store({ mode: "supabase", userId: "u1" }, "a1", "r1");
  assert.equal(state.get("promptworkspace.cloud.session") !== undefined, true);
  assert.equal(await secrets.get("promptworkspace.cloud.access"), "a1");
  assert.equal(await secrets.get("promptworkspace.cloud.refresh"), "r1");
});

test("leases are per scope", async () => {
  const leases = memoryLeaseStorage();
  await leases.write("a", { owner: "w1", until: 5 });
  assert.deepEqual(await leases.read("a"), { owner: "w1", until: 5 });
  assert.equal(await leases.read("b"), undefined);

  const files = new Map<string, string>();
  const file = fileLeaseStorage({
    async read(name) {
      return files.get(name);
    },
    async write(name, contents) {
      files.set(name, contents);
    },
  });
  await file.write("a.supabase.co", { owner: "w1", until: 5 });
  await file.write("", { owner: "w2", until: 6 });
  assert.deepEqual([...files.keys()].sort(), ["refresh-lease.json", "refresh-lease@a.supabase.co.json"]);
  assert.equal(await file.read("b.supabase.co"), undefined);
});

test("scopedFileName keeps a scope safe in a file name on every platform", () => {
  assert.equal(scopedFileName("tasks.json", ""), "tasks.json");
  assert.equal(scopedFileName("tasks.json", "a.supabase.co"), "tasks@a.supabase.co.json");
  // `:` names an NTFS alternate data stream; a stub scope carries a port.
  assert.equal(scopedFileName("tasks.json", "localhost:8080"), "tasks@localhost_8080.json");
  assert.equal(scopedFileName("tasks.json", "[::1]:8080"), "tasks@___1__8080.json");
});

test("a lease file name never carries a colon", async () => {
  const files = new Map<string, string>();
  const file = fileLeaseStorage({
    async read(name) {
      return files.get(name);
    },
    async write(name, contents) {
      files.set(name, contents);
    },
  });
  await file.write("localhost:8080", { owner: "w1", until: 5 });
  assert.deepEqual([...files.keys()], ["refresh-lease@localhost_8080.json"]);
  assert.deepEqual(await file.read("localhost:8080"), { owner: "w1", until: 5 });
});
