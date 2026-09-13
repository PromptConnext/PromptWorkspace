# ADR 0020 — The cloud is the source of truth; the local graph becomes a cache

**Date:** 2026-08-13 · **Status:** **Accepted 2026-09-13** · **Deciders:** product + engineering

> **Accepted 2026-09-13.** The cloud is authoritative for the task graph; the local graph is a cache. Implementation is sequenced in [plan 0012](../plans/0012-close-the-write-path.md), whose M1 — disabling the engine's interval graph push — is the urgent step this ADR named and is starting first.
>
> Two corrections to the record below, found while planning. The module docstring in `apps/cloud/app/api/sync.py` has already been rewritten and no longer asserts local authority, so it should come off this ADR's documentation-debt list. And two of the six gaps under *What this requires that does not exist yet* have since shipped: the task-status PATCH and the cross-project assigned-tasks read both exist. The remaining four are real and are what plan 0012 covers.

**Prompted by the decision:** *planning, task generation, AI coding rules, the repository constitution and task management now live in the cloud. The desktop's job is to help a developer execute assigned tasks against a local repository — not to plan.*

**Supersedes:**

- **ADR 0003** (SQLite graph, zero cloud in the skeleton) on the authority question only. Its structural choice — a local `node:sqlite` graph — survives; its claim that "the local engine is the sole source of truth" does not.
- **ADR 0010** (task-graph sync model) on direction. The cloud graph stops being "a projection of the local SQLite schema." The local graph becomes a projection of the cloud.

**Amends:** ADR 0018 (task assignment) — generalizes its narrow single-field pull into the default mechanism. ADR 0015 (cloud-projected roster) — extends the roster's cloud-authoritative treatment from workspaces and project metadata to the task graph itself, which is the direction that ADR already pointed. ADR 0013 and ADR 0017 are unaffected in substance; both already assume cloud-side authoring.

**Does not decide** which application hosts the developer experience. That is [ADR 0019](0019-desktop-as-vscode-extension.md), which depends on this one.

---

## Context

### What the record currently says, and why that is now a liability

At least ten places in this repository assert local authority, in language that leaves no wiggle room. ADR 0003: "The local engine is the sole source of truth." ADR 0010: "each desktop engine owns a local `node:sqlite` task graph that is the **offline source of truth**." ADR 0015 says it three more times ("Projects are local-authoritative", "**local-authoritative** for AI-native fields", "the engine remains source of truth for *what's inside* a project") and ADR 0016 once ("stays the local source of truth"). `docs/promptzone-platform-architecture.md` says it four times — "the task graph stays **local-authoritative**", "Source of truth while offline", "the graph is local-authoritative as usual", "the desktop engine is the offline source of truth". It is asserted in code comments too, in `apps/engine/src/backup.ts` and `sync/loop.ts` ("local SQLite stays the detailed source of truth"). And the cloud's own `apps/cloud/app/api/sync.py` opens with a module docstring stating "The local engine is the source of truth; the cloud holds the shared graph."

None of that describes the product any more. Planning moved to `apps/cloud/app/generation/` — whose `service.py` docstring already concedes it "is the cloud-side equivalent of the engine's `runStage()`". Task generation, the repository constitution, the seeded `AGENTS.md`, task assignment and the project lifecycle state machine are all cloud-side and shipped. The desktop has not caught up, and neither has the record.

This is not pedantry about documents. The sync loop is *built* to the old model, so the drift is executable: `apps/engine/src/sync/loop.ts` pushes a full local snapshot every twenty seconds — requirements, spec documents, tasks, artifacts, agent runs — over cloud state that is now the authored original. Left alone, a desktop that opens a cloud-planned project will overwrite the cloud's own planning output with whatever its local tables happen to contain. The inversion has to be decided before it can be implemented, and it cannot be implemented safely against a record that says the opposite.

### What the desktop is for now

Six responsibilities, and planning is not among them: pull assigned tasks from the cloud; display project context and AI coding rules; integrate with the local clone and its origin, provisioned from the Tech Lead's plan (ADR 0017); make it easy to hand a task to the developer's own AI assistant; let developers commit and push with an ordinary Git workflow; and — the new one — **sync task status back from the desktop, so a developer never switches to the web app just to mark something done.**

Business stakeholders are served by the cloud, including the deployed preview environment where they review progress without touching a development machine. They have no reason to install anything. That single fact retires most of what the desktop was carrying.

---

## Decision

**1. The cloud is authoritative for the task graph.** Requirements, spec documents, tasks, acceptance criteria and the stage documents are authored in the cloud and flow *down*. The local SQLite graph is a **cache**: it may be deleted and rebuilt from the cloud without loss, and nothing in it is uniquely valuable.

**2. The desktop writes exactly three things upward, each through a purpose-built endpoint.** Task status; artifacts that evidence a status change (the commit that closed a task); and discussion replies. Everything else is read-only on the desktop. No full-graph push from a desktop client, ever.

**3. Retire the local planning path rather than re-pointing it.** `runStage()`, its six Spec Kit templates, the local stage routes and the approval gates are deleted, not adapted. They now have a cloud twin — including a duplicated task-line grammar (`agent/loop.ts::parseTaskLines` and `app/generation/parsing.py::parse_task_lines` parse the same `- [ ] T001 [P]` format) — and maintaining two implementations of a workflow only one side runs is how the vocabularies drifted in the first place.

**4. Offline means read-only-plus-queue, not local authority.** A developer offline can read every cached task, its context and the coding rules, and can keep working in Git. Status changes are queued and flushed on reconnect. This is a deliberate reduction from ADR 0003's guarantee, and it is the correct one: a task graph the developer did not author and cannot legitimately diverge from is not something they need write authority over.

**5. Fix the two-vocabulary problem at the source rather than mapping around it.** See below — this is the sharpest hazard the inversion creates, and mapping tables are what make it dangerous.

---

## What this requires that does not exist yet

The cloud is not ready to serve a task client. Six gaps, in rough dependency order. None is large; together they are the real cost of this ADR.

**A task-status write endpoint.** Today the only path is `PUT /sync/projects/{id}/graph` (`app/api/sync.py:334`), which takes a full `Task` model. `Task` requires `title` — and `title` is `"shared"` authority in `FIELD_AUTHORITY` (`app/models/schemas.py:414`), so a naive "mark done" push also overwrites the title and can clobber a Jira mirror's rename. Worse, `acceptance_criteria` is `"pz"` authority and a full list, so a Task serialized without criteria merges an empty list over the cloud's — a `model_dump` cannot distinguish "unset" from "clear". That is precisely the hazard `_OMIT_IF_UNSET` was added for (`app/db/merge.py:37`), and `acceptance_criteria` is not in that set. **Add `PATCH /projects/{project_id}/tasks/{task_id}/status`, mirroring the assignment endpoint** (`sync.py:301`) — whose repository implementations are 13 and 16 lines (`app/db/repository.py:719`, `app/db/supabase_repository.py:465`), so the twin is close to a copy. `status` is already `"pz"` authority (`schemas.py:415`), so the merge gate passes; the problem is purely the shape of the write, not permission.

**Aligned status vocabularies.** Three exist. The engine uses `todo | running | done | failed`, enforced by nothing — `db.ts:36` declares `status TEXT NOT NULL DEFAULT 'todo'` with no CHECK constraint, and the vocabulary is implicit in six scattered write sites. The cloud uses `todo | in_progress | implemented | verified` (`app/models/schemas.py:56`). Between them sit two mapping tables in `sync/loop.ts:19` and `:522`, and both are lossy in ways that only bite once tasks round-trip: `failed → todo` upward erases a failed run, and **`implemented` and `verified` both collapse to `done` downward**, so a desktop that pulls a `verified` task and later pushes its status silently demotes it. Today no task round-trips, so this is latent. Under this ADR every task round-trips. **Align the two vocabularies and delete the maps** rather than adding a third state to them.

**A "my assigned tasks" read.** None exists — not cross-project, not even project-scoped. A desktop must call `GET /workspaces`, then `GET /workspaces/{id}/projects`, then `GET /sync/projects/{id}/graph` per project and filter `assigned_user_id` client-side. That is workable for a first cut and untenable as the roster grows.

**A local schema that can hold a pulled task.** `apps/engine/src/db.ts` declares `spec_id TEXT NOT NULL REFERENCES spec_documents(id)`, and `applyGraphPage` in `sync/loop.ts` skips any task lacking one — "a task with no spec has no local parent to attach to". A desktop that never generates specs locally therefore **cannot insert a task it just received.** Either keep pulling spec documents as context (defensible — a developer wants to read the spec) or drop the foreign key. This is a hard blocker on the pull path and the first thing to fix.

**An `AGENTS.md` read path.** The constitution is authored in the cloud (`app/api/stage_documents.py:47`) and seeded once into the repository at tech-review exit (`app/integrations/repo_seed.py:98`) under a preamble that says "edit freely — never overwritten." So the file and the stage document drift by design, and there is no API that returns the file. A desktop showing "the AI coding rules for this project" should read `AGENTS.md`, `docs/conventions.md` and `.specify/memory/constitution.md` **from the clone**, treating git as the distribution channel and the stage document as provenance. This is the right answer anyway: it is what the developer's own agent will read.

**Task-stage projection.** `app/generation/projection.py:16` deliberately does not project the `tasks` stage into graph entities — editing the tasks markdown changes the document, not the board. A Tech Lead who hand-edits tasks produces no `Task` rows, so a desktop board would be silently stale. Under local authority this was invisible because the engine generated tasks itself. Under cloud authority it is a correctness gap that needs either projection or an explicit "regenerate to apply" affordance in the web UI.

---

## What inverts in the sync loop

The transport is already there; the direction is not. `GET /sync/projects/{id}/graph` supports `since`, `limit`, `after_ts` and `after_id` (`sync.py:392`), and three engine functions already consume it: `pullProjectDiscussions` and `pullProjectTaskAssignments` are single-field keyhole readers, and `hydrateProjectGraph` (`sync/loop.ts:674`) is a full keyset-paginated bootstrap that runs exactly once per project per machine, from `routes/cloud.ts:291`.

The mechanical change is therefore smaller than it sounds: **promote `hydrateProjectGraph` from a one-shot bootstrap to the interval pull, driven by `since=`.** `applyGraphPage` already knows how to upsert every entity type. What must go is `assembleSnapshot` (`sync/loop.ts:126–300`, 175 lines building the full push) and the push side of the loop, replaced by a queue that flushes discrete status writes. `GET /sync/projects/{id}/changes` (`sync.py:374`) — a cheap "is anything new" probe with zero engine consumers today — becomes worth using.

Two mechanisms survive untouched and should be preserved deliberately: the 404-quarantine that marks a link broken when a cloud project disappears (`markLinkBroken`, `sync/loop.ts:103`, covered by `apps/engine/test/sync-quarantine.test.ts`), and the conflict surfacing that returns dropped fields from the merge gate and persists them for `GET /engine/projects/:id/cloud-sync`. Under an inverted flow conflicts get *rarer*, not absent, and the reporting path is the only thing that makes a silent drop visible.

**Git truth-keeping survives and gets better.** `syncTasksFromGit` (`apps/engine/src/routes/projects.ts:751`) scans the last 300 commit subjects for `\bT\d{3}\b`, attaches an artifact and marks the task done. It is a scan-on-read from the graph endpoint, per ADR 0007. Under this ADR it stops writing local SQLite and instead becomes the natural *producer* of the status writes decision 2 allows — a developer commits `T003: add retry`, pushes, and the task closes in the cloud without anyone opening a browser. That is precisely the "sync status from the desktop" requirement, delivered by a mechanism that already exists. Note its two sharp edges before relying on it: the ref regex matches exactly three digits, so `T12` and `T0003` are invisible, and the 300-commit window means an old close can fall out of scan range.

---

## Consequences

- **Positive:** one planning implementation instead of two, and the duplicated task-line grammar collapses. Roughly 2,000 lines of local stage generation, model onboarding, approval gating and local agent orchestration become deletable. The desktop stops being able to corrupt cloud planning state, which today it structurally can. Task status finally closes the loop from the place developers actually work.
- **Negative / accepted trade-offs:** ADR 0003's offline guarantee is materially reduced — a first-run developer with no network gets nothing, where previously they got a fully functional local product. This is acceptable because ADR 0015 already made a cloud identity mandatory to reach the workspace at all; the offline story was already conditional on a prior online session. `backup.ts` loses its rationale (it existed because local SQLite was the only copy) and should be retired rather than maintained as a cache backup, which is meaningless.
- **Risk — the window between decision and implementation is dangerous.** Until the push side is removed, any desktop that opens a cloud-planned project runs `assembleSnapshot` against it every twenty seconds. **Disable the task/requirement/spec push before anything else in this ADR**, ahead of the pull work, even though that leaves the desktop temporarily read-only. A read-only desktop is a degraded product; a desktop that overwrites the Tech Lead's plan is a data-loss incident.
- **Documentation debt to clear:** `docs/promptzone-platform-architecture.md` (four assertions), ADR 0015 (three) and ADR 0016 (one), the `apps/cloud/app/api/sync.py` module docstring, and the code comments in `apps/engine/src/backup.ts` and `sync/loop.ts` all still state local authority and must be corrected, not left to be discovered by the next reader.

## Alternatives rejected

- **Keep local authority and treat the cloud as a collaboration mirror.** This is ADR 0010's model and it is coherent — but it requires the desktop to author, which contradicts the product direction and would mean maintaining the local Spec Kit stage runner permanently alongside the cloud's. Rejected as a strictly larger system delivering a workflow the product no longer wants.
- **Bidirectional merge with per-field authority as the general mechanism.** The field-authority machinery exists (`app/db/merge.py`) and works, but it was built to arbitrate between a local author and a tracker mirror. With a single author it is ceremony: three writable fields do not need a merge engine. Keep `FIELD_AUTHORITY` for the Jira/ClickUp mirror, which still has two writers.
- **Let the desktop push status through the existing full-graph endpoint.** Rejected on the `title` and `acceptance_criteria` clobber hazards above. ADR 0018 already refused this for assignment and built a dedicated route; status has the same shape and deserves the same answer.
- **Drop the local SQLite cache entirely and read the cloud live.** Tempting once authority moves, and it would delete `db.ts` outright. Rejected because a developer's task list should render instantly and survive a flaky connection — and because the cache is what lets status writes queue offline. Keep it; just stop calling it the source of truth.

## Notes for the implementing agent

- **Sequence matters more than usual here.** Order: (1) disable the graph push; (2) drop or satisfy the `spec_id NOT NULL` FK; (3) align status vocabularies and delete the mapping tables in `sync/loop.ts:19` and `:522`; (4) add `PATCH /projects/{id}/tasks/{id}/status`; (5) promote `hydrateProjectGraph` to the interval pull with `since=`; (6) wire `syncTasksFromGit` to emit status writes instead of local `UPDATE`s.
- When adding the status PATCH, copy the *permission shape* of `assign_task` as well as its structure, and stamp `field_versions["status"] = {"source": "pz"}` the way both repository implementations already do for assignment.
- Do not add `verified` to the engine's vocabulary as a synonym for `done`. Either the engine learns the cloud's four states or the cloud drops to the engine's — pick one; a fifth mapping entry is how this became lossy.
- Preserve the quarantine and conflict-reporting tests (`apps/engine/test/sync-quarantine.test.ts`, `wp2-conflicts.test.ts`, `apps/cloud/tests/test_merge.py`) through the inversion. If a test no longer applies, delete it deliberately with a note — do not let it rot into a passing tautology.
- `agent/loop.ts` is not wholly dead: `commitFiles()` is imported by `agent-runner.ts`, and `changedFiles()` in `agent-runner.ts` is reusable. `commitAll()` is called only from `runStage` and `runImplementation` inside `loop.ts` itself — both dead — so it is free to delete unless the extension wants it. Extract before deleting the file.
- Correct the local-authority assertions listed under Consequences in the same change that lands the inversion, so the record never describes a system that does not exist.
