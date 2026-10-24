# Local agent plans an imported repository

**Date:** 2026-10-24 · **Status:** Design, awaiting approval · **Builds on:** [plan 0027](../../plans/0027-brownfield-repo-import.md) (brownfield import), [plan 0025](../../plans/0025-mcp-server.md) (MCP server), [plan 0029](../../plans/0029-agent-native-delivery.md) (agent-native delivery), ADR 0017, ADR 0027

## Intent

An imported repository is planned today by the managed Typhoon model from a snapshot: 30k characters of excerpts, 24k of source outlines, a 3k header and an 8k path list, all stuffed into one prompt per stage. The model cannot open a file it was not given, cannot grep a call site, cannot run the tests, and is the weakest model in the chain. For any repository larger than a toy, the constitution, specification, plan and tasks it writes describe a codebase it mostly never saw.

The person who imported the repository already has it cloned and already has a capable coding agent on their machine (Claude Code, Cursor, anything that speaks MCP). That agent can read the whole tree, trace calls, run the test suite and reason with a frontier model. This design moves the *reading and drafting* of an imported project's planning documents to that local agent, and keeps *storage, gating, review and governance* in the cloud.

Why now: plan 0029 already decided the platform's direction is agent-native, with the MCP server as the agent's door into the cloud. This is the first planning-side use of that door. It also makes brownfield import, the path every real customer arrives by, produce documents a Tech Lead will not have to rewrite.

## Goals

- An imported project's codebase baseline, constitution, specification, plan and tasks are drafted by a local agent from the full clone, not by Typhoon from a snapshot.
- The person who imported the project follows a short checklist shown in the web Planner and does one sitting in their terminal. All four stage drafts arrive from that one sitting.
- Every draft lands in the cloud as a pending draft. A human reads, edits and accepts each one in the web Planner. Nothing becomes a Requirement, SpecDocument or Task row until accepted.
- Accepting a draft runs the exact code path Typhoon output runs today, so task refs, phase grouping, retirement, graph projection and the tasks board are unchanged.
- The `repo_analysis_required` gate keeps its meaning: `plan` and `tasks` stay closed until a baseline exists.
- Today's per-stage authorship rules are unchanged: members may author `specify` and `tasks`, admins alone author `constitution`, `plan` and the baseline.

## Non-goals

- From-scratch projects. They keep Typhoon generation exactly as today.
- Typhoon as the offered path for imported projects. The web stops offering Generate and Prefill for them. Hand editing in the web stays, and the Typhoon routes stay reachable for an admin who calls them.
- Metering. Agent-written drafts are not charged against the ADR 0027 daily budget. Recorded as an open pricing item for plan 0022; the user chose to leave imports unmetered for now.
- MCP over HTTP, device-code login, npm publish, running the agent in customer CI. Those are plan 0025 M4 and plan 0029 M3. This design works over the stdio server that exists today and must not block on M4.
- A stage-by-stage round trip where the human accepts one stage before the agent drafts the next. One sitting was chosen; the stale-draft consequence is handled below, not avoided.
- Protecting the customer's agent from prompt injection in their own repository. That is the same exposure as any use of a coding agent on an untrusted tree, and it is theirs.

## Anti-goals

- A second parser, a second task format, or a second graph projection "for agent output". If the agent's markdown does not parse through `parse_stage_output` and `parse_task_lines`, the fix is in the brief the agent receives, not a new parser.
- Cloud fetching repository content on the agent's behalf. The point is that the clone is local. The cloud reads no more of the repository than it does today, and for imported projects it may read less.
- A fork of the MCP server. Tools are added to `apps/mcp`, with the same login, keychain and config.
- A second snapshot shape. The agent fills the same `RepoSnapshot` the cloud builds today, so every downstream reader (stage context, path warnings, Typhoon second opinion) works unchanged.

## Constraints

- `apps/mcp` is stdio only, launched by the MCP client, authenticated by the pasted-code flow and the keychain. Its header and `CLAUDE.md` state a deliberate four-tool ceiling ("M4 adds transports and reach, not vocabulary"). This design breaks that ceiling on purpose and amends plan 0025 and `CLAUDE.md` to say so; the prohibition that matters, no `PUT /sync/.../graph` and no claim tool, stands.
- Stage kinds are the closed set `constitution | specify | plan | tasks` (`apps/cloud/app/generation/prompts.py:18`). The 3S names in the UI (Scope, Spec, Skill) map onto those; this design does not rename anything.
- Per-stage authorship is `require_stage_access` with `ADMIN_ONLY_STAGES = {constitution, plan}` (`apps/cloud/app/api/_guards.py`). Baseline writes are admin-only. Both rules are reused, not redefined.
- `pw_repo_analyses` is service-only. Its row is a full `RepoAnalysis` with a `RepoSnapshot` that requires `commit_sha` and `default_branch` (`apps/cloud/app/models/schemas.py`). The existing `PATCH` edits a baseline on an existing row and 409s `repo_analysis_not_found` when there is none, so it is **not** the write the agent needs; a new route must mint the whole row. `RepoAnalysisBaselineUpdate` caps the baseline at 100k characters; this design uses the same cap.
- `apply_stage_content` (`apps/cloud/app/generation/stage_apply.py`) saves the stage document first and projects second; a `plan` with no requirement or a `tasks` with no SpecDocument returns `projection = "failed"` with the document already written. It does not refuse. The chain rule must therefore be checked **before** calling it.
- `unknown_task_paths` (`path_check.py`) returns nothing when `listing_complete` is false, which it is as soon as `file_count > len(paths)`. The "path not marked `(new)`" warning only fires with a complete, capped path list.
- `/desktop-auth/redeem` takes only `{code}` and records nothing about the client. There is nothing to piggy-back a "login seen" tick on.
- Repository content is untrusted. The baseline the agent writes is model output over untrusted text, same as today; the cloud already labels it as reference material in later prompts and keeps that label.
- The web gets `required: true` from the cloud for an imported project before `repo_created`, `false` otherwise. That stays the panel's switch.
- Tables are `pw_*`. Next migration number is `0012` at time of writing; check the directory.

## The flow the person sees

1. Someone creates a project and picks "import existing repository". Cloud records `repo_url` and `repo_origin = imported`, as today.
2. Planner opens on the Foundation tab. `CodebaseAnalysisPanel` no longer offers Analyze or Re-analyze for an imported project. It shows a checklist:
   - Install the MCP server and log in (`promptworkspace-mcp login`). No tick for this step; see "Left to the builder".
   - Open the repository in your agent and give it the brief. The panel shows one line to paste, which tells the agent to call `start_planning` for this project.
   - Wait for drafts. Rows for baseline, constitution, specify, plan, tasks turn from waiting to pending as each arrives. An imported project that already has a Typhoon-written baseline from before this change shows the baseline row satisfied and the stage rows waiting.
3. In the terminal, the agent calls `start_planning`, reads the brief, reads the repository with its own tools, and pushes the baseline. The gate opens. The agent then drafts the four stages in order, each from the previous draft plus the brief, and pushes each as a draft. A stage the caller may not author is refused by the cloud with the same 403 the generate route gives; the brief tells the agent which stages the caller can submit, so a member's sitting drafts `specify` and `tasks` and tells the user to ask an admin for the rest.
4. Back in the web, each pending draft opens in the same Markdown editor stage documents use today. Whoever may author that stage edits and clicks Accept or Reject. Accept pre-checks, then runs `apply_stage_content`. Reject deletes the draft and leaves a note the agent reads on its next `start_planning` call.
5. When `tasks` is accepted the project is where a Typhoon-generated project is after its tasks stage: tech review, then `create_repository` adopts the repo with the no-overwrite seed from plan 0027. Nothing after this point changes.

The checklist polls `GET /projects/{id}/repo-analysis` and a new `GET /projects/{id}/stage-drafts`, both cheap reads.

## MCP tools

Three new tools in `apps/mcp/src/server.ts`. All three are **synchronous**: they call the cloud and return its answer or its error. None goes through `StatusQueue`; a draft that lands minutes late after a resubmission would be a worse outcome than a clear failure. Project resolution is the existing one: `git remote -v` against the cloud's repo URLs, or an explicit `project_id`.

**`start_planning`** (read, member). Returns the planning brief for an imported project: the project's name and description, the policy scope rendered as the constitution stage sees it today, the four stage templates (including `tasks-template-existing.md`), the PRD texts the project has uploaded, the current analysis status and baseline if any, pending, stale and rejected drafts with their notes, the list of stages the caller may submit, and the instruction text. Refuses when the project is not imported or is already `repo_created`. Served by a new route `GET /projects/{id}/planning-brief` (member) so the brief can change without a package release.

**`submit_repo_analysis`** (write, admin). Body is a full snapshot plus the baseline: `default_branch`, `commit_sha` of `origin/<default_branch>` after a fetch (the brief says to fetch first; a stale or feature-branch sha earns the existing "Repository changed" badge, which is correct), `stack`, `file_count`, `paths` (filtered and capped exactly as `snapshot.py` caps them, `MAX_PATHS = 2000`, and run through the same secret-shaped-path filter server-side on receipt), `tree_summary`, and `baseline` markdown up to 100k characters. Cloud stores it through `upsert_repo_analysis` with `status = baseline_ready`, `source = "agent"` and the agent's self-reported `model` when given. Opens the gate. Excerpts and source outlines are left empty; nothing downstream requires them.

**`submit_stage_draft`** (write, per-stage access). Body: `stage`, `markdown` up to 100k characters. Cloud checks `require_stage_access` for the caller, runs `parse_stage_output` and, for `tasks`, `parse_task_lines` and `unknown_task_paths` against the stored snapshot, and returns the same warnings the generation route returns, so the agent can fix and resubmit before a human sees it. The draft replaces any earlier pending draft for the same stage. Nothing is applied.

The instruction text in the brief tells the agent, in order: fetch and read the repository with your own tools before writing anything; write the baseline sections and submit; then write constitution, specify, plan, tasks from the templates, each after reviewing the previous one yourself, and submit each you are allowed to; fix any warnings `submit_stage_draft` returns; stop. It says drafts are pending until a human accepts them, and that `tasks` must describe changes to the existing modules named in the baseline, never a re-scaffold. This is the "Skill" the 3S name has been promising.

## Cloud

**Drafts.** New table `pw_stage_drafts`: `project_id`, `stage`, `markdown`, `source` (`agent`), `model` (nullable), `created_by`, `created_at`, `status` (`pending | rejected`), `rejection_note`, `last_error` (nullable). One pending row per (project, stage); a new submission replaces it. Service-only: joins `_SERVICE_ONLY_TABLES`, grant to `authenticated` revoked in the migration, reads go through routes. Accepted drafts are deleted; the accepted markdown lives in `pw_stage_documents` with a new nullable `source` column so provenance survives acceptance. `pw_repo_analyses` gains `source` and `model` columns the same way.

**Routes.**
- `GET /projects/{id}/planning-brief` (member).
- `POST /projects/{id}/repo-analysis/agent` (admin). The full-row write above. Distinct from the existing `POST` that reads GitHub and streams Typhoon, which stays.
- `POST /projects/{id}/stage-drafts` (per-stage access).
- `GET /projects/{id}/stage-drafts` (member). Includes computed `stale`.
- `POST /projects/{id}/stage-drafts/{stage}/accept` (per-stage access). Pre-checks, in order: the caller may author the stage; the same preconditions the generate route checks for that stage (`plan` needs a requirement and no unapproved intent decision, `tasks` needs a SpecDocument); then calls `apply_stage_content`. If projection returns `failed`, the document has been saved as it would be after a Typhoon run, the draft is **kept pending** with `last_error` set, and the response carries the failure so the web can show it. The draft is deleted only on `projection = "ok"`.
- `POST /projects/{id}/stage-drafts/{stage}/reject` (per-stage access; body `note`).

**Gate.** `repo_analysis_required` is unchanged. The agent's baseline opens it. The Typhoon `generate` and `prefill` routes remain reachable for imported projects after that; the web just stops offering them.

**Stale drafts.** A pending draft whose `created_at` is earlier than its predecessor stage document's `updated_at` is `stale`, computed on read. The web shows a badge; accept is still allowed. The brief lists stale drafts so the agent redoes them next sitting.

**Provenance.** `source` and `model` on analysis and stage document.

## Web

`CodebaseAnalysisPanel` gains the checklist mode for imported projects and loses Analyze and Re-analyze for them. The baseline editor stays. Generate and Prefill buttons are hidden on all four stages for imported projects. Each stage tab shows a pending-draft banner above the editor when a draft exists: the draft's markdown loaded into the editor, Accept and Reject, source and model, stale badge, and `last_error` when set. Buttons follow today's per-stage access, so a member sees Accept on `specify` and `tasks` and a read-only banner on `constitution` and `plan`. Accept is disabled when the predecessor stage is not yet accepted, using the same `blockedBy` logic the Planner has.

## Security

- `start_planning` and the drafts list are member reads of things a member can already read in the web (policy scope, PRDs, stage documents). Nothing widens.
- `submit_repo_analysis` is admin-only. `submit_stage_draft`, accept and reject use `require_stage_access`, identical to generate and PATCH today.
- New tables are service-only with the grant revoked; members cannot write them over the data API. RLS probes in `tests/rls/` cover direct INSERT, PATCH and DELETE refused with `42501`.
- The cloud never fetches repository content in this flow. The received `paths` list is re-run through `snapshot.py`'s secret-shaped-path filter on the server so an agent cannot plant `.env` in the stored listing. Plan 0027's follow-up N6 stands for the code index at `repo_created`.
- Agent markdown is untrusted text parsed by code already parsing model output. Size cap 100k characters per draft and per baseline, refused with 413 above.

## Decisions made in conversation

- The person who imported the project does the terminal sitting, on their own machine, following steps the platform shows.
- From-scratch projects keep Typhoon. Imported projects lose Typhoon as the offered path, with no fallback in the UI.
- Drafts are pending and reviewed in the cloud app before anything applies.
- All four stages are drafted in one sitting; stale drafts are flagged, not prevented.
- Imports are not metered for now. Open item for plan 0022.
- Today's per-stage authorship rules stay. Members author `specify` and `tasks`; admins author `constitution`, `plan` and the baseline. A member's sitting stalls at `plan` until an admin accepts it.

## Calls made by the author

- The brief is served by the cloud, not bundled in the MCP package.
- Drafts live in their own table, not as a status on `pw_stage_documents`.
- The agent fills the full `RepoSnapshot` shape, not a reduced one, so path warnings and the Typhoon second opinion keep working.
- `submit_stage_draft` parses on submit and returns warnings.
- All three MCP tools are synchronous; no `StatusQueue`.
- Accept pre-checks the chain rule and the intent gate; a failed projection keeps the draft pending with `last_error`.
- Stale is computed, not stored.
- Rejection carries a note the agent sees next time.
- Size cap 100k characters, matching the existing baseline cap.
- Plan 0025 and `CLAUDE.md` get a dated amendment lifting the four-tool ceiling for planning reads and draft writes, keeping the graph-write and claim-tool prohibitions.
- A too-long body is Pydantic's 422, mapped to words in the MCP tool, not a 413.
- The MCP tools validate the cloud's field bounds locally before sending.
- The brief carries `default_branch`, `repo_url` and `can_submit_analysis`.
- `project_description` is always empty, because `Project` has no description field.

## Left to the builder

- Exact brief wording and the four stage instructions. Start from the driver prompts in `generation/prompts.py` and `tasks-template-existing.md`.
- Whether `start_planning` returns one payload or templates as separate resources. One payload is fine for stdio.
- Migration numbering, `_SERVICE_ONLY_TABLES` entries, and whether `source`/`model` on `pw_repo_analyses` ride the same migration.
- Test plan: fake MCP client round-trip in `apps/mcp/test` for all three tools including a 403 on a stage the caller may not author; cloud tests for the routes including accept pre-checks, failed projection keeping the draft, stale computation, per-stage access, server-side path filter; RLS probes; a web test that the panel shows the checklist for `required: true`, the satisfied baseline row for a pre-existing Typhoon baseline, and the banner for a pending draft with per-stage buttons.
- The "login seen" tick. Redeem records nothing today. Builder decides between a new `client` and `last_seen` on the redeem, or no tick for that step. No tick is acceptable.

## Open items carried forward

- Metering of agent-written drafts (plan 0022).
- Plan 0027 N5 and N6 unchanged.
- Plan 0025 M4 unblocks the same flow from customer CI (plan 0029 M3) with no change to the tools.
- A sync PR for imported repos (plan 0029 §13 item 16) could later push accepted documents back under `docs/promptzone/`; out of scope here.
