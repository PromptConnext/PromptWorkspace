# The task-reference grammar

**Status:** normative · **Plan:** [0024](../plans/0024-delivery-evidence-graph.md) M1 · **ADR:** [0022](../decisions/0022-task-loop-closes-on-push.md), [0023](../decisions/0023-development-preview-for-every-project-type.md)

A commit says which task it belongs to, and three separate programs have to agree on what it said. The VS Code extension reads a commit the moment a developer publishes it. The cloud reads the same commit again when GitHub delivers a webhook. The engine reads it a third time when it walks a local repository's log. If those three disagree, a task closes in the editor and the build it shipped in never names it — which is the failure this document exists to prevent, because an attribution that is merely usually right is not evidence.

This file states the rule in prose. [`task-ref-cases.json`](task-ref-cases.json) beside it states the same rule as data, and all three test suites read that file rather than restating the cases in their own words.

## Where the rule lives in code

`packages/cloud-client/src/taskRefs.ts` is the reference implementation. `apps/vscode` and `apps/mcp` both consume it directly through the `@promptworkspace/cloud-client` workspace dependency, so neither can drift from it at all.

The other two are derived copies, and each carries its own tripwire:

- `apps/engine/src/git/taskRefs.ts` is a **vendored byte-for-byte copy**, not a dependency. The engine is not in the workspace's dependency graph for `packages/*`, and the repository already uses vendoring for exactly this shape of problem (`apps/vscode/src/git/git.d.ts`). `apps/engine/test/task-refs.test.ts` asserts the copy still matches the reference byte for byte, so drift fails a test rather than silently changing what a commit means.
- `apps/cloud/app/integrations/task_refs.py` is a **hand-written port**, because there is no sane way to share a TypeScript module with FastAPI and generating one across the language boundary would be a build step nobody wants. Its tripwire is the shared case table: `apps/cloud/tests/test_task_refs.py` reads the same JSON the TypeScript suites do and must produce the same answers.

## The rule

A task reference is the letter `T` followed by one to six digits. It is **normalised numerically**, so `T1`, `T01`, `T001` and `T0001` are four spellings of one reference, `T1`. This matters because the cloud stores a task's `feature_tag` zero-padded (`T001`, sometimes `T001 [P]` with a parallel marker) while a developer writing a commit subject almost never pads. A textual comparison of those two forms fails, which is exactly how a project numbering its tasks `T12` used to get no attribution at all.

**In a commit subject** the pattern is `\bT(\d{1,6})\b` — word-bounded, case-sensitive. Only the subject is scanned, never the body: a body matches issue references and the quoted text inside a revert. Several references may appear, they are de-duplicated after normalisation, order is preserved, and **at most ten** are taken. One subject closing eleven tasks is a pathological subject, not a workflow.

`SPRINT12` yields nothing, because there is no word boundary before its `T`. `TEST-12` yields nothing, because its `T` is not followed by a digit. Both are real strings from real commit subjects, and both would be wrong answers rather than missing ones.

**In a branch name** the pattern is `(?:^|[/_-])[Tt](\d{1,6})(?=$|[/_-])` — the reference must be a **whole segment**, where segments are delimited by `/`, `-` and `_`. `\b` is the wrong boundary for a branch name because it would find the `T1` inside `SPRINT12`. The branch pattern is **case-insensitive**, unlike the subject pattern: `startTask` writes the canonical uppercase form, but a developer typing a branch by hand should not lose attribution to the shift key. That is a spelling of the same reference, not a second vocabulary. A branch names **at most one** task; a branch carrying two references is not a convention this platform recognises.

**A revert yields nothing.** A subject matching `^\s*Revert\s+"` attributes to no task at all, and — this is the part that is easy to get wrong — it does not fall through to branch attribution either. A revert made while sitting on `T12`'s own branch is the clearest possible case of "not done", so the branch fallback must not resurrect it.

**Two rules, in order.** A reference in the subject wins and may name several tasks. Failing that, the branch's own reference applies and names exactly one. That ordering is ADR 0022's, and it is why a developer can close an unrelated task from a feature branch by naming it in the subject.

**A collision blocks the reference entirely.** If two distinct tasks in one project carry tags that normalise to the same key — a project holding both `T012` and `T12` — then nothing may be attributed to that key by any of the three readers. The caller skips and logs rather than picking whichever task it happened to iterate first. A wrong attribution is worse than a missing one because it is invisible: nobody reviews a build's task list looking for a task that should not be there.

## The asymmetry: who reads a branch

**The editor attributes from a feature branch. The server never does.** This is a deliberate product rule and the single most likely thing to be mistaken for a bug, so it is written down here rather than left to be rediscovered.

`apps/vscode` passes a real branch reference (`src/git/gitWatcher.ts`, resolved by `branchRefFor`, which suppresses the project's default branch). It can, because it watched the developer publish from that branch and knows which branch it was.

Every server-side caller passes `null`:

- `apps/cloud/app/api/github.py` — both call sites. A push to the default branch has no feature branch to read. Inferring one from the webhook's `ref` would attribute every merge commit to whatever the branch happened to be named, which is worse than attributing nothing.
- `apps/engine/src/routes/projects.ts::syncTasksFromGit` — it walks the last 300 commits of a local log in one pass. There is no per-commit branch to recover after the fact, and using the currently checked-out branch would attribute three hundred unrelated commits to one task.

The consequence is worth stating plainly, because it is a rule a team can trip over: **a team using `startTask` branches with bare commit subjects gets task closure in the editor and no server-side attribution.** Their tasks will close and their builds will list nothing. The remedy is to name the task in the commit subject, which the editor's commit template already offers. A team that wants its builds to say what is in them must put the reference where every reader can see it.

`task-ref-cases.json` encodes both answers for every case — `expect` for a caller that resolves a branch reference, `expect_server` for one that passes `null` — so this asymmetry is tested rather than assumed.

## Changing this

The grammar is load-bearing for the delivery evidence chain, so widening it is a decision, not a refactor. Change `packages/cloud-client/src/taskRefs.ts`, re-vendor the engine's copy verbatim, port the change to `apps/cloud/app/integrations/task_refs.py`, and add the new cases to `task-ref-cases.json`. The engine's byte-identity assertion and the three suites reading the case table will tell you if you missed one.

What must **not** change without a new ADR is the direction of the rule. It only ever decides *attribution* — which task a commit belongs to. It never decides *status*. ADR 0022 put status with the client that observed the publication, because a server cannot tell "implemented" from "pushed" and must not guess.
