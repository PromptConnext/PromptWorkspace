import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";

// Auto-update check + "skip this version" persistence.
//
// The Tauri updater fetches the signed latest.json manifest from R2 (endpoint
// in tauri.conf.json), compares its version to the running app, and only
// returns an Update when a newer version is published. We layer a per-version
// skip on top so a user who dismisses a release isn't nagged again for it —
// but any *newer* release (a different version string) prompts afresh, since
// we suppress only on an exact match.

const SKIP_KEY = "promptconnext.skippedUpdateVersion";

// Returns an actionable Update, or null when the app is up to date, the
// available version was skipped, or we're running outside Tauri (browser-only
// vite dev on :1420, where the updater IPC doesn't exist).
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  const update = await check();
  if (!update) return null;
  if (localStorage.getItem(SKIP_KEY) === update.version) return null;
  return update;
}

// Remember this version as skipped so checkForUpdate() suppresses it until a
// newer one ships.
export function skipVersion(version: string): void {
  localStorage.setItem(SKIP_KEY, version);
}
