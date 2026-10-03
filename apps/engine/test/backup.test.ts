// Local task-graph backup (pre-launch readiness review, Must Have #2).
// Exercises the real SQLite snapshot against a throwaway data dir, then
// reopens each snapshot as a database to prove it is actually restorable —
// a backup that can't be read back is not a backup.
//
// Run:  node --test apps/engine/test/backup.test.ts
// (PROMPTWORKSPACE_DATA_DIR must be set BEFORE importing the SUT, so setup is
// top-level await, matching test/g2-roster.test.ts.)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pz-backup-"));
process.env.PROMPTWORKSPACE_DATA_DIR = dataDir;

const { db } = await import("../src/db.ts");
const { backupDir, createBackup, listBackups, BackupError } = await import("../src/backup.ts");

db.prepare("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(
  "p1",
  "Backed-up project",
  "/tmp/p1",
);

test("createBackup writes a snapshot that reopens with the data in it", () => {
  const info = createBackup();

  assert.ok(existsSync(info.path), `expected a file at ${info.path}`);
  assert.ok(info.bytes > 0, "snapshot should not be empty");
  assert.ok(info.path.startsWith(backupDir()), "default destination is the managed backup dir");

  const restored = new DatabaseSync(info.path);
  const row = restored.prepare("SELECT name FROM projects WHERE id = ?").get("p1") as {
    name: string;
  };
  assert.equal(row.name, "Backed-up project");
  restored.close();
});

test("a snapshot keeps the rows that existed when it was taken", () => {
  const before = createBackup();
  db.prepare("INSERT INTO projects (id, name, path) VALUES (?, ?, ?)").run(
    "p2",
    "Added later",
    "/tmp/p2",
  );

  const restored = new DatabaseSync(before.path);
  const count = restored.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  restored.close();

  // The earlier snapshot predates p2, and the live DB has both.
  assert.equal(count.n, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n,
    2,
  );
});

test("two backups in the same second get distinct files", () => {
  const at = new Date("2026-03-03T03:03:03Z");
  const first = createBackup(undefined, at);
  const second = createBackup(undefined, at);

  assert.notEqual(first.path, second.path);
  assert.ok(existsSync(first.path) && existsSync(second.path));
});

test("createBackup refuses to overwrite an existing file", () => {
  const dest = join(dataDir, "occupied.db");
  writeFileSync(dest, "not a database");

  assert.throws(
    () => createBackup(dest),
    (err: unknown) => err instanceof BackupError && err.kind === "exists",
  );
});

test("createBackup rejects a relative destination", () => {
  assert.throws(
    () => createBackup("relative/backup.db"),
    (err: unknown) => err instanceof BackupError && err.kind === "bad-path",
  );
});

test("listBackups returns managed snapshots newest first", () => {
  const early = createBackup(undefined, new Date("2026-01-01T00:00:00Z"));
  const late = createBackup(undefined, new Date("2026-06-01T00:00:00Z"));

  const listed = listBackups().map((b) => b.path);
  assert.ok(listed.includes(early.path) && listed.includes(late.path));
  // Newest-first is asserted on mtime ordering, which is when the snapshot was
  // actually written — the timestamps above only name the files.
  const times = listBackups().map((b) => b.created_at);
  assert.deepEqual(times, [...times].sort().reverse());
});

test("the route surface creates and lists backups", async () => {
  const { backups } = await import("../src/routes/backups.ts");

  const created = await backups.request("/engine/backups", { method: "POST" });
  assert.equal(created.status, 200);
  const info = (await created.json()) as { path: string; bytes: number };
  assert.ok(info.bytes > 0);

  const listed = await backups.request("/engine/backups");
  assert.equal(listed.status, 200);
  const body = (await listed.json()) as { dir: string; db_path: string; backups: unknown[] };
  assert.equal(body.dir, backupDir());
  assert.ok(body.db_path.endsWith("promptworkspace.db"));
  assert.ok(body.backups.length > 0);
});

test("the route reports a refused overwrite as a 400, not a crash", async () => {
  const { backups } = await import("../src/routes/backups.ts");
  const dest = join(dataDir, "route-occupied.db");
  writeFileSync(dest, "not a database");

  const res = await backups.request("/engine/backups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: dest }),
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { kind: string }).kind, "exists");
});
