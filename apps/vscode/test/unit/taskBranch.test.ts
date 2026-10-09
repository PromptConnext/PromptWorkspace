// Run:  node --test apps/vscode/test/unit/taskBranch.test.ts
//
// Finding #38: Start Task owns the branch. It checks out `T<n>-<slug>` when
// that branch exists (locally, or only on the remote), and creates it when it
// exists nowhere. `checkout` is only ever called for a name that IS a ref:
// `git checkout <name>` with no such ref reads the name as a path and
// overwrites local changes to that file.

import test from "node:test";
import assert from "node:assert/strict";

import { ensureTaskBranch, type BranchLocation } from "../../src/tasks/taskBranch.ts";

/** `local` are local branches, `remote` exist only on origin, `paths` are
 *  working-tree files. Like git, `checkout <name>` of a remote-only branch
 *  creates the local tracking branch (DWIM), and `checkout <name>` of a name
 *  that is no ref but a path discards that file's local changes. */
function fakeGit(
  local: Set<string>,
  opts: {
    remote?: Set<string>;
    paths?: Set<string>;
    checkoutFails?: boolean;
    createFails?: boolean;
    refsUnreadable?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const cutFrom = new Map<string, string>();
  const clobbered: string[] = [];
  let head = "main";
  return {
    calls,
    cutFrom,
    clobbered,
    head: () => head,
    git: {
      async findBranch(_root: unknown, name: string): Promise<BranchLocation> {
        if (opts.refsUnreadable) return "unknown";
        if (local.has(name)) return "local";
        if (opts.remote?.has(name)) return "remote";
        return "none";
      },
      async createBranch(_root: unknown, name: string) {
        calls.push(`create ${name}`);
        if (opts.createFails || local.has(name)) return false;
        local.add(name);
        cutFrom.set(name, head);
        head = name;
        return true;
      },
      async checkout(_root: unknown, name: string) {
        calls.push(`checkout ${name}`);
        if (opts.checkoutFails) return false;
        if (!local.has(name) && opts.remote?.has(name)) {
          local.add(name);
          cutFrom.set(name, `origin/${name}`);
        }
        if (!local.has(name)) {
          if (opts.paths?.has(name)) {
            clobbered.push(name);
            return true;
          }
          return false;
        }
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
  assert.deepEqual(fake.calls, ["create T14-add-retry"]);
});

test("Start Task checks out the task branch when it already exists", async () => {
  const fake = fakeGit(new Set(["main", "T14-add-retry"]));
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "checked_out");
  assert.equal(fake.head(), "T14-add-retry");
  assert.deepEqual(fake.calls, ["checkout T14-add-retry"]);
});

test("a task branch that exists only on the remote is checked out from it, not re-cut from HEAD", async () => {
  const fake = fakeGit(new Set(["main"]), { remote: new Set(["T14-add-retry"]) });
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "checked_out");
  assert.equal(fake.head(), "T14-add-retry");
  assert.equal(fake.cutFrom.get("T14-add-retry"), "origin/T14-add-retry");
  assert.ok(!fake.calls.includes("create T14-add-retry"));
});

test("a same-named file with no such branch is never checked out over local changes", async () => {
  const fake = fakeGit(new Set(["main"]), { paths: new Set(["T14-add-retry"]) });
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "created");
  assert.deepEqual(fake.clobbered, []);
  assert.deepEqual(fake.calls, ["create T14-add-retry"]);
});

test("when refs cannot be read, create first and check out only a name git says is taken", async () => {
  const exists = fakeGit(new Set(["main", "T14-add-retry"]), { refsUnreadable: true });
  assert.equal(await ensureTaskBranch(exists.git, "root", "T14-add-retry"), "checked_out");
  assert.deepEqual(exists.calls, ["create T14-add-retry", "checkout T14-add-retry"]);

  const fresh = fakeGit(new Set(["main"]), {
    refsUnreadable: true,
    paths: new Set(["T14-add-retry"]),
  });
  assert.equal(await ensureTaskBranch(fresh.git, "root", "T14-add-retry"), "created");
  assert.deepEqual(fresh.clobbered, []);
});

test("a branch git will neither create nor check out is reported, not assumed", async () => {
  const fake = fakeGit(new Set(["main", "T14-add-retry"]), { checkoutFails: true });
  assert.equal(await ensureTaskBranch(fake.git, "root", "T14-add-retry"), "failed");
  assert.equal(fake.head(), "main");

  const refused = fakeGit(new Set(["main"]), { createFails: true, paths: new Set(["T14-add-retry"]) });
  assert.equal(await ensureTaskBranch(refused.git, "root", "T14-add-retry"), "failed");
  assert.deepEqual(refused.clobbered, [], "a refused create never falls back to a path checkout");
});
