# Plan 0011 — Desktop decision gate

**Date:** 2026-09-12 · **Status:** Decision required — blocks plans 0012, 0021 and 0025 · **ADR:** [0019](../decisions/0019-desktop-as-vscode-extension.md) + [0020](../decisions/0020-cloud-is-the-source-of-truth.md), both still *Proposed*

This is not a build plan. It is the memo that lets product and engineering answer question 1 of the [product vision](../product-vision-2026-09-12.md) — *is the desktop retired or funded?* — in one sitting, written so either answer can be executed the next morning. Everything below was measured against the working tree: line counts come from `git ls-files … | xargs wc -l`, and every `path:line` reference was read before it was written.

**Nothing is locked here.** Unlike [plan 0009](./0009-task-assignment.md), which implemented a decided ADR, this plan exists because two ADRs describe a pivot the code already performed and the record has not ratified. Its deliverable is a status change on ADRs 0019 and 0020 from **Proposed** to **Accepted** or **Rejected**, plus the branch selection below.

---

## 1. The state of the record

The pivot ADRs were written on 2026-08-13. `apps/desktop` was last touched the same day and never resumed. A month later both are still Proposed, so nothing was formally retired, and the repository still asserts the superseded model in six places — five live, one already fixed.

`README.md:11` describes `apps/engine` as owning "the local task graph (offline source of truth)". `CLAUDE.md:75` repeats it verbatim — "the **offline source of truth** (ADR 0003)" — and `:76` and `:79` extend it, calling `backup.ts` "the only second copy an offline user has" and describing `sync/loop.ts` as pushing "the local graph up on an interval."

`docs/promptzone-platform-architecture.md` asserts it four times: `docs/promptzone-platform-architecture.md:124` ("Source of truth while offline"), `:175` ("the **task graph** stays **local-authoritative**"), `:185` ("the graph is local-authoritative as usual") and `:224` ("the desktop engine is the offline source of truth").

Two engine comments carry it into code: `apps/engine/src/backup.ts:3` ("The `node:sqlite` file written by db.ts is the offline source of truth") and `apps/engine/src/sync/loop.ts:17`, which justifies the lossy status maps with "local SQLite stays the detailed source of truth". Two further comments in that file repeat it while describing the keyhole pulls, at `apps/engine/src/sync/loop.ts:433` and `:471`.

**One item on the vision's list is already fixed and should be struck from it.** The module docstring of `apps/cloud/app/api/sync.py` has been rewritten: it now opens "The cloud is authoritative for the task graph (ADR 0020)" and explicitly says a local graph "is a cache that may be deleted and rebuilt without loss." The cloud corrected its own record. Only the engine and the top-level docs lag.

## 2. What is at stake, measured

| Artifact | Tracked files | Lines | Note |
|---|---:|---:|---|
| `apps/desktop` webview (React/TS) | — | 4,237 | matches ADR 0019's own count |
| `apps/desktop` Rust shell | 2 | 261 | `src-tauri/src/lib.rs` + `main.rs` |
| `apps/desktop` total tracked | 109 | — | includes 6 wdio e2e files and the Tauri icon set |
| `apps/desktop-theia` | 16 | 414 (src JS) | six modules plus three native-module stubs |
| `.github/workflows/` | 3 | 298 | 251 of those lines build the two frozen shells |
| `apps/engine/src` | — | 4,787 | of which ADR 0019 marks ~2,200 dead |
| `apps/vscode/src` | 31 | 4,825 | the replacement, already larger than either shell |

The last row is the most important number here. **ADR 0019's decision 1 has effectively shipped.** `apps/vscode/src/tasks/statusWriter.ts` (112 lines) is a working, retry-aware task-status writer against the cloud; `apps/vscode/src/git/taskRefs.ts` (135) closes tasks from git refs; `apps/vscode/src/context/repoDocs.ts` (112) reads the coding rules from the clone; `apps/vscode/src/tasks/copyContext.ts` (91) is the universal assistant handoff. The extension already does the six jobs ADR 0020 assigns the desktop, so the decision is not "build the replacement" — it is "delete the thing the replacement replaced."

CI is the clearest cost signal. `.github/workflows/` holds exactly three files: `.github/workflows/desktop-build.yml` (148 lines, Tauri + R2 + a `manifest` fan-in job), `.github/workflows/desktop-theia-build.yml` (103, electron-builder + its own `installation-theia/` R2 prefix), and `.github/workflows/theia-spike-windows.yml` (47, the ADR 0016 M0 spike, still wired to `spikes/theia-shell/`). There is none for the cloud, the web app, the extension or the marketing site: the repository's entire CI budget builds two frozen shells.

The shells also reach outward. Root `package.json:17`–`:19` pins three pnpm overrides — `drivelist`, `keytar`, `native-keymap` — to `file:apps/desktop-theia/stubs/*`, and `:20` pins `@wdio/native-utils` for `apps/desktop`'s e2e suite. Deleting either directory without touching the root manifest breaks `pnpm install` for every app in the workspace. On the corp side, `apps/corp/src/components/sections/DownloadOptions.tsx:21`–`:22` link the two version-free installer names the Tauri workflow publishes, and `apps/corp/src/content/pages.ts:38` sells the free tier as "The full desktop app, forever."

## 3. The unsigned-macOS gap

The two shells have **different** update-authenticity postures, and the vision statement flattens them. This is the one place where "do nothing" is actively unsafe.

**Theia/Electron ships genuinely unsigned on macOS.** `apps/desktop-theia/package.json:35` sets `"identity": null`, and `.github/workflows/desktop-theia-build.yml:77` sets `CSC_IDENTITY_AUTO_DISCOVERY: "false"` so a runner-local ad-hoc identity cannot be picked up by accident. `apps/desktop-theia/src/update-lifecycle.js:22`–`:31` documents the consequence in full: with no Apple Developer ID, Squirrel.Mac cannot match the downloaded bundle's signature to the running app's, so `quitAndInstall()` is "expected to error on macOS until notarization lands," and the only integrity check meanwhile is the sha512 checksum in `latest-mac.yml` "served by the same origin as the payload — a corruption check, not an authenticity one; anyone who can serve or MITM that R2 origin could hand this app an arbitrary executable on macOS specifically."

**Tauri is unsigned at rest but authenticated on update.** `.github/workflows/desktop-build.yml` carries no Apple or notarization secrets at all, so the `.app` is unsigned and a user still gets a Gatekeeper prompt. But `.github/workflows/desktop-build.yml:48` passes `TAURI_SIGNING_PRIVATE_KEY`, and `apps/desktop/src-tauri/tauri.conf.json:34` pins the matching minisign `pubkey` against the `installation/latest.json` endpoint at `:36`. The updater therefore verifies a real signature over the payload, independent of the serving origin.

So: Windows is Authenticode-signed on both shells when the CI secrets exist, macOS is unsigned on both, and the **Theia macOS update channel specifically** is the live authenticity hole. Whichever branch wins, `apps/desktop-theia` should stop publishing macOS artifacts this week. Branch A closes the gap by deletion; Branch B buys an Apple Developer Program membership and adds notarization to both matrices.

## 4. Branch A — retire

Deletion order matters, because two of these steps break the workspace if taken alone.

1. **Flip both ADRs to Accepted** and correct the six assertions in §1 in the same change, so the record never describes a system that does not exist. ADR 0016 is already marked superseded by 0019; leave it as history.
2. **Extract before deleting.** ADR 0019 names three survivors and they are all real: `detect()` on the four adapters, reached through `detectInstalledAgents()` at `apps/engine/src/agent/adapters/index.ts:14`; `commitFiles()` at `apps/engine/src/agent/loop.ts:164`; and `changedFiles()` at `apps/engine/src/agent/agent-runner.ts:29`. `commitAll()` at `apps/engine/src/agent/loop.ts:157` is called only from the dead stage runners and goes with them. The `local-llm-env` idea survives as an extension command: `apps/engine/src/routes/models.ts:43` emits the `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` pair, consumed today at `apps/desktop/src/api.ts:142`. Re-source it from a cloud-held connection or drop it — do not leave it resolving from a deleted table.
3. **Delete `apps/desktop-theia` and `.github/workflows/desktop-theia-build.yml` together**, and in the same commit remove the three `file:apps/desktop-theia/stubs/*` overrides at root `package.json:17`–`:19` and relock. Delete `.github/workflows/theia-spike-windows.yml` and `spikes/theia-shell/` (21 tracked files) with them.
4. **Delete `apps/desktop` and `.github/workflows/desktop-build.yml`**, drop the `@wdio/native-utils` override, and stop publishing to the `installation/` R2 prefix. `apps/corp` must land first or `/download` 404s.
5. **Then** delete the engine surface: the stage runner and its six templates (1,061 lines under `apps/engine/src/agent/templates/`), `apps/engine/src/gateway/index.ts` (257), `apps/engine/src/routes/models.ts` (158), `apps/engine/src/routes/onboarding.ts` (102), `apps/engine/src/routes/files.ts` (139), `apps/engine/src/routes/terminal.ts` (85) and `apps/engine/src/routes/backups.ts` (32).

**Prerequisite before step 4, not after:** ADR 0019 decision 3's MCP server does not exist. The only occurrences of "MCP" in `apps/` are a marketing string and the integration-kind enum at `apps/engine/src/db.ts:83`. Until plan 0025 lands, a developer in JetBrains, Neovim or Zed has no channel at all, and deleting the shells removes the one they could have installed. Either accept that gap explicitly for a named period, or sequence 0025 ahead of step 4.

## 5. Branch B — fund

Funding means rebuilding `apps/desktop` as a **read-mostly cloud client**, not resuming it. The concrete work is ADR 0020's "Notes for the implementing agent," in its stated order: disable the graph push; drop or satisfy the `spec_id NOT NULL` foreign key so a pulled task can be inserted at all; align the status vocabularies and delete both mapping tables at `apps/engine/src/sync/loop.ts:17` and `:471`; consume the status PATCH; promote `hydrateProjectGraph` to the interval pull driven by `since=`; and wire `syncTasksFromGit` (`apps/engine/src/routes/projects.ts:751`) to emit status writes instead of local `UPDATE`s. The cloud half is already built — `set_task_status` at `apps/cloud/app/api/sync.py:566` alongside `assign_task` at `:533` — so this is engine work, not cloud work.

The ongoing cost is three standing obligations, and they are the same three ADR 0019 rejected "keep both" over: two CI matrices (`.github/workflows/desktop-build.yml` and `.github/workflows/desktop-theia-build.yml`, 251 lines of release plumbing across two R2 prefixes and two update-manifest formats); a code-signing story that must finally be paid for, including the Apple Developer Program membership `apps/desktop-theia/src/update-lifecycle.js:22` says the team does not have; and a Theia migration whose M3 never started — `apps/desktop-theia` has working auth, deep-link, engine-lifecycle and updater plumbing across 414 lines and **no product interface whatsoever**, because the planner extension that would have supplied one was cancelled with ADR 0016.

Funding also means duplicating, in the shell, the six jobs `apps/vscode` already performs — a price paid every sprint rather than once.

## 6. What changes shape under each branch

| Queued plan | Under Branch A (retire) | Under Branch B (fund) |
|---|---|---|
| **0012 — close the write path** | Step 1 (disable the interval push) is unchanged. Steps 2–6 collapse into deletion: no vocabulary alignment is needed if the engine's task tables go, and the `spec_id` foreign key never has to be satisfied. | All six steps of ADR 0020's note are in scope, plus the queue-and-flush offline path. Roughly triple the work, and the vocabulary alignment becomes load-bearing because tasks now round-trip. |
| **0021 — operational floor** | CI is greenfield: delete 251 lines of shell-building workflow and add cloud, web, extension and corp pipelines in their place. No signing story to maintain. | CI grows a fifth and sixth pipeline on top of the two existing matrices, and notarization plus an Apple membership become launch blockers rather than deferred debt. |
| **0025 — MCP server** | Promoted from a long-term bet to a **release prerequisite** — it is the only channel left for developers outside the VS Code family once the shells are gone. Sequence it ahead of the `apps/desktop` deletion. | Stays a bet. The shell can serve non-VS-Code developers in the interim, so 0025 can wait behind the operational floor. |

Plans 0013 through 0020, 0022, 0023, 0024 and 0026 are branch-independent and can start regardless of how this resolves.

## 7. Recommendation, and the cost of not deciding

**Retire.** Branch A, with plan 0025 sequenced ahead of the `apps/desktop` deletion. The argument is not ADR 0019's platform analysis — it is that the replacement already exists and is larger and more current than either thing it replaces, the shells have been frozen for a month with no owner, the Theia shell has plumbing but no interface, and the one live security defect in this memo closes for free by deletion. "Keep both" is being paid for in CI capacity the cloud and web apps get none of.

Leaving it open compounds in three directions: every week the shells stay, `apps/corp` keeps selling a free tier built on them; the Theia macOS update channel stays exploitable by anyone who can serve or MITM the R2 origin; and 0012, 0021 and 0025 each stay half-specified.

**One thing is not blocked by this decision, and must not wait for it.** `startCloudSyncLoop` at `apps/engine/src/sync/loop.ts:494` still calls `pushProjectSnapshot` on every twenty-second tick, and `assembleSnapshot` at `:126` still builds a full local snapshot of requirements, spec documents, tasks, artifacts and agent runs to push over cloud state that is now the authored original. That runs under **both** branches — a retired desktop still ships in whatever builds are already installed, and a funded one keeps the loop by definition. ADR 0020 calls it a data-loss incident rather than a degradation, and it is the one instruction that ADR gave above all others. **Plan 0012's first step — disabling the graph push — should start before this memo is read, not after it is answered.**
