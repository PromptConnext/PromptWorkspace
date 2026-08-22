# ADR 0022 — The developer's task loop starts and closes inside the editor; a task closes on push, not on commit

**Date:** 2026-08-22 · **Status:** Accepted · **Deciders:** product + engineering

**Prompted by the decision:** *a developer must be able to run the whole task → code → commit → push → status loop without leaving the editor, and without retyping a task identifier they already selected from a list.*

**Extends:** [ADR 0019](0019-desktop-as-vscode-extension.md) — the commit-driven task close it specifies gains a publication gate and a front half. Its no-sidecar constraint, its `vscode.git` blast-radius rule and its invoke-and-check feature-detection rule all bind this work unchanged. [ADR 0020](0020-cloud-is-the-source-of-truth.md) — the three upward writes are unchanged in number and in shape; this ADR changes only *when* the status write fires and adds the first caller of the assignment write. [ADR 0018](0018-assign-tasks-to-workspace-members.md) — the extension moves from displaying an assignment to making one.

**Does not decide** anything about external trackers. Jira and ClickUp mirroring exists in `apps/cloud/app/integrations/` and is out of scope here; PromptConnext's own task graph is the system of record for this loop, and nothing below reads or writes a third-party tracker.

---

## Context

### The loop is broken at both ends

ADR 0019 named the commit-driven close as the headline feature, and `apps/vscode/src/git/gitWatcher.ts` implements it: a repository state change is debounced, recent commit subjects are scanned for `T<number>`, and a match writes `implemented` with a commit artifact. That module's own header describes the intended gesture — "a developer writes `T3: add retry`, pushes, and the task closes in the cloud with no context switch at all."

The word doing the work in that sentence is *pushes*, and the code does not implement it. `onDidChangeRepositoryState` fires on a local commit. A commit that never leaves the machine closes the task in the cloud, and every teammate reading the board is told work is finished that exists nowhere they can reach it. This is not a missing enhancement; it is a correctness defect in a feature that shipped in 0.2.0.

The other end is missing outright. Nothing in the extension starts a task. `CloudClient.assignTask` exists and has no caller anywhere in the repository. There is no command that claims a task, moves it to `in_progress`, or creates a branch for it. A developer picks a task out of the tree and then leaves the tree entirely to do everything by hand, which is the context switch the feature was supposed to remove.

### The identifier is the whole convention, and nothing carries it

Auto-close depends on the string `T12` reaching git. Today the only path is the developer reading the number off a tree item and typing it into a commit subject from memory. That is a convention held together by discipline, and discipline is exactly what a tool is supposed to replace. The failure is also silent: a mistyped or forgotten reference produces no error, no warning and no difference in the editor — the task simply never closes, and nobody finds out until someone reads the board.

Two carriers are available and neither is used. VS Code's Git extension exposes `Repository.inputBox.value`, so the commit message box can be pre-filled, and `Repository.createBranch`, so a branch can be named for the task. A branch name survives every commit made on it, including commits made from a terminal that the editor's input box never sees.

### Why a stored "current task" is the wrong shape

The obvious design — remember which task the developer selected and attribute their commits to it — is the one `apps/vscode/src/link/activeProject.ts` already argued against for the analogous question of which *project* the developer is in. Its reasoning applies without modification: a stored selection drifts out of step with what the developer is actually doing, and there is no way for them to notice until it has already misattributed something. Attribution that lives only in extension state is also invisible in the history it is describing, so nobody reviewing the repository later can tell what happened or correct it.

---

## Decision

**1. A task closes when its commit is published, not when it is written.** The extension observes the branch's upstream tracking state and treats a commit as evidence of implementation only once it has reached the remote. Between commit and push the task holds a purely local *pending push* marker — no cloud write of any kind occurs, so a developer who commits, amends, rebases and force-pushes over an afternoon produces exactly one status write at the end of it rather than a sequence of claims the team has to interpret.

**2. Publication is read from the branch, not from a shell-out.** `RepoRef` gains the branch fields the vendored Git API already carries — name, upstream, ahead and behind — filled from `repo.state.HEAD` inside `gitBridge.ts`, which remains the only file in the extension permitted to import `git.d.ts`. A push raises a repository state change, so the existing debounce is the trigger; there is no polling, no timer and no new process. The rule is that a commit is unpublished exactly when it sits within the `ahead` newest commits of the current branch, and published otherwise.

**3. With no upstream, the old behaviour survives and says so.** A repository with no configured remote tracking branch has no publication signal, and refusing to close anything there would silently break a legitimate workflow. Those repositories fall back to closing at commit time and log the reason once, so the difference is discoverable rather than mysterious.

**4. The reference reaches git through the branch name and the commit box, and through nothing else.** A new *Start Task* command claims the task, moves it to `in_progress`, offers a branch named for it, and pre-fills the commit message box. Both git-facing steps are individually declinable — a developer already on a shared branch must not be forced into a branch creation to record that they have started work. There is no persisted "current task" and no attribution that is invisible in the history: if neither carrier is present, the extension does not guess.

**5. Attribution has exactly two rules, in order.** A reference in the commit subject wins. Failing that, a reference in the branch name applies, and it does not apply on the project's default branch, where a long-lived shared branch would otherwise attribute unrelated work. The branch reference is parsed by the same numeric normalisation and blocked by the same collision rule as the subject reference, in the same module — `T012` and `T12` meet in one place or they do not meet at all.

**6. Every status write continues to go through `statusWriter.ts`.** The publication gate changes when that module is called and never how. The 4xx-drop / 5xx-queue rule, the optimistic update, the rollback and the offline queue therefore cover the new paths without modification, and `queue.ts` is untouched.

---

## Boundaries

The extension gains no process, no server and no new credential. `RepoRef.head`, `createBranch` and `inputBox` widen the `vscode.git` surface the extension depends on, which ADR 0019 identifies as the least stable dependency in the stack; all three stay behind `gitBridge.ts`, where a breaking change upstream lands as one typecheck failure rather than as runtime damage spread across the codebase.

Nothing here reads or writes an external tracker. Nothing here introduces a second task-status vocabulary — `cloud/types.ts` remains the only place statuses are named, and its warning about mapping tables stands.

The *Start Task* command makes the extension's first assignment write. It uses the endpoint ADR 0018 already defines and adds no new permission model: a claim the cloud refuses is refused the same way any other 4xx is.

---

## Consequences

**A commit no longer produces immediate feedback in the cloud, and the tree has to supply it instead.** Between commit and push the only signal that a reference was parsed correctly is local, so the task tree renders the pending-push state on the task item. This is a gain over today, where a *mistyped* reference produced no signal at all in either direction; it is a loss over today only for a developer who was relying on the immediate close, which is the behaviour this ADR classifies as a defect.

**Publication is exact when it matters and approximate when it does not.** The `ahead === 0` case — a developer pushing what they just wrote — is exact regardless of history shape. A branch with merge commits and a non-zero `ahead` count can be off by the ordering of the log page, which delays or advances a close by one scan; the cloud's artifact write is idempotent on `(task_id, commit_sha)` and the status transition is one-way, so the cost is bounded at a close arriving one push early or late on a non-linear branch.

**A rewritten commit leaves a stale artifact.** A force-push after a close leaves the cloud holding a sha that no longer exists. The seen-ring in `gitWatcher` was already lossy at the edges for exactly this reason and the cloud already tolerates replay; reconciliation is not built and is not planned.

**The default changes for existing 0.2.0 installs.** `promptconnext.closeTasksFromCommits` is superseded by `promptconnext.closeTasksOn`, which defaults to `push`. The old setting is still read, and `false` still means the watcher is off, so nobody who disabled the feature has it re-enabled underneath them.

---

## Alternatives rejected

**Close on push only, with no intermediate state.** Rejected: it removes the single opportunity to tell the developer that their reference did not parse. The window between commit and push is precisely when a mistake is still cheap to fix, and spending it in silence wastes the only feedback moment the loop has.

**Keep commit-close and make push-close opt-in.** Rejected: it preserves the defect as the default experience. A setting is the right mechanism for the repositories that genuinely cannot signal publication — which decision 3 already covers — not a way to avoid choosing.

**Branch name only, with no commit-box pre-fill.** Rejected on its own, though it is the stronger of the two carriers. It forces a branch per task, which is a workflow opinion this extension has no standing to impose, and it leaves nothing at all for the developer who declines the branch.

**Commit-box pre-fill only.** Rejected on its own: the value is consumed by the first commit and is invisible to any commit made from a terminal, which is most of them for a substantial fraction of developers.

**A persisted active task.** Rejected for the reasons `activeProject.ts` already records, and for one more specific to attribution: state that only the extension can see cannot be reviewed, corrected, or explained to a colleague reading the repository six months later.

**Shelling out to `git` to test ancestry exactly.** Rejected: it buys exactness in the case that already does not matter (a non-linear branch mid-push) at the cost of a spawned process, which is the one thing ADR 0019 spends its length removing.

---

## Notes for the implementing agent

- The publication partition and the branch-name parse are pure functions and belong in modules with no `vscode` import, because `apps/vscode/test/unit` runs under bare `node --test` with no editor host. A rule that cannot be unit-tested here will not be tested at all.
- `Branch.ahead` counts commits not present upstream; the commit log is newest-first. Do not assume the two agree beyond the linear case, and do not add a reconciliation pass to make them.
- Do not add a third place that maps a task status. Two exist in the engine and `cloud/types.ts` documents what they cost.
- The default branch is available as `CloudProject.repo_default_branch` on the roster. Read it; do not hardcode `main`.
- `deactivate()` stays empty. If a change here needs teardown, it has reintroduced something ADR 0019 removed.
