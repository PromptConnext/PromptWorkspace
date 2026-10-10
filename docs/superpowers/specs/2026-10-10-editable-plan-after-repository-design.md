# Editable plan after the repository exists — design

**Status:** implemented (2026-10-10) · **Date:** 2026-10-10 · **Origin:** the Marketing Studio Listings trust run (findings 71, 85, 86) · **Related:** plan 0029 (§1.4 "Planning ends when tasks exist"), ADR 0017, ADR 0021

## Problem

Once a project's repository exists (`lifecycle_status = repo_created`) the Planner makes the Specify, project-rules and Plan stages read-only. The plan cannot be changed, even though a person will normally learn something at repository creation or during delivery that changes it. In the trust run the deployment template (plain `site/` published as-is, no build step) contradicted the approved React/Vite plan, and the only way out was to abandon the project.

The freeze is a web-UI rule only. `Planner.tsx` sets `readOnly = project.lifecycle_status === "repo_created"` and applies it to every stage but Tasks; the cloud's stage-document routes never refuse a write at that lifecycle (the code comment on the Tasks exception says so). Plan 0029 already treats "planning ends when tasks exist" as a broken assumption and asks for a live plan. This design delivers the smallest slice of that: a person can edit the plan, and the repository's copies catch up through a pull request.

## Goals

1. After the repository exists, people who may author a stage today can edit the Specify, project-rules and Plan documents, and can regenerate them.
2. Approvals behave as they already do: an edit changes the document's hash, so the plan shows "Changed since approval" and needs re-approval.
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
- Returns, per path, `state` in `current | out_of_date | missing`, plus `open_sync_pr` (url, number) when a sync PR from this feature is open. `missing` covers a doc that did not exist at creation (for example a plan added later).
- A file the repository owner edited by hand reports `out_of_date`; the PR diff shows it (see section 4).

### 4. The sync pull request (cloud)

`POST /projects/{project_id}/repository/sync-docs` (admin or tech steward; response `SyncDocsOut` with `pr_url`, `pr_number`, `files`):

1. Computes the status above. If every file is `current`, answers 409 `repository_docs_current`.
2. Reuses the open sync PR if one exists (branch `pw/sync-docs`), otherwise creates the branch `pw/sync-docs` from the default branch head. One long-lived branch name keeps a single open PR; a stale branch left by a merged PR is recreated from the new head.
3. Commits only the changed files to that branch with the existing `create_commit_with_files(token, repo, branch, files, message, expected_base_sha)`, message `docs: sync planning documents from PromptWorkspace`.
4. Opens the PR (or updates the existing PR's body) with a title, a list of changed files and a note that a hand-edited file in the repository shows up in the diff and should be reviewed, not assumed overwritten.
5. Never force-pushes, never writes to the default branch, never merges.

New `GithubClient` methods (Protocol, real client and fake): `create_branch(token, repo, branch, from_sha)`, `find_open_pull_request(token, repo, head_branch)`, `create_pull_request(token, repo, head, base, title, body)`, `update_pull_request(token, repo, number, body)`. Errors map to specific codes that carry GitHub's status: `github_pr_permission_denied` (403, the token lacks Pull requests write), `github_branch_conflict` (422 on a ref that moved), `github_sync_failed` (anything else, with the status in the log). The generic `github_repo_not_in_token_scope` message is not reused here (finding 80).

### 5. Web: banner and action

When the project is at `repo_created`, the Planner calls `docs-status` (SWR, refetch on focus) and shows, above the stages, either nothing (all current), a banner "Repository documents are out of date: N files" with a **Review and open a pull request** button, or "Pull request #n is open" with a link. The button calls `sync-docs`, shows the returned link, and shows the specific error text for the three error codes above. Only admins and tech stewards see the button; members see the banner as information.

### 6. Token permission

Opening a pull request needs the fine-grained token permission **Pull requests: Read and write** on top of Contents, Administration, Webhooks, Secrets, Variables and Workflows. Add it to the workspace settings copy, `docs/DEPLOYMENT.md` and ADR 0017's list. It cannot be checked at connect time (fine-grained tokens expose no introspection), which is why the 403 gets its own error code.

## Data and migrations

None. Staleness is computed on demand from the cloud documents and the repository tree, so there are no stored hashes and no schema change, which also keeps older repositories (created before this feature) working: their first status call compares against whatever is in the repository.

## Error handling and edge cases

- Imported projects: the seed for an imported repository is written under `docs/promptworkspace/` where a document would have landed on an existing file (the `fit_to_existing_repo` rule). The status and the PR use `fit_to_existing_repo` against the live tree so a hand-written `README.md` is not offered as "out of date" and nothing is written over an existing file at a path the seed would have avoided.
- A repository whose default branch moved between status and PR: `expected_base_sha` makes the commit fail with `github_branch_conflict`; the UI asks the user to retry.
- Empty plan or rules (document deleted): the file is omitted from the rebuilt set exactly as `build_seed_files` omits it, so it is never reported `out_of_date`.
- Rate limits and GitHub outages return 502 `github_sync_failed`; the status route degrades to 502 without breaking the Planner (the banner is hidden).

## Testing

- Cloud unit tests with the fake GitHub client in both repository backends (in-memory and Supabase-contract where the project row matters): status classification (`current`, `out_of_date`, `missing`, hand-edited file), the blob-sha comparison against known git hashes, sync creates one branch and one PR, a second call updates the same PR, `repository_docs_current` when nothing changed, permission and conflict error mapping, member vs admin access, imported-project path mapping, and that deployment files and `site/` are never in the set.
- Acceptance test: approve the plan, move the project to `repo_created`, edit the plan, assert the decision is stale and tasks regenerate.
- Web tests: stages editable at `repo_created` for an admin, policy scope and template still read-only, banner states, confirm step on Generate, button hidden for members, error texts.
- Live check on trust with "Marketing Studio Listings": edit the plan to plain JS, regenerate tasks, open the sync PR, review it, merge it.

## Review focus (inputs most likely to bite a person)

1. A repository file that a person edited by hand: must appear in the PR diff and never be overwritten without review.
2. A project whose repository was imported (docs under `docs/promptworkspace/`): the PR must not write over their own `README.md` or `AGENTS.md`.
3. Two people opening the sync at once: one branch, one PR, no duplicate commits.
4. A token without Pull requests write: a clear, specific error, not "token scope".
5. A project at `repo_created` with no plan yet (older projects): the stages are editable and the status route does not crash on missing documents.

## Open question left for review

Whether Generate after `repo_created` should keep the confirm step only, or also require the plan approval to be re-requested explicitly first. This spec keeps the confirm only; a re-approval is already forced by the hash change.
