# Editable plan after the repository exists — design

**Status:** implemented (2026-10-10) · **Date:** 2026-10-10 · **Origin:** the Marketing Studio Listings trust run (findings 71, 85, 86) · **Related:** plan 0029 (§1.4 "Planning ends when tasks exist"), ADR 0017, ADR 0021

## Problem

Once a project's repository exists (`lifecycle_status = repo_created`) the Planner makes the Specify, project-rules and Plan stages read-only. The plan cannot be changed, even though a person will normally learn something at repository creation or during delivery that changes it. In the trust run the deployment template (plain `site/` published as-is, no build step) contradicted the approved React/Vite plan, and the only way out was to abandon the project.

The freeze is a web-UI rule only. `Planner.tsx` sets `readOnly = project.lifecycle_status === "repo_created"` and applies it to every stage but Tasks; the cloud's stage-document routes never refuse a write at that lifecycle (the code comment on the Tasks exception says so). Plan 0029 already treats "planning ends when tasks exist" as a broken assumption and asks for a live plan. This design delivers the smallest slice of that: a person can edit the plan, and the repository's copies catch up through a pull request.

## Goals

1. After the repository exists, people who may author a stage today can edit the Specify, project-rules and Plan documents, and can regenerate them.
2. Approvals behave as they already do: an approval binds the hash of the documents it was given, and an edit of one of those makes it stale. The delivery-plan approval (`plan_approval`) binds the Tasks document only, so editing or regenerating Tasks stales it ("Changed since approval"), while an edit of the Plan document alone does not; the scope approval binds Specify. Binding `plan_approval` to Plan as well is carried-over work (see Known limitations).
3. The cloud can say which of the repository's seeded documents are out of date, and open one pull request that brings them up to date. Nothing reaches the default branch without a person merging it.
4. The pull-request path never touches the deployment template's files or application code.

## Non-goals

A plan version history or re-plan diff view; auto-merge or auto-commit; conflict resolution beyond what a PR diff shows; editing the policy scope, deployment template or repository name (all sealed into the repository at creation); GitHub App authentication.

## Design

### 1. Unfreeze the stages (web)

`Planner.tsx`: remove the `readOnly` freeze for the `specify`, `constitution` and `plan` stages. `PolicyScopePanel`, the deployment-template panel and the repository-name form keep `readOnly = lifecycle === "repo_created"`. Authoring permission is unchanged: `ADMIN_ONLY_STAGES` (constitution, plan) still require a tech steward or admin; Specify stays open to project members as today. The Generate buttons stay and gain a confirm step after `repo_created` that says the document is replaced and the repository copy becomes out of date.

The stage "blocked by" gating (a stage waiting for the one before it) is evaluated as before; after `repo_created` every earlier stage already has a document, so nothing is newly blocked.

### 2. Approvals and tasks (no new logic)

Decision subjects are bound to the SHA-256 of the stage documents (`stage_hashes` in `app/delivery/approvals.py`). Editing a document after its approval makes that approval stale and the card shows "Changed since approval". The delivery plan approval (`plan_approval`) binds the `tasks` document, so it goes stale when the Tasks document changes, by hand or by regeneration; an edit of the `plan` document alone does not change it (the scope approval binds `specify`). Task regeneration after `repo_created` already works and retires superseded tasks through `titles_match` in `stage_apply._apply_tasks`. An acceptance test covers both on a project at `repo_created`.

### 3. Which repository files are out of date (cloud)

`GET /projects/{project_id}/repository/docs-status` (any project member may read; response `RepositoryDocsStatus`):

- Requires `lifecycle_status == "repo_created"` and a `repo_url`; otherwise 409 `repository_not_created`.
- Rebuilds the seed files from the current stage documents with the existing `build_seed_files(project, stage_docs)` (and `render_policy_scope_doc` through it). The set is limited to the document views: `AGENTS.md`, `README.md`, `docs/scope.md`, `docs/architecture.md`, `docs/tasks.md`, `docs/conventions.md`, `.specify/memory/constitution.md`, `docs/policy-scope.md`. Deployment files and `site/` are never part of it.
- Reads the repository tree at the default branch head with the existing `get_tree_entries` and compares each path's git blob sha with `sha1("blob <len>\0" + content)` computed locally from the rebuilt file. No file contents are fetched.
- Refuses an imported repository, and a `repo_created` project with no recorded `repo_origin` (one created before migration 0035, which may be an import), with 409 `sync_not_supported_for_imported_repository`. The web keeps those projects' stages frozen and asks for no status.
- Returns, per path, one of four states, plus `open_sync_pr` (`number`, `url`, `foreign_changes`) when a sync pull request is open:
  - `current`: the default branch already holds this view.
  - `out_of_date`: it differs from the default branch and the open sync PR's branch does not hold it either (including a view edited back to the default branch's content after a sync put something else on the PR branch).
  - `missing`: the default branch has no file at that path (for example a plan added after creation).
  - `in_pull_request`: the open sync PR's branch already carries exactly this view; it waits on a merge, not on a sync.
- While a sync PR is open, every view is compared with that PR's branch as well as with the default branch (`classify_with_pull_request`). Reading the PR's branch is best-effort: if it fails the default-branch comparison stands.
- `open_sync_pr.foreign_changes` is true when the PR's branch changes any path outside the document views (by `compare_files`, below), or when a pull request someone else opened sits on the branch the next sync would create. Best-effort: a failed comparison reads as false; the sync checks again and refuses.
- A file the repository owner edited by hand reports `out_of_date`; the PR diff shows it (see section 4).

### 4. The sync pull request (cloud)

`POST /projects/{project_id}/repository/sync-docs` (admin or tech steward; response `SyncDocsOut` with `pr_url`, `pr_number`, `files`):

1. Computes the status above (against the open sync PR's branch when there is one). If no view differs, answers 409 `repository_docs_current`.
2. Looks for the open sync PR: an open pull request into the default branch whose head branch starts with `pw/sync-docs-` and lives in the repository itself (a fork's PR is ignored). It is reused only when the connected GitHub account (`account_login` in the workspace's GitHub config) opened it; with no recorded login every author passes. A pull request someone else opened is not adopted: ignored when it is on another branch, refused with 409 `sync_branch_has_foreign_changes` when it is on the branch this sync would create.
3. With no open sync PR, creates the branch `pw/sync-docs-<default-branch head sha[:12]>` from the default branch head. Naming it after the head makes two syncs racing from the same head collide on one name instead of opening two PRs. If the name is taken (another sync still uploading, or a PR closed without merging left it), the existing branch is adopted: compared like an open PR's branch and written pinned to the head just read.
4. Before committing onto any existing branch (an open PR's head or an adopted one), compares it with the default branch (`compare_files`, GitHub's `compare/{base}...{head}`). A branch that changes any path outside the document views, or whose comparison GitHub cannot list in full (300 files or more), is refused with 409 `sync_branch_has_foreign_changes` and nothing is written: a collaborator can push any `pw/sync-docs-*` branch, and the sync writes and describes the PR under the admin's token.
5. Commits only the changed views with `create_commit_with_files(token, repo, branch, files, message, expected_base_sha)`, message `docs: sync planning documents from PromptWorkspace`, pinned to the branch head the comparison read.
6. Opens the PR (or updates the existing PR's body) with a list of the views that differ from the default branch, the views this commit changes back, and a note that a hand-edited file in the repository shows up in the diff and should be reviewed, not assumed overwritten.
7. Never force-pushes, never writes to the default branch, never merges.

New `GithubClient` methods (Protocol, real client and fake): `create_branch(token, repo, branch, from_sha)`, `find_open_pull_request(token, repo, head_prefix, base, author=None)` (returns `number`, `html_url`, `head`, `author`; prefers a PR by `author`, else the first by anyone), `create_pull_request(token, repo, head, base, title, body)`, `update_pull_request(token, repo, number, body)` and `compare_files(token, repo, base, head)`.

Error codes (`app/api/repository_docs.py`), shared by both routes where they apply:

| Code | Status | When |
|---|---|---|
| `repository_not_created` | 409 | The project is not at `repo_created` or has no `repo_url`. |
| `sync_not_supported_for_imported_repository` | 409 | Imported repository, or no recorded `repo_origin`. |
| `github_not_configured` | 400 | The workspace has no usable GitHub token. |
| `repo_url_unrecognized` | 409 | The project's `repo_url` is not a GitHub repository address. |
| `github_read_forbidden` | 400 | A read (branch head, tree, sync branch, comparison) answered 401/403/404. |
| `github_unreachable` | 502 | Any other read failure. |
| `repo_tree_too_large` | 409 | GitHub truncated a tree listing. |
| `repository_docs_current` | 409 | Nothing to sync. |
| `sync_branch_has_foreign_changes` | 409 | The sync branch changes more than the document views, or someone else's PR sits on it. |
| `github_pr_permission_denied` | 400 | Listing, opening or updating a pull request answered 401/403/404 (the token lacks Pull requests write). |
| `github_branch_conflict` | 409 | The branch moved between the comparison and the commit. |
| `github_branch_protected` | 409 | A protection or ruleset refused the branch update, or refused creating the branch (a 422 other than "Reference already exists"). |
| `github_write_forbidden` | 400 | Creating the branch or committing answered 401/403/404. |
| `github_sync_failed` | 502 | Any other write failure, with GitHub's status in the log. |

The generic `github_repo_not_in_token_scope` message is not reused here (finding 80).

### 5. Web: banner and action

When the project is at `repo_created` and its `repo_origin` is `created`, the Planner calls `docs-status` (refetched on focus, after a sync, and after any stage document is saved or regenerated) and shows, above the stages, either nothing (all current), a banner "Repository documents are out of date: N files" with a **Review and open a pull request** button, or "Pull request #n is open" with a link (and **Update the pull request** when files still need updating). When `open_sync_pr.foreign_changes` is true it shows a muted line instead, with a link to the PR and no button: "The pull request branch contains changes that are not planning documents. Review or delete the branch on GitHub before syncing." The button calls `sync-docs`, shows the returned link, and shows a specific text for every error code above. A status that cannot be read shows a muted "Could not check repository documents: …" line with no button; the stages keep working. Only admins and tech stewards see the button; members see the banner as information.

### 6. Token permission

Opening a pull request needs the fine-grained token permission **Pull requests: Read and write** on top of Contents, Administration, Webhooks, Secrets, Variables and Workflows. Add it to the workspace settings copy, `docs/DEPLOYMENT.md` and ADR 0017's list. It cannot be checked at connect time (fine-grained tokens expose no introspection), which is why the 403 gets its own error code.

## Data and migrations

None. Staleness is computed on demand from the cloud documents and the repository tree, so there are no stored hashes and no schema change, which also keeps older repositories (created before this feature) working: their first status call compares against whatever is in the repository.

## Error handling and edge cases

- Imported projects are refused (409 `sync_not_supported_for_imported_repository`) and their stages stay frozen in the web. Their seed was relocated around the user's own files by `fit_to_existing_repo`, and re-deriving that against a tree that now contains the seed would misread the seeded files as conflicts. A `repo_created` project with a NULL `repo_origin` (created before migration 0035) is treated the same way, because it may be an import.
- A repository whose default branch moved between status and PR: `expected_base_sha` makes the commit fail with `github_branch_conflict`; the UI asks the user to retry.
- Empty plan or rules (document deleted): the file is omitted from the rebuilt set exactly as `build_seed_files` omits it, so it is never reported `out_of_date`.
- Rate limits and GitHub outages return 502 (`github_unreachable` on reads, `github_sync_failed` on writes); the Planner shows a muted "Could not check repository documents" line and the stages keep working.
- A collaborator's branch or pull request under the `pw/sync-docs-` prefix: refused with `sync_branch_has_foreign_changes` when it carries anything but document views or sits on the sync's branch name; see section 4.

## Testing

- Cloud unit tests with the fake GitHub client in both repository backends (in-memory and Supabase-contract where the project row matters): status classification (`current`, `out_of_date`, `missing`, hand-edited file), the blob-sha comparison against known git hashes, sync creates one branch and one PR, a second call updates the same PR, `repository_docs_current` when nothing changed, permission and conflict error mapping, member vs admin access, imported and NULL-origin refusal, foreign-change refusal (adopted branch, open PR branch, another login's PR), and that deployment files and `site/` are never in the set.
- Acceptance test: approve the plan, move the project to `repo_created`, edit the plan, assert the decision is stale and tasks regenerate.
- Web tests: stages editable at `repo_created` for an admin, policy scope and template still read-only, banner states, confirm step on Generate, button hidden for members, error texts.
- Live check on trust with "Marketing Studio Listings": edit the plan to plain JS, regenerate tasks, open the sync PR, review it, merge it.

## Review focus (inputs most likely to bite a person)

1. A repository file that a person edited by hand: must appear in the PR diff and never be overwritten without review.
2. A project whose repository was imported (docs under `docs/promptworkspace/`): the PR must not write over their own `README.md` or `AGENTS.md`.
3. Two people opening the sync at once: one branch, one PR, no duplicate commits.
4. A token without Pull requests write: a clear, specific error, not "token scope".
5. A project at `repo_created` with no plan yet (older projects): the stages are editable and the status route does not crash on missing documents.

## Known limitations

- `plan_approval` binds the Tasks document only. An edit of the Plan document alone does not stale the delivery-plan approval; only an edit or regeneration of Tasks does.
- Projects at `repo_created` with a NULL `repo_origin` (from-scratch projects created before migration 0035) get no document edit and no sync: nothing tells them apart from a legacy import.
- `in_pull_request` compares trees, not diffs. While a sync PR is open it is reused whatever the default branch head is now, so a hand edit on the default branch after the PR's branch forked stays hidden until the merge, and GitHub then reports a conflict on the PR.
- The first sync PR on a repository seeded before this feature rewrites every seeded document, because the seed's footer and preamble changed (the footer no longer carries a date).
- The banner cannot be dismissed. A hand-edited `AGENTS.md` (or any seeded document the team maintains by hand) keeps it showing "out of date" for good.

## Open question left for review

Whether Generate after `repo_created` should keep the confirm step only, or also require the plan approval to be re-requested explicitly first. This spec keeps the confirm only; a re-approval is already forced by the hash change.
