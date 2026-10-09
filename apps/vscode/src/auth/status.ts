// Is this window actually connected? (Findings #37, #42.)
//
// Two silent failures prompted this file. A window whose session had been
// refused (or cleared by another window) kept painting its cached roster for
// hours, "updated 11:24 PM", while every refresh failed; only the Output
// channel said why. And a folder with no `promptworkspace.projectId` skipped
// every commit with one log line, so a developer pushed T1 commits and watched
// nothing close. Both now have one answer, computed here without `vscode` so it
// is unit-tested, and rendered by extension.ts as a status-bar item, a banner
// row at the top of Projects and My Tasks, and one notification per window.

import { CloudHttpError, CloudNotLoggedInError } from "@promptworkspace/cloud-client";

export type ConnectionKind = "signed_out" | "unlinked" | "ok";

export interface SessionSignal {
  /** A session is stored (globalState metadata). Another window can clear it
   *  without this window hearing an event, so a stored session is not proof. */
  stored: boolean;
  /** The last task or roster refresh failed because the session is gone
   *  (see `isAuthFailure`), not merely because the refresh gave up for now. */
  authFailed: boolean;
}

export interface RosterSignal {
  /** Cached lists are on screen: evidence this window was signed in once. */
  cached: boolean;
  /** Projects with a repository a folder could be linked to. */
  linkable: number;
}

/** One open workspace folder that is a git repository. */
export interface FolderLink {
  name: string;
  linked: boolean;
  /** Its remotes match a roster project, so `ProjectLink.offerLinks` is
   *  already asking about it; a second notification would be noise. */
  hasMatch: boolean;
}

export interface ConnectionAction {
  title: "Sign in" | "Link this folder";
  command: string;
}

export interface Connection {
  state: ConnectionKind;
  /** Full sentence: the notification and the banner's tooltip. */
  message: string;
  /** Short label for the banner row at the top of each tree. */
  banner: string;
  action?: ConnectionAction;
  /** Status-bar text; undefined hides the item. */
  statusText?: string;
  /** Worth a notification (at most once per window per state). */
  notify: boolean;
}

/** Nothing to report: the state every window starts in before the first render. */
export const CONNECTED: Connection = { state: "ok", message: "", banner: "", notify: false };

export function connectionState(
  session: SessionSignal,
  roster: RosterSignal,
  links: readonly FolderLink[],
): Connection {
  if (!session.stored || session.authFailed) {
    return {
      state: "signed_out",
      message:
        "Signed out of PromptWorkspace. Task lists are not updating and commits will not " +
        "close tasks until you sign in.",
      banner: "Signed out: click to sign in",
      action: { title: "Sign in", command: "promptworkspace.signIn" },
      statusText: "$(account) PromptWorkspace: sign in",
      // A window that was never signed in has the welcome view's Sign in
      // button already; popping a notification in every window of a user who
      // merely installed the extension would be nagging. A stored session the
      // cloud refuses, or cached lists still on screen, mean the user believes
      // they are signed in, which is exactly when they must be told.
      notify: session.stored || roster.cached,
    };
  }

  // Unlinked only when nothing in this window is linked: in a multi-root
  // window the other folder may be unrelated, and only a window where no
  // repository can close a task is silently broken.
  const unlinked = links.filter((f) => !f.linked);
  if (roster.linkable > 0 && links.length > 0 && unlinked.length === links.length) {
    const names = unlinked.map((f) => `"${f.name}"`).join(", ");
    return {
      state: "unlinked",
      message:
        `${names} ${unlinked.length === 1 ? "is" : "are"} not linked to a PromptWorkspace ` +
        "project, so commits here will not close tasks.",
      banner: "Folder not linked: click to link it to a project",
      action: { title: "Link this folder", command: "promptworkspace.linkProject" },
      statusText: "$(link) PromptWorkspace: link this folder",
      notify: !unlinked.some((f) => f.hasMatch),
    };
  }
  return CONNECTED;
}

export interface BannerRow {
  kind: "banner";
  connection: Connection;
}

/** The rows a tree shows: the banner first when something is wrong. An empty
 *  tree gets no banner, because the view's welcome content (which already
 *  offers Sign in / Link) only renders while the tree has no rows. */
export function withBanner<T>(connection: Connection, rows: readonly T[]): (T | BannerRow)[] {
  if (connection.state === "ok" || rows.length === 0) return [...rows];
  return [{ kind: "banner", connection }, ...rows];
}

/** The view description for a cached list shown while signed out. */
export function cachedLabel(refreshedAt: number, formatTime: (ms: number) => string): string {
  return refreshedAt > 0
    ? `last updated ${formatTime(refreshedAt)} (signed out)`
    : "cached (signed out)";
}

/** What is stored right now, read after a refresh failed. */
export interface StoredSession {
  signedIn: boolean;
  hasRefreshToken: boolean;
}

/**
 * A refresh failure that means "this session is gone": no session at all, or
 * a 401 once the session or its refresh token has been removed (refused by
 * the auth server, or cleared by another window). Any other 401 is the refresh
 * path giving up for now — the auth server offline, a rotation whose new token
 * is not visible yet — and is offline, like a network error, 5xx or 403.
 */
export function isAuthFailure(err: unknown, stored: StoredSession): boolean {
  if (err instanceof CloudNotLoggedInError) return true;
  if (!(err instanceof CloudHttpError) || err.status !== 401) return false;
  return !stored.signedIn || !stored.hasRefreshToken;
}

/** `isAuthFailure`, reading what is stored from the client. Used by both
 *  stores' refresh `catch`. */
export async function refreshFailureIsAuth(
  err: unknown,
  client: { signedIn(): boolean; hasRefreshToken(): Promise<boolean> },
): Promise<boolean> {
  if (err instanceof CloudNotLoggedInError) return true;
  if (!(err instanceof CloudHttpError) || err.status !== 401) return false;
  return isAuthFailure(err, {
    signedIn: client.signedIn(),
    hasRefreshToken: await client.hasRefreshToken().catch(() => false),
  });
}
