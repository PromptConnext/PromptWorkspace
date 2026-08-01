import { Hono } from "hono";
import { BackupError, backupDir, createBackup, listBackups } from "../backup.ts";
import { dbFilePath } from "../db.ts";

export const backups = new Hono();

// GET /backups — where snapshots live, and which ones exist. The desktop shows
// `dir` so a user can find the file in Finder/Explorer without the app.
backups.get("/engine/backups", (c) =>
  c.json({ dir: backupDir(), db_path: dbFilePath(), backups: listBackups() }),
);

// POST /backups — take a snapshot now. `path` is optional; omit it to get a
// timestamped file in the managed directory above.
backups.post("/engine/backups", async (c) => {
  let path: string | undefined;
  try {
    const body = (await c.req.json()) as { path?: unknown };
    if (typeof body?.path === "string" && body.path.trim()) path = body.path.trim();
  } catch {
    // No body at all is the common case (the desktop's one-click backup).
  }

  try {
    return c.json(createBackup(path));
  } catch (err) {
    if (err instanceof BackupError) {
      return c.json({ error: err.message, kind: err.kind }, err.kind === "failed" ? 500 : 400);
    }
    throw err;
  }
});
