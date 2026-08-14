# apps/vscode — implementation notes (ADR 0019 + 0020, first cut)

**Date:** 2026-08-13 · **Status:** shipped, additive

What was built, what was deliberately not, and where the seams are. The reasoning lives in
[ADR 0019](../../decisions/0019-desktop-as-vscode-extension.md) and
[ADR 0020](../../decisions/0020-cloud-is-the-source-of-truth.md); this records how much of them
is now real.

## Scope actually delivered

**Additive only.** `apps/desktop`, `apps/desktop-theia`, `apps/engine` and all three CI workflows
are untouched. None of ADR 0019's or 0020's retirement clauses were executed — the engine still
pushes a full graph snapshot every twenty seconds, and its two lossy status maps
(`sync/loop.ts:19`, `:522`) are exactly as they were. The extension does not use them and does not
share code with the engine; the surviving logic was **copied and adapted**, never imported.

Delivered in five parts:

1. **Cloud — `PATCH /projects/{id}/tasks/{id}/status`** (`apps/cloud/app/api/sync.py`), with an
   optional artifact carrying the closing commit. Mirrors `assign_task` in structure and in
   permission shape. `set_task_status` + `upsert_task_artifact` on both repository backends;
   migration `0025_task_status_indexes.sql` adds the partial unique index on
   `pz_artifacts (task_id, commit_sha)` that makes artifact writes idempotent for real rather than
   by convention. 12 tests in `tests/test_task_status.py`.

2. **Cloud — `GET /me/tasks`** (`apps/cloud/app/api/me.py`, new router). Cross-workspace, with
   project and workspace context and `repo_url` for clone matching. Both backends re-check
   membership per row, because an assignment outlives a membership removal. 11 tests.

3. **Web — `desktopRedirect()`** (`apps/web/src/app/(auth)/login/page.tsx`). The old
   `scheme://auth/callback` shape is unusable for a VS Code URI handler, whose authority must be
   the extension id. A client may now supply its own resolved callback as `redirect_uri`; the page
   validates the scheme against a widened allow-list and refuses `https:` outright. The
   no-`redirect_uri` branch is byte-identical to the old string, which is what keeps both desktop
   shells working. 11 tests.

4. **The extension** (`apps/vscode`, ~2,300 lines + 411 vendored). Sign-in via `registerUriHandler`
   with `asExternalUri` and a paste-a-code fallback; task TreeView with checkbox close; project
   context webview reading the three seeded files from the clone; copy-task-context; git-driven
   status close; offline cache and queue.

5. **Docs** — README, `docs/DEVELOPMENT.md`, `docs/DEPLOYMENT.md` §3A, CLAUDE.md, root
   `pnpm vscode` script.

## Decisions worth not re-litigating

**Status vocabulary: none.** The extension speaks the cloud's four states natively. There is no
map anywhere in `apps/vscode`, and adding one would recreate the exact defect ADR 0020 §Aligned
status vocabularies describes.

**A commit writes `implemented`, never `verified`.** A commit is evidence of implementation. The
cloud enforces the other half: non-admins cannot set `verified` at all.

**Unassigned tasks are 403 for non-admins.** Otherwise a commit mentioning `T012` closes a task
nobody claimed. The client's answer is self-assignment first, which members are already permitted.

**Cache is JSON files under `globalStorageUri`, not `node:sqlite` and not `Memento`.** The
extension host runs Electron's Node, where the `sqlite` built-in may be flag-gated and an
extension cannot pass Node flags; `Memento` shares `state.vscdb` with SecretStorage ciphertext and
offers no atomicity. Reasoning is in `src/storage/cache.ts`.

**Folder ↔ project link is a resource-scoped setting**, discovered by normalising git remotes
against `repo_url`, written only on confirmation. Alternatives and why they lose are in
`src/link/projectLink.ts`'s header.

**Task refs normalise numerically.** `T1`, `T01`, `T001` and `T0001` are one ref, because the
cloud stores `feature_tag` zero-padded and developers do not type it that way. Widening the
engine's regex alone would not have fixed it. A project holding both `T012` and `T12` as distinct
tasks closes neither and logs why.

**`erasableSyntaxOnly` is on, so there are no parameter properties anywhere.** That is what lets
the pure modules load under bare `node --test` type-stripping, which is the whole test strategy.

## Verified

| | |
|---|---|
| `apps/cloud` | `ruff check` clean; 407 passed (`tests/test_health.py::test_health` fails on a clean tree too — pre-existing, unrelated) |
| `apps/web` | `tsc --noEmit` clean; 181 tests |
| `apps/vscode` | `tsc --noEmit` clean; 41 tests; esbuild build; `vsce package` → 17 KB VSIX, 7 files |
| `apps/engine` | untouched — `tsc` clean, 59 passed / 4 skipped |
| `apps/desktop` | untouched — `tsc` clean |

Not yet done: the end-to-end run in a live Extension Development Host against a real cloud, in
VS Code, Insiders and Cursor. The steps are in `apps/vscode/README.md` and in the plan.

## Deferred, named so it is not mistaken for oversight

- **The MCP server** (ADR 0019 decision 3) — the portable channel for JetBrains, Neovim and Zed.
  Separate artifact over the same cloud API, separate plan.
- **`lm.registerTool`, the Comments API, clone/open-project, `local-llm-env`.**
- **Every retirement in ADR 0019 and 0020**, including disabling the engine's graph push, which
  ADR 0020 flags as the dangerous window: an engine that opens a cloud-planned project still
  overwrites it every twenty seconds. That risk is unchanged by this work, and is the strongest
  candidate for the next change.
- **Integration tests** (`@vscode/test-cli`), and CI in general. The repo has no lint/typecheck/test
  workflow at all; adding the first one is its own decision.

## Open questions for the team

- **The publisher name must be registered on both the Marketplace and Open VSX before release.**
  The current id is `promptconnext.promptconnext-vscode`, and it is baked into the sign-in callback
  URI (`src/auth/signIn.ts::EXTENSION_ID`) and the web allow-list expectations. Renaming after
  release breaks in-flight sign-ins.
- Is `verified`-requires-admin the right collaboration rule? Three lines in `sync.py` either way.
- Should `GET /me/tasks` include projects still in `lifecycle_status = planning`? It currently does.
- Remote-SSH / Codespaces users fall back to paste-a-code. If they matter, the `https:` redirect
  question reopens and needs an exact-host allow-list — never a bare `https:` allowance.

## Known upstream gap that will look like an extension bug

`app/generation/projection.py:16` does not project the tasks stage into `Task` rows, so a Tech Lead
who hand-edits the tasks document produces no tasks at all and the tree is empty (ADR 0020). It is
in the extension README, and it is a cloud fix.
