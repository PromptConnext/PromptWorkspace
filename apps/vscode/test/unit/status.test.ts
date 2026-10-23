// Run:  node --test apps/vscode/test/unit/status.test.ts
//
// Findings #37 and #42: a signed-out window kept painting its cached roster for
// hours, and an unlinked folder skipped every commit with a line in the Output
// channel only. What the editor shows for each state is decided here, so the
// glue in extension.ts and the two tree providers only render the answer.

import test from "node:test";
import assert from "node:assert/strict";

import { CloudHttpError, CloudNotLoggedInError } from "@promptworkspace/cloud-client";
import {
  cachedLabel,
  connectionState,
  isAuthFailure,
  refreshFailureIsAuth,
  withBanner,
  type FolderLink,
} from "../../src/auth/status.ts";

const SIGNED_IN = { stored: true, authFailed: false };
const ROSTER = { cached: true, linkable: 2 };
const linked: FolderLink = { name: "checkout", linked: true, declined: false, hasMatch: true };
const unlinked: FolderLink = { name: "checkout", linked: false, declined: false, hasMatch: false };

test("no session is signed_out, with a Sign in action", () => {
  const state = connectionState({ stored: false, authFailed: false }, ROSTER, [linked]);
  assert.equal(state.state, "signed_out");
  assert.equal(state.action?.title, "Sign in");
  assert.equal(state.action?.command, "promptworkspace.signIn");
  assert.equal(state.statusText, "$(account) PromptWorkspace: sign in");
  // A cached roster is evidence this window was signed in once: say so.
  assert.equal(state.notify, true);
});

test("a stored session the cloud refuses is signed_out too", () => {
  const state = connectionState({ stored: true, authFailed: true }, ROSTER, [linked]);
  assert.equal(state.state, "signed_out");
  assert.equal(state.notify, true);
});

test("a window that was never signed in shows the state but does not pop a notification", () => {
  const state = connectionState(
    { stored: false, authFailed: true },
    { cached: false, linkable: 0 },
    [],
  );
  assert.equal(state.state, "signed_out");
  assert.equal(state.notify, false);
});

test("a session with an unlinked folder is unlinked, with a Link this folder action", () => {
  const state = connectionState(SIGNED_IN, ROSTER, [unlinked]);
  assert.equal(state.state, "unlinked");
  assert.equal(state.action?.title, "Link this folder");
  assert.equal(state.action?.command, "promptworkspace.linkProject");
  assert.match(state.message, /"checkout" is not linked/);
  assert.equal(state.notify, true);
  // The notification can be answered for good: an unrelated repository must
  // not carry a warning forever.
  assert.equal(state.dismiss?.title, "Not a project folder");
});

test("a folder marked 'Not a project folder' counts as linked: no toast, status item or banner", () => {
  const state = connectionState(SIGNED_IN, ROSTER, [{ ...unlinked, declined: true }]);
  assert.equal(state.state, "ok");
  assert.equal(state.statusText, undefined);
  assert.equal(state.notify, false);
  assert.deepEqual(withBanner(state, ["a"]), ["a"]);
});

test("a linked folder is ok", () => {
  const state = connectionState(SIGNED_IN, ROSTER, [linked]);
  assert.equal(state.state, "ok");
  assert.equal(state.action, undefined);
  assert.equal(state.statusText, undefined);
  assert.equal(state.notify, false);
  // A multi-root window with one linked repository is working; the other
  // folder may be unrelated, and nagging about it would teach users to ignore
  // the notice.
  assert.equal(connectionState(SIGNED_IN, ROSTER, [linked, { ...unlinked, name: "x" }]).state, "ok");
});

test("a declined folder does not hide another folder that is unlinked", () => {
  const dotfiles: FolderLink = { ...unlinked, name: "dotfiles", declined: true };
  const newrepo: FolderLink = { ...unlinked, name: "newrepo" };
  const state = connectionState(SIGNED_IN, ROSTER, [dotfiles, newrepo]);
  assert.equal(state.state, "unlinked");
  assert.match(state.message, /"newrepo"/);
  assert.doesNotMatch(state.message, /dotfiles/);
  assert.equal(state.notify, true);
  // Declined plus linked, and declined alone, stay quiet.
  assert.equal(connectionState(SIGNED_IN, ROSTER, [dotfiles, linked]).state, "ok");
  assert.equal(connectionState(SIGNED_IN, ROSTER, [dotfiles]).state, "ok");
});

test("unlinked needs something to link to and a repository to link", () => {
  assert.equal(connectionState(SIGNED_IN, { cached: true, linkable: 0 }, [unlinked]).state, "ok");
  assert.equal(connectionState(SIGNED_IN, ROSTER, []).state, "ok");
});

test("a folder the link offer already matched is not notified twice", () => {
  const state = connectionState(SIGNED_IN, ROSTER, [{ ...unlinked, hasMatch: true }]);
  assert.equal(state.state, "unlinked");
  assert.equal(state.notify, false, "offerLinks is already asking about this folder");
});

test("the banner node leads a non-empty tree", () => {
  const state = connectionState(SIGNED_IN, ROSTER, [unlinked]);
  const rows = withBanner(state, ["a", "b"]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { kind: "banner", connection: state });
  assert.deepEqual(rows.slice(1), ["a", "b"]);
});

test("an empty tree gets no banner, so the welcome view still shows", () => {
  const state = connectionState({ stored: false, authFailed: false }, ROSTER, []);
  assert.deepEqual(withBanner(state, []), []);
  assert.deepEqual(withBanner(connectionState(SIGNED_IN, ROSTER, [linked]), ["a"]), ["a"]);
});

test("cached lists say when they were last updated, and that the user is signed out", () => {
  assert.equal(cachedLabel(5, () => "11:24 PM"), "last updated 11:24 PM (signed out)");
  assert.equal(cachedLabel(0, () => "never"), "cached (signed out)");
});

test("only a refusal of the session counts as an auth failure", () => {
  const stored = { signedIn: true, hasRefreshToken: true };
  const gone = { signedIn: false, hasRefreshToken: false };
  assert.equal(isAuthFailure(new CloudNotLoggedInError(), stored), true);
  // A 401 while the session and its refresh token are still stored is the
  // refresh path giving up for now (auth server down, a rotation with no
  // usable token yet): offline, not signed out.
  assert.equal(isAuthFailure(new CloudHttpError(401, "invalid_token"), stored), false);
  assert.equal(isAuthFailure(new CloudHttpError(401, "invalid_token"), gone), true);
  assert.equal(
    isAuthFailure(new CloudHttpError(401, "invalid_token"), { signedIn: true, hasRefreshToken: false }),
    true,
    "metadata without a refresh token cannot recover",
  );
  assert.equal(isAuthFailure(new CloudHttpError(403, "forbidden"), gone), false);
  assert.equal(isAuthFailure(new CloudHttpError(503, "down"), gone), false);
  assert.equal(isAuthFailure(new Error("fetch failed"), gone), false);
});

test("a refresh token that cannot be read (locked keyring) is offline, not signed out", async () => {
  const err = new CloudHttpError(401, "invalid_token");
  const locked = {
    signedIn: () => true,
    hasRefreshToken: async () => {
      throw new Error("keyring locked");
    },
  };
  assert.equal(await refreshFailureIsAuth(err, locked), false);
  const gone = { signedIn: () => true, hasRefreshToken: async () => false };
  assert.equal(await refreshFailureIsAuth(err, gone), true);
});
