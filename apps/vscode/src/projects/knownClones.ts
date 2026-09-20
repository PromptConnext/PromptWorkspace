// Two small pieces of cross-window state, both in globalState.
//
// globalState and not workspaceState, for the same reason in both cases: the
// window that starts a clone is not the window that receives it. Neither value
// is a secret — a project id and a folder path — so SecretStorage would be the
// wrong home and would cost a Linux keyring gap for nothing.
//
// Both are caches. A knownClones entry is validated against the disk before it
// is believed (see roster.ts), and a pendingClone expires. Losing either costs
// a duplicate Clone offer, never correctness.

import type { StorageLike } from "@promptconnext/pz-cloud";
import type { PendingClone } from "./roster.ts";

export const KNOWN_CLONES_KEY = "promptconnext.knownClones";
export const PENDING_CLONE_KEY = "promptconnext.pendingClone";

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

/** Sign-out. The path map names another account's machine layout and the
 *  pending record names another account's project; neither may survive into
 *  the next session. */
export async function clearCloneState(state: StorageLike): Promise<void> {
  await state.update(KNOWN_CLONES_KEY, undefined);
  await state.update(PENDING_CLONE_KEY, undefined);
}
