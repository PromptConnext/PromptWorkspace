# Plan 0024 — Complete the delivery evidence graph

**Date:** 2026-09-12 · **Status:** Ready for implementation · **ADR:** [0023](../decisions/0023-development-preview-for-every-project-type.md), [0022](../decisions/0022-task-loop-closes-on-push.md)

A project-management tool knows that a task closed. A deployment dashboard knows that a build shipped. This platform is the only one that can say those are the same event, and [§2 of the product vision](../product-vision-2026-09-12.md) is right that the chain holding that claim up — requirement, spec, task, commit, push, attribution, build, preview — is nearly complete. `pz_deployment_tasks` (`apps/cloud/migrations/0027_deployment_tasks.sql`) is the join nobody else has.

Three defects stop the claim from surviving scrutiny. None is large. Task identity under regeneration — the fourth break the vision names — is owned by `0018-stage-regeneration-identity.md` and is not duplicated here.

---

## Defect one — three grammars, and only two of them agree

There are three commit-subject parsers in the tree, not two.

`apps/vscode/src/git/taskRefs.ts` is the reference. It matches `/\bT(\d{1,6})\b/g` (`apps/vscode/src/git/taskRefs.ts:12`), normalises numerically so `T001`, `T01` and `T1` collapse to the single key `T1`, refuses a `Revert "…"` subject entirely (`apps/vscode/src/git/taskRefs.ts:36`), and falls back to a whole-segment branch ref under its own case-insensitive pattern (`apps/vscode/src/git/taskRefs.ts:24`) when the subject names nothing. `apps/cloud/app/integrations/task_refs.py` is a faithful port of all four behaviours — subject pattern at `apps/cloud/app/integrations/task_refs.py:20`, branch pattern at `apps/cloud/app/integrations/task_refs.py:26`, two-rule order in `refs_for_commit` (`apps/cloud/app/integrations/task_refs.py:98`). The port is not the problem, and the vision document's claim that "the cloud matches `\bT\d{3}\b`" names the wrong module.

The module that still matches `\bT\d{3}\b` is the **engine**, in `syncTasksFromGit` (`apps/engine/src/routes/projects.ts:751`). Line 783 accepts exactly three digits and nothing else; line 770 builds its lookup by textual comparison — `t.feature_tag.split(" ")[0]` — so even a widened regex would still fail `T12` against a stored `T012`. It has no revert guard, no branch fallback, and at line 789 it writes task status from a local commit, the behaviour ADR 0022 retired in favour of closing on publication.

The concrete consequence, with a named numbering scheme: **a project numbering its tasks `T12`**. The extension closes those tasks correctly. The engine's git sync matches nothing, so it never inserts the `Artifact(kind="code", commit_sha=…)` rows at line 787 — and those artifacts are exactly what the engine pushes in `assembleSnapshot` (`apps/engine/src/sync/loop.ts:203`), and all `freeze_build_tasks` has to work from (`apps/cloud/app/deployments/attribution.py:87`). No artifacts, no attribution: such a project closes its tasks in the editor and shows an empty "what's in this build" list forever.

A second divergence sits at the call sites rather than in the grammars. The extension passes a real branch ref (`apps/vscode/src/git/gitWatcher.ts:227`, resolved by `branchRefFor`, which suppresses the default branch at `apps/vscode/src/git/gitWatcher.ts:278`). Both cloud callers pass `None` (`apps/cloud/app/api/github.py:504`, `apps/cloud/app/api/github.py:590`) for a stated reason: a push to the default branch has no feature branch to read, and inferring one from `ref` would attribute every merge commit to whatever the branch was named for. That reasoning stays — but it means a team using `startTask` branches with bare commit subjects gets editor closure and zero server attribution, which is a product rule to document rather than an accident of two call sites.

**Recommendation: the extension's grammar wins**, unchanged — the most permissive of the three, already ported once, and attached to the surface developers actually use (ADR 0022's publication rule lives beside it in `apps/vscode/src/git/publication.ts`).

## Defect two — attribution is not frozen

`apps/cloud/app/deployments/attribution.py:8` states the rationale in its own docstring: "Frozen, not derived … so a force-push, a reassignment or a later edit cannot rewrite what somebody reviewed last Tuesday." The behaviour contradicts it.

`freeze_build_tasks` (`apps/cloud/app/deployments/attribution.py:65`) carries no "already computed" check. It re-reads the previous good SHA (`apps/cloud/app/deployments/attribution.py:35`), re-queries GitHub for the commit range, re-reads the current graph, and calls `repo.set_deployment_tasks` unconditionally at `apps/cloud/app/deployments/attribution.py:97`. Three call sites reach it — `apps/cloud/app/api/github.py:337`, `apps/cloud/app/api/github.py:381`, and the reconciliation sweep at `apps/cloud/app/deployments/reconcile.py:135` — so every applicable terminal delivery runs the whole thing again, and a redelivery after the graph changed rewrites history silently.

The write is also not atomic: the production adapter deletes the existing set and then inserts the new one in two separate calls (`apps/cloud/app/db/supabase_repository.py:371`, `apps/cloud/app/db/supabase_repository.py:374`), so a failure between them erases the record rather than leaving it stale. The abstract method's docstring (`apps/cloud/app/db/repository.py:191`) justifies replace-over-append as protection against double-counting on a second pass — a fair reason for the *replace*, but it assumes the second pass is wanted. It usually is not.

## Defect three — an empty result and an uncomputed result look identical

`repo.list_deployment_tasks` returns `[]` in both cases and nothing distinguishes them upstream: `_deployment_out` (`apps/cloud/app/api/deployments.py:173`) serialises the empty list and `apps/web/src/components/project/BuildTasks.tsx:36` renders one sentence for it. "This build contains no tasks" and "we never worked out what this build contains" are different facts, and the second is the one that matters: `_commits_in_build` swallows every exception and falls back to the head commit alone (`apps/cloud/app/deployments/attribution.py:54`), so a build frozen while the workspace PAT was broken is legitimately incomplete and today looks exactly like a build that closed nothing. An evidence chain whose gaps are invisible is not evidence.

---

## M1 — One reference grammar

Keep `apps/vscode/src/git/taskRefs.ts` as the single authority and make the other two provably derived from it.

For the engine, vendor a pinned copy at **apps/engine/src/git/taskRefs.ts** and have `syncTasksFromGit` import `refsForCommit`, `taskRefFromFeatureTag` and `collidingRefs` from it, replacing the regex at `apps/engine/src/routes/projects.ts:783` and the textual map at `apps/engine/src/routes/projects.ts:770`. A vendored copy rather than a shared workspace package, because `pnpm-workspace.yaml` is `apps/*` only and the repository already uses this exact pattern for `apps/vscode/src/git/git.d.ts`; here the drift tripwire is a byte-identity test, which costs one assertion. No code generation across the language boundary: the Python side stays a hand-written port, as its docstring already says.

Pin all three implementations to one committed case table: **docs/contracts/task-ref-cases.json**, an array of `{subject, branch_ref, expect}` records read as data by `apps/cloud/tests/test_task_refs.py`, `apps/vscode/test/unit/taskRefs.test.ts` and the new engine test. It is a specification artifact, not a package — no workspace entry, no build step, no dependency edge between apps. Alongside it, **docs/contracts/task-ref-grammar.md** states the rule in prose, including the branch-fallback asymmetry: the editor attributes from a feature branch, the server does not, and a team that wants server-side attribution must name the task in the subject.

The migration path for projects already numbering outside the narrower grammar is free: `syncTasksFromGit` re-reads the last 300 commits on every graph read (`apps/engine/src/routes/projects.ts:754`) and guards its artifact insert with a `hasArtifact` check, so widening the regex backfills every `T12`-style commit in that window on the next `GET /engine/projects/:id/graph`. Anything older is repaired by M2's recompute path. Separately, drop the `markDone` write at `apps/engine/src/routes/projects.ts:789` or gate it behind publication — ADR 0022 put status with the client that saw the push, and the engine cannot see one.

## M2 — Freeze once, atomically

Add **apps/cloud/migrations/0028_deployment_attribution.sql**: two columns on `pz_deployments` — `attribution_state text not null default 'uncomputed'` (`uncomputed` | `frozen`) and `attributed_at timestamptz` — plus a `pz_freeze_deployment_tasks(p_deployment_id uuid, p_task_ids uuid[])` function that returns early when the row is already `frozen` and otherwise deletes, inserts and stamps inside one transaction. The function precedent is `pz_rag_match_chunks` in `apps/cloud/migrations/0023_configurable_embed_dim.sql`; the client precedent is the `rpc` call at `apps/cloud/app/db/supabase_repository.py:930`. Apply with `apps/cloud/scripts/migrate.py`.

Mirror the fields on `Deployment` in `apps/cloud/app/models/schemas.py`, replace `set_deployment_tasks` with `freeze_deployment_tasks(deployment_id, task_ids, now) -> bool` across `apps/cloud/app/db/repository.py` and `apps/cloud/app/db/supabase_repository.py` (the in-memory backend enforces the same guard, so tests exercise the contract rather than one backend's habits), and make `freeze_build_tasks` return the stored set untouched when the deployment is already `frozen` — before the GitHub round trip, not after it.

The deliberate recompute path exists for one case and should be named for it: attribution that froze while the workspace PAT was missing or GitHub was unreachable, where `apps/cloud/app/deployments/attribution.py:54` swallowed the failure and fell back to the head commit alone, leaving an honestly incomplete set. Expose it as an admin-only `POST /projects/{id}/deployments/{deployment_id}/reattribute` in `apps/cloud/app/api/deployments.py`, which clears `attribution_state`, re-runs the freeze and records that a correction happened. Nothing else may clear the flag; the three existing call sites become no-ops on a second delivery.

## M3 — Make the progress view tell the truth

The rollup already reaches for this: `shippedTaskIds` (`apps/web/src/components/project/ProgressRollup.tsx:16`) unions the task sets of every `live` row in `recent`, and line 45 counts how many of a requirement's done tasks are in it. Two things make that number untrustworthy.

First, a frozen set is a *delta* — commits since the previous successful build — so a cumulative "is it live" answer must union the live builds **up to and including the one currently being served**, and no further. Today `apps/web/src/components/project/ProgressRollup.tsx:18` unions all of them regardless of whether a later build rolled back past an earlier one's work. Bound the union at the row whose URL matches the status `url`, falling back to the newest `live` row.

Second, the count must be suppressed rather than guessed when a contributing build is `uncomputed`. Add `attribution_state` to `DeploymentOut` in `apps/cloud/app/api/deployments.py` and to the web `DeploymentStatus` type, and render "not yet recorded" in that case; the `shipped.size > 0` guard at `apps/web/src/components/project/ProgressRollup.tsx:57` conflates the two cases and must go. Only then is ADR 0023 decision 5's promised line — "7 of 12 tasks, 5 of them in the version you can open" — a claim the platform can stand behind. Apply the same split at `apps/web/src/components/project/BuildTasks.tsx:36`: two sentences, one for a build that closed nothing, one for a build never attributed.

## M4 — Tests

**Grammar parity.** All three suites load the shared case table and assert identical results; the engine gains a first `taskRefs` unit test under `apps/engine/test` (`node --test`) plus a byte-identity assertion against the extension copy. Cases: `T12` and `T0003` attribute; `T001` and `T1` collide to one key; a `Revert "…"` subject yields nothing from subject *or* branch; `SPRINT12` and `TEST-12` yield nothing; `feature/t12_retry` resolves from a branch, in the extension only; a subject naming eleven tasks stops at ten; a project holding both `T012` and `T12` blocks that ref.

**Freeze.** Extend `apps/cloud/tests/test_build_attribution.py` and `apps/cloud/tests/test_deployment_tasks.py` with: a redelivery after the graph changed — freeze, add a code artifact, redeliver the terminal webhook, assert the stored set is unchanged and no GitHub call was made; a build with genuinely no attributable tasks — `attribution_state == "frozen"` with an empty list, rendered as the "closed nothing" copy; an uncomputed build — the rollup suppresses its count; atomicity — the Supabase adapter issues exactly one RPC and never a bare delete; the reconciliation sweep no longer overwrites a frozen set; and the recompute endpoint 403s for a non-admin and widens the set once a working token is available.

**Web.** Extend `apps/web/src/components/project/ProgressRollup.test.tsx` for the bounded union and the suppressed count, and `apps/web/src/components/project/BuildTasks.test.tsx` for the two empty states. Run `pnpm --dir apps/web test` and `typecheck`; `pytest` and `ruff check .` in `apps/cloud`.

---

## What this unlocks

An auditor does not ask whether a chain exists; they ask whether it can be changed after the fact and whether its gaps are visible. Today a redelivery silently rewrites it and a gap is indistinguishable from a zero. After this plan a build's task set is written once, under a recorded state, with any correction deliberate and attributable.

That is the precondition for `0023-compliance-as-the-product.md`. Exporting which requirements a regime touched and which controls a build satisfies is only worth building on an evidence graph that is frozen, complete, and honest about what it does not know. This plan is the cheaper half of that work and should land first.
