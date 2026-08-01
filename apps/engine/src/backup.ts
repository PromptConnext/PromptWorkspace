// Local task-graph backup (pre-launch readiness review, Must Have #2).
//
// The `node:sqlite` file written by db.ts is the offline source of truth
// (ADR 0003) and cloud sync is opt-in (ADR 0010), so a user who never signs in
// has exactly one copy of their whole task graph. This module gives them a
// second one.
//
// The snapshot is taken with SQLite's own `VACUUM INTO`, not a file copy: it
// runs inside a read transaction, so the destination is a consistent database
// even while the engine is mid-write, and it excludes the WAL/journal
// side-files a naive `cp` would have to capture atomically alongside the main
// file. Restoring is correspondingly dumb — close the app, put the file back
// at dbFilePath(), reopen — which is the property that matters when the person
// doing the restore is panicking.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { db, dataDir } from "./db.ts";
import { log } from "./logger.ts";

export type BackupInfo = {
  path: string;
  bytes: number;
  /** ISO-8601, file mtime — when the snapshot was taken. */
  created_at: string;
};

export function backupDir(): string {
  const dir = join(dataDir(), "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `promptconnext-2026-08-01T00-42-13Z.db` — sorts chronologically as text.
 *
 * Second resolution is the readable choice, but two backups taken inside the
 * same second (a double-click, or a scripted loop) would name the same file
 * and the second one would fail the never-overwrite rule below. Suffix on
 * collision so repeat backups always succeed.
 */
function defaultBackupPath(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[:]/g, "-");
  const base = join(backupDir(), `promptconnext-${stamp}`);
  let candidate = `${base}.db`;
  for (let n = 2; existsSync(candidate); n += 1) candidate = `${base}-${n}.db`;
  return candidate;
}

export type BackupErrorKind = "bad-path" | "exists" | "failed";

export class BackupError extends Error {
  kind: BackupErrorKind;

  constructor(message: string, kind: BackupErrorKind) {
    super(message);
    this.name = "BackupError";
    this.kind = kind;
  }
}

/**
 * Snapshot the live task graph to `destPath` (default: a timestamped file in
 * `<dataDir>/backups`). Never overwrites: an existing destination is an error,
 * because the caller asking for a backup is the last person who should have a
 * good one silently replaced.
 */
export function createBackup(destPath?: string, now: Date = new Date()): BackupInfo {
  const dest = destPath ?? defaultBackupPath(now);

  if (!isAbsolute(dest)) {
    throw new BackupError(`Backup path must be absolute, got "${dest}".`, "bad-path");
  }
  if (existsSync(dest)) {
    throw new BackupError(`Refusing to overwrite an existing file at "${dest}".`, "exists");
  }

  try {
    // The filename in VACUUM INTO is an SQL expression, so it binds like any
    // other parameter — no string interpolation, no quote-escaping problem.
    db.prepare("VACUUM INTO ?").run(dest);
  } catch (err) {
    throw new BackupError(
      `Could not write the backup to "${dest}": ${(err as Error).message}`,
      "failed",
    );
  }

  const info = describe(dest);
  log.info("backup.created", { path: info.path, bytes: info.bytes });
  return info;
}

function describe(path: string): BackupInfo {
  const st = statSync(path);
  return { path, bytes: st.size, created_at: new Date(st.mtimeMs).toISOString() };
}

/** Backups in the managed directory, newest first. Ignores anything else there. */
export function listBackups(): BackupInfo[] {
  return readdirSync(backupDir())
    .filter((name) => name.startsWith("promptconnext-") && name.endsWith(".db"))
    .map((name) => describe(join(backupDir(), name)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
