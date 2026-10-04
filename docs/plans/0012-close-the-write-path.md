# Plan 0012 — Close the write path

**Date:** 2026-09-12 · **Status:** M1 implemented; M2–M5 superseded by [ADR 0028](../decisions/0028-desktop-repurposed-for-business-users.md). Retiring `PUT /sync/projects/{id}/graph` and the engine's manual push is [plan 0029](0029-agent-native-delivery.md) phase 0 · **ADR:** [0020](../decisions/0020-cloud-is-the-source-of-truth.md)

This plan stops an active data-loss path. ADR 0020 made the cloud authoritative for the task graph and gave one sequencing instruction above all others: disable the full-graph push from the engine before anything else, ahead of the pull work, even though that leaves the desktop temporarily read-only. That step was skipped. `startCloudSyncLoop` (`apps/engine/src/sync/loop.ts:494`) still calls `pushProjectSnapshot` on every tick at `apps/engine/src/sync/loop.ts:498`, and `assembleSnapshot` (`apps/engine/src/sync/loop.ts:126`) still builds a complete local picture of requirements, spec documents, tasks, artifacts and agent runs and sends it over cloud state that is now the authored original. The loop starts unconditionally at engine boot (`apps/engine/src/index.ts:64`), on a twenty-second default timer (`apps/engine/src/sync/loop.ts:12`).

The cloud has already built most of its half of the inversion since the ADR was written, which shortens this plan considerably: the status write exists at `apps/cloud/app/api/sync.py:566` with the permission shape ADR 0020 asked for (and refuses `verified` to a non-admin), the cross-project "what is assigned to me" read at `apps/cloud/app/api/me.py:27`, and the cheap change probe at `apps/cloud/app/api/sync.py:657`. What has not happened is on the engine side, and it is the dangerous half.

**Decisions locked (ADR 0020):** the local SQLite graph is a cache that may be deleted and rebuilt without loss; the desktop writes exactly three things upward — task status, the artifact that evidences it, and discussion replies — each through a purpose-built endpoint; no full-graph push from a desktop client, ever; offline means read-only-plus-queue; and the two status vocabularies are aligned at the source rather than mapped around.

---

## Milestone 1 — Disable the push

**Urgent, shippable on its own, and independent of the desktop decision.** Do not bundle it with anything below.

The change is small and lives in two places. In `startCloudSyncLoop` (`apps/engine/src/sync/loop.ts:494–504`), delete the `await pushProjectSnapshot(projectId).catch(() => {});` at line 498 so the interval body retains only `pullProjectDiscussions` and `pullProjectTaskAssignments`. In `apps/engine/src/routes/cloud.ts:484` the same call fires immediately after a local discussion insert so a comment feels synchronous; that one must also go, because it pushes the whole snapshot, not the discussion. A reply is one of the three legitimate upward writes, so replace it with a discussion-scoped write — or, if that endpoint is not ready in the same change, let the reply sit local-only and say so in the route comment.

`assembleSnapshot` (`apps/engine/src/sync/loop.ts:126–300`, 175 lines) and `pushProjectSnapshot` (`apps/engine/src/sync/loop.ts:322`) stay in the tree for now, reachable only from the manual route at `apps/engine/src/routes/cloud.ts:418`. Keeping the explicit, user-initiated path alive while killing the timer is what makes M1 a one-line-risk change instead of a refactor; M4 deletes the assembler.

**The deliberate consequence:** the desktop becomes read-only against the cloud. ADR 0020 accepts this explicitly — a read-only desktop is a degraded product, while a desktop that overwrites the Tech Lead's plan is a data-loss incident.

**What must not break.** Two mechanisms are load-bearing and both have tests. The 404 quarantine: a definitive 404 calls `markLinkBroken` (`apps/engine/src/sync/loop.ts:103`), and `linkedProjectIds` (`apps/engine/src/sync/loop.ts:113`) then filters the link out of the loop; its tests are `apps/engine/test/sync-quarantine.test.ts`, whose interval assertion at `apps/engine/test/sync-quarantine.test.ts:108` expects *no* request at all for a broken link — still true once the push is gone, because the pulls are filtered by the same list. Conflict surfacing: `pushProjectSnapshot` threads the cloud's `conflicts` map into the stored `SyncResult`, pinned by `apps/engine/test/wp2-conflicts.test.ts:97`. That test drives `pushProjectSnapshot` directly rather than the timer, so it keeps passing unchanged — the point of keeping the manual route.

**Test M1:** `node --test apps/engine/test/sync-quarantine.test.ts apps/engine/test/wp2-conflicts.test.ts` passes untouched. Add one case to the quarantine file's shape: with a *healthy* link, two interval ticks produce only `GET` requests against `/sync/projects/{id}/graph` and no `PUT`. That single assertion is the regression guard for this whole plan.

---

## Milestone 2 — Align the vocabularies, delete both maps

Two mapping tables sit between the engine and the cloud. Upward, `TASK_STATUS_TO_CLOUD` at `apps/engine/src/sync/loop.ts:19–26` maps the engine's four states onto the cloud's: the initial open state to itself, `running` to `in_progress`, `done` to `implemented`, and `failed` back to the initial open state. Downward, `TASK_STATUS_FROM_CLOUD` at `apps/engine/src/sync/loop.ts:522–527` maps the cloud's four states back: the initial open state to itself, `in_progress` to `running`, and **both `implemented` and `verified` to `done`**. The cloud's enum is `TaskStatus` at `apps/cloud/app/models/schemas.py:56–60`. The engine's is implicit — `apps/engine/src/db.ts:36` declares the column as `status TEXT NOT NULL DEFAULT` the open state with **no CHECK constraint**, so nothing in the engine's schema constrains the value at all; the vocabulary lives only in scattered write sites such as `apps/engine/src/routes/projects.ts:653`, `:695`, `:712` and `:778`.

Both maps are lossy, in opposite directions. Upward, `failed` has no cloud equivalent and is erased into the open state, so a failed run round-trips as work never started. Downward, two distinct cloud states collapse onto one, so a desktop that pulls a `verified` task holds it as `done` and, the moment that status is pushed back, re-enters it in the cloud as `implemented` — a silent demotion of a review decision the desktop never had authority over. Today no task round-trips, so this is latent; under ADR 0020 every task round-trips.

**Recommendation: the engine adopts the cloud's four states verbatim and both maps are deleted.** ADR 0020 is explicit that a fifth mapping entry is how this became lossy, and the direction follows from authority: the cloud authors the vocabulary, so the cache should speak it. It also makes local rows directly comparable to what the status endpoint accepts, which M4 and M5 depend on. The cost is bounded — `failed` disappears, but the agent-run failure it recorded is already carried by `agent_runs.status` (`apps/engine/src/routes/projects.ts:713`), and `running` becomes `in_progress` at the write sites listed above.

Add the constraint the engine never had, so the vocabulary stops being implicit: a `CHECK (status IN (...))` on the `tasks` table in `apps/engine/src/db.ts:32–39`. Because `SCHEMA` is `CREATE TABLE IF NOT EXISTS` that only reaches fresh installs; existing databases need a one-time remap at startup for the two renamed values, and under M3's "rebuild the cache" option not even that.

**Test M2:** `node --test apps/engine/test/*.test.ts`; then a focused test asserting a graph page carrying a `verified` task lands locally as `verified`, not as `done`.

---

## Milestone 3 — Satisfy or drop the `spec_id` foreign key

ADR 0020 names this a hard blocker on the pull path. `apps/engine/src/db.ts:34` declares `spec_id TEXT NOT NULL REFERENCES spec_documents(id)`, and `applyGraphPage` at `apps/engine/src/sync/loop.ts:622` skips any task lacking one with the comment "a task with no spec has no local parent to attach to". A desktop that never generates specs locally therefore cannot insert a task it just received. The ADR's two options, by its own names:

**Keep pulling spec documents as context.** Defensible — a developer wants to read the spec, and `applyGraphPage` already upserts `spec_documents` at `apps/engine/src/sync/loop.ts:618`. But it makes every pulled task's insertability depend on page ordering and on the cloud having projected a spec at all, which `apps/cloud/app/generation/projection.py` does not guarantee for hand-edited stage documents.

**Drop the foreign key.** Recommended. Make the column nullable, remove the `REFERENCES` clause, and delete the skip at `apps/engine/src/sync/loop.ts:622`. Keep pulling spec documents anyway for context — the point is only that a task no longer *depends* on one. Note that `syncTasksFromGit` joins through `spec_documents` (`apps/engine/src/routes/projects.ts:763–766`); that join must become a left join or be re-rooted on a project column, or M5 silently stops seeing pulled tasks. Since the local graph is a cache, the migration is legitimately "delete the file and re-hydrate".

**Test M3:** hydrate a project whose cloud graph contains a task with a null `spec_id` and assert the row exists locally afterwards, with its acceptance criteria.

---

## Milestone 4 — Invert the loop

Promote `hydrateProjectGraph` (`apps/engine/src/sync/loop.ts:674`) from a one-shot bootstrap — today called once per project from `apps/engine/src/routes/cloud.ts:297` — into the interval pull, driven by `since=`. The machinery is there: `applyGraphPage` (`apps/engine/src/sync/loop.ts:608`) already upserts every entity type, and `pull_graph` (`apps/cloud/app/api/sync.py:675`) already accepts `since`, `limit`, `after_ts` and `after_id`. The change is a stored cursor per project, in the same shape `pullCursorKey` (`apps/engine/src/sync/loop.ts:425`) and `assignmentsPullCursorKey` (`apps/engine/src/sync/loop.ts:464`) already use — and those two keyhole readers then collapse into the general pull, since discussions and `assigned_user_id` arrive on the same page.

Gate the pull on the cheap probe: `changes_head` (`apps/cloud/app/api/sync.py:657`) returns `has_changes` for a `since` cursor and **has no engine consumer today**, so calling it first turns the common idle tick into one small request instead of a full graph page.

Then delete `assembleSnapshot` and `pushProjectSnapshot` along with `REQUIREMENT_STATUS_TO_CLOUD` (`apps/engine/src/sync/loop.ts:28`), retire the manual push route at `apps/engine/src/routes/cloud.ts:418`, and replace them with a durable queue of discrete status writes. Copy the extension's queue rather than reinventing it: `apps/vscode/src/tasks/queue.ts` dedupes by task id (status is a scalar, so last-write-wins makes replay safe) and `apps/vscode/src/tasks/statusWriter.ts` queues on 5xx or network error and drops on any 4xx. Update the module header at `apps/engine/src/sync/loop.ts:1–7` and the closing note at `apps/engine/src/sync/loop.ts:713`, both of which still describe a push-only engine.

**Test M4:** against the fake-cloud harness the engine tests already use, assert that a status change queues and flushes as a `PATCH`, that a 403 drops the entry instead of retrying, and that two ticks with an unchanged cursor issue only the `changes` probe.

---

## Milestone 5 — Wire git truth-keeping to emit status writes

`syncTasksFromGit` (`apps/engine/src/routes/projects.ts:751`) is the natural producer of those writes. It runs best-effort on every graph read (`apps/engine/src/routes/projects.ts:800`), scans commit subjects, attaches the commit as an artifact and marks the task done at `apps/engine/src/routes/projects.ts:778`. That local `UPDATE` becomes an enqueued status write carrying the artifact — which is what the endpoint's `body.artifact` is for (`apps/cloud/app/api/sync.py:604–612`), evidence written before the status so a task is never closed with its artifact missing.

Its two sharp edges, both named by ADR 0020, must be stated wherever this is relied on. The reference regex at `apps/engine/src/routes/projects.ts:783` is `/\bT\d{3}\b/g` — exactly three digits, so `T12` and `T0003` are invisible, and the comparison at `apps/engine/src/routes/projects.ts:770` is textual against `feature_tag`, so even a widened regex would not match `T12` to `T012`. And the scan window at `apps/engine/src/routes/projects.ts:754` is `git log … -n 300`, so an old close can fall out of range and never be seen.

The VS Code extension already solved both in its own parser: `TASK_REF_RE` at `apps/vscode/src/git/taskRefs.ts:12` is `/\bT(\d{1,6})\b/g` and `normalizeTaskRef` (`apps/vscode/src/git/taskRefs.ts:41`) compares numerically. The two surfaces therefore disagree about what a task reference is. **Reconciling them into one grammar is plan 0024's job, not this one.** Here, match the extension if it is free to do so; otherwise leave the engine's narrower pattern and record the divergence — do not invent a third grammar.

**Test M5:** a repository whose `HEAD` subject names a task produces exactly one queued status write with the commit sha as its artifact, and a second graph read produces none (idempotence, the job the `hasArtifact` check at `apps/engine/src/routes/projects.ts:772` already does).

---

## Both desktop branches

M1 is identical under both branches and must ship regardless. The push is dangerous whether or not the desktop has a future.

**Under "retire"** (ADR 0019 carried, `apps/desktop` and `apps/desktop-theia` deleted), M2 through M5 mostly become deletion. The extension already speaks the cloud's vocabulary, reads `/me/tasks` (`apps/vscode/src/cloud/client.ts:216`), writes status through `patchTaskStatus` (`apps/vscode/src/cloud/client.ts:257`) and has the offline queue M4 specifies. There is no cache to align, no foreign key to drop, no loop to invert — `apps/engine/src/sync/loop.ts` goes away with the engine, along with `runStage` (`apps/engine/src/agent/loop.ts:116`) and `runImplementation` (`apps/engine/src/agent/loop.ts:197`). ADR 0020's note applies: extract `commitFiles` (`apps/engine/src/agent/loop.ts:164`) before deleting that file, since `agent-runner.ts` imports it. M5 survives only as the extension's push-driven close (ADR 0022).

**Under "fund"**, M2 through M5 are the build described above, in that order. The one addition is that the extension's queue and the engine's queue then both write status, so they must agree on dedupe semantics or a developer working in both sees a status flap.

The decision itself is [0011](0011-desktop-decision-gate.md). Do not wait on it to start M1.

## Out of scope

The permission model on `push_graph` (`apps/cloud/app/api/sync.py:617`) belongs to plan [0015](0015-full-graph-write-permissions.md). That route checks project membership only, while `set_task_status` and `assign_task` enforce task ownership and admin-only review states; whether it is retired, constrained or left for tracker mirrors is a permission question, not a sync-direction one. This plan removes the engine as a *caller*; 0015 owns what the endpoint may still accept from anyone else. Preserve `apps/cloud/tests/test_merge.py`, `apps/cloud/tests/test_task_status.py` and `apps/cloud/tests/test_sync.py` through both.

## Suggested commit sequence

1. `fix(engine): stop pushing the full graph on the sync interval (M1)` — urgent, shippable alone.
2. `refactor(engine): adopt the cloud task-status vocabulary, delete both maps (M2)`.
3. `refactor(engine): drop the spec_id foreign key so pulled tasks insert (M3)`.
4. `feat(engine): interval pull with a cursor, status-write queue replaces the push (M4)`.
5. `feat(engine): git truth-keeping emits status writes instead of local updates (M5)`.
