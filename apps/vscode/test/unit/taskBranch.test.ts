// Run:  node --test apps/vscode/test/unit/taskBranch.test.ts
//
// Finding #38: Start Task owns the branch. It creates and checks out
// `T<n>-<slug>`, and when that branch already exists (a second Start, or a
// branch made by hand) it checks it out instead of giving up.

import test from "node:test";
import assert from "node:assert/strict";

import { ensureTaskBranch } from "../../src/tasks/taskBranch.ts";

/** `existing` are local branches, `remote` are branches only on origin.
 *  Like git, `checkout <name>` of a remote-only branch creates the local
 *  tracking branch from it (DWIM); `createBranch` cuts from HEAD. */
function fakeGit(
  existing: Set<string>,
  opts: { checkoutFails?: boolean; remote?: Set<string> } = {},
) {
  const calls: string[] = [];
  const cutFrom = new Map<string, string>();
  let head = "main";
  return {
    calls,
    head: () => head,
    cutFrom,
    git: {
      async createBranch(_root: unknown, name: string) {
        calls.push(`create ${name}`);
        if (existing.has(name)) return false;
        existing.add(name);
        cutFrom.set(name, head);
        head = name;
        return true;
      },
      async checkout(_root: unknown, name: string) {
        calls.push(`checkout ${name}`);
        if (opts.checkoutFails) return false;
        if (!existing.has(name) && opts.remote?.has(name)) {
          existing.add(name);
          cutFrom.set(name, `origin/${name}`);
        }
        if (!existing.has(name)) return false;
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
  assert.deepEqual(fake.calls, ["checkout T14-add-retry"]);
});

test("a branch git will neither create nor check out is reported, not assumed", async () => {
  const fake = fakeGit(new Set(["main", "T14-add-retry"]), { checkoutFails: true });
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "failed");
  assert.equal(fake.head(), "main");
});

test("a task branch that exists only on the remote is checked out from it, not re-cut from HEAD", async () => {
  const fake = fakeGit(new Set(["main"]), { remote: new Set(["T14-add-retry"]) });
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "checked_out");
  assert.equal(fake.head(), "T14-add-retry");
  assert.equal(fake.cutFrom.get("T14-add-retry"), "origin/T14-add-retry");
  assert.ok(!fake.calls.includes("create T14-add-retry"));
});
