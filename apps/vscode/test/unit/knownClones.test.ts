// Run:  node --test apps/vscode/test/unit/knownClones.test.ts
//
// "Not a project folder" (review of #37): an unrelated repository answered
// once must stay answered across windows, and not outlive the account.

import test from "node:test";
import assert from "node:assert/strict";

import {
  clearCloneState,
  markNotProjectFolder,
  readNotProjectFolders,
} from "../../src/projects/knownClones.ts";

function memoryState() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

test("a folder marked 'Not a project folder' is remembered, once", async () => {
  const state = memoryState();
  assert.deepEqual(readNotProjectFolders(state), []);
  await markNotProjectFolder(state, "file:///src/dotfiles");
  await markNotProjectFolder(state, "file:///src/dotfiles");
  await markNotProjectFolder(state, "file:///src/scratch");
  assert.deepEqual(readNotProjectFolders(state), ["file:///src/dotfiles", "file:///src/scratch"]);
});

test("sign-out forgets it with the rest of the account's clone state", async () => {
  const state = memoryState();
  await markNotProjectFolder(state, "file:///src/dotfiles");
  await clearCloneState(state);
  assert.deepEqual(readNotProjectFolders(state), []);
});
