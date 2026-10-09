// Run:  node --test apps/vscode/test/unit/taskBranch.test.ts
//
// Finding #38: Start Task owns the branch. It creates and checks out
// `T<n>-<slug>`, and when that branch already exists (a second Start, or a
// branch made by hand) it checks it out instead of giving up.

import test from "node:test";
import assert from "node:assert/strict";

import { ensureTaskBranch } from "../../src/tasks/taskBranch.ts";

function fakeGit(existing: Set<string>, opts: { checkoutFails?: boolean } = {}) {
  const calls: string[] = [];
  let head = "main";
  return {
    calls,
    head: () => head,
    git: {
      async createBranch(_root: unknown, name: string) {
        calls.push(`create ${name}`);
        if (existing.has(name)) return false;
        existing.add(name);
        head = name;
        return true;
      },
      async checkout(_root: unknown, name: string) {
        calls.push(`checkout ${name}`);
        if (opts.checkoutFails || !existing.has(name)) return false;
        head = name;
        return true;
      },
    },
  };
}

test("Start Task creates and checks out the task branch", async () => {
  const fake = fakeGit(new Set(["main"]));
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "created");
  assert.equal(fake.head(), "T14-add-retry");
});

test("Start Task checks out the task branch when it already exists", async () => {
  const fake = fakeGit(new Set(["main", "T14-add-retry"]));
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "checked_out");
  assert.equal(fake.head(), "T14-add-retry");
  assert.deepEqual(fake.calls, ["create T14-add-retry", "checkout T14-add-retry"]);
});

test("a branch git will neither create nor check out is reported, not assumed", async () => {
  const fake = fakeGit(new Set(["main", "T14-add-retry"]), { checkoutFails: true });
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "failed");
  assert.equal(fake.head(), "main");
});
