// Run:  node --test apps/vscode/test/unit/remoteRefs.test.ts
//
// Finding #44: a push from a terminal was not noticed until the editor's Git
// integration happened to refresh. gitBridge.ts now watches the files a push or
// fetch rewrites and asks the repository for a fresh status — once per burst,
// because one fetch rewrites a ref file per remote branch.

import test from "node:test";
import assert from "node:assert/strict";

import { KeyedDebounce, REMOTE_REF_GLOBS } from "../../src/git/remoteRefs.ts";

function fakeTimers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      set: (fn: () => void) => {
        next += 1;
        pending.set(next, fn);
        return next;
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    size: () => pending.size,
  };
}

test("a burst of remote-ref changes refreshes each repository once", () => {
  const clock = fakeTimers();
  const debounce = new KeyedDebounce(500, clock.timers);
  const refreshed: string[] = [];
  for (let i = 0; i < 20; i++) debounce.trigger("repo-a", () => refreshed.push("a"));
  debounce.trigger("repo-b", () => refreshed.push("b"));
  assert.equal(clock.size(), 2);
  clock.flush();
  assert.deepEqual(refreshed.sort(), ["a", "b"]);
});

test("a later change after the burst refreshes again", () => {
  const clock = fakeTimers();
  const debounce = new KeyedDebounce(500, clock.timers);
  let count = 0;
  debounce.trigger("repo", () => (count += 1));
  clock.flush();
  debounce.trigger("repo", () => (count += 1));
  clock.flush();
  assert.equal(count, 2);
});

test("disposing cancels a pending refresh", () => {
  const clock = fakeTimers();
  const debounce = new KeyedDebounce(500, clock.timers);
  let count = 0;
  debounce.trigger("repo", () => (count += 1));
  debounce.dispose();
  clock.flush();
  assert.equal(count, 0);
});

test("the watched files are the ones a push or a fetch rewrites", () => {
  assert.deepEqual([...REMOTE_REF_GLOBS], [".git/refs/remotes/**", ".git/FETCH_HEAD", ".git/packed-refs"]);
});
