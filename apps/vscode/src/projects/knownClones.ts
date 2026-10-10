// Small pieces of cross-window state, all in globalState.
//
// globalState and not workspaceState, for the same reason in both cases: the
// window that starts a clone is not the window that receives it. Neither value
// is a secret — a project id and a folder path — so SecretStorage would be the
// wrong home and would cost a Linux keyring gap for nothing.
//
// Both are caches. A knownClones entry is validated against the disk before it
// is believed (see roster.ts), and a pendingClone expires. Losing either costs
// a duplicate Clone offer, never correctness.

import type { StorageLike } from "@promptworkspace/cloud-client";
import type { PendingClone } from "./roster.ts";

export const KNOWN_CLONES_KEY = "promptworkspace.knownClones";
export const PENDING_CLONE_KEY = "promptworkspace.pendingClone";
/** Folders (URI strings) the user answered "Not a project folder" for. Read
 *  by ProjectLink (no link offer) and by the connection state (no "unlinked"
 *  warning), so an unrelated repository is asked about once, not forever. */
export const NOT_PROJECT_FOLDERS_KEY = "promptworkspace.notProjectFolders";

export function readKnownClones(state: StorageLike): Record<string, string> {
  return state.get<Record<string, string>>(KNOWN_CLONES_KEY) ?? {};
}

export async function rememberClone(
  state: StorageLike,
  projectId: string,
  path: string,
): Promise<void> {
  await state.update(KNOWN_CLONES_KEY, { ...readKnownClones(state), [projectId]: path });
}

export function readPendingClone(state: StorageLike): PendingClone | undefined {
  return state.get<PendingClone>(PENDING_CLONE_KEY);
}

export async function writePendingClone(
  state: StorageLike,
  pending: PendingClone | undefined,
): Promise<void> {
  await state.update(PENDING_CLONE_KEY, pending);
}

export function readNotProjectFolders(state: StorageLike): string[] {
  const value = state.get<string[]>(NOT_PROJECT_FOLDERS_KEY);
  return Array.isArray(value) ? value : [];
}

export async function markNotProjectFolder(state: StorageLike, folderUri: string): Promise<void> {
  const current = readNotProjectFolders(state);
  if (current.includes(folderUri)) return;
  await state.update(NOT_PROJECT_FOLDERS_KEY, [...current, folderUri]);
}

/** Sign-out. The path map names another account's machine layout, the
 *  pending record names another account's project, and "not a project
 *  folder" was that account's answer (the next one may have a project
 *  there); none may survive into the next session. */
export async function clearCloneState(state: StorageLike): Promise<void> {
  await state.update(KNOWN_CLONES_KEY, undefined);
  await state.update(PENDING_CLONE_KEY, undefined);
  await state.update(NOT_PROJECT_FOLDERS_KEY, undefined);
}
