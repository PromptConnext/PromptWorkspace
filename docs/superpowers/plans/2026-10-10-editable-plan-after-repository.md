# Editable plan after the repository exists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a project's repository exists, a person can edit the Specify, project-rules and Plan documents, and the repository's seeded copies catch up through a pull request that a person merges.

**Architecture:** The freeze is web-only, so the web unfreezes three stages and adds a banner. The cloud gains two routes (`docs-status`, `sync-docs`) in one new router. Staleness is computed on demand by comparing the git blob sha of each rebuilt seed document with the entry in the default branch's tree, so there is no migration. The sync writes one commit to a `pw/sync-docs-<timestamp>` branch and opens (or updates) one PR; it never writes to the default branch.

**Tech Stack:** FastAPI + Pydantic v2 (apps/cloud), in-memory and Supabase repository adapters (unchanged), `FakeGithubClient` / `HttpGithubClient` (app/integrations/github.py), Next.js 16 + React 19 + vitest (apps/web).

**Spec:** `docs/superpowers/specs/2026-10-10-editable-plan-after-repository-design.md` (approved 2026-10-10). Rulings that amend the spec are listed under "Rulings" below.

## Global Constraints

- No schema change, no migration.
- The sync never force-pushes, never writes to the default branch, never merges, never touches `site/`, `.github/`, `package.json` or any deployment file. The path set is exactly `DOC_PATHS` in Task 1.
- Cloud tests are hermetic (`DATA_BACKEND=memory`); ruff line length 100; `python -m pytest -q` and `ruff check .` from `apps/cloud` stay green.
- Web: `pnpm --filter ./apps/web typecheck` (run from the main checkout; the known `auth/ui.tsx` @types/react error appears only in worktrees) and `vitest run` stay green.
- Error strings are specific codes the UI maps to text; never reuse `github_repo_not_in_token_scope` here (finding 80).
- Commit after each task. Never commit secrets or `.env*`.

## Rulings (amend the spec)

1. **Branch naming.** The spec said one long-lived branch. A merged PR leaves that branch behind and reusing it would need a force-push, so each sync uses a new `pw/sync-docs-<YYYYMMDDHHMMSS>` branch, and "the open sync PR" means the open PR whose head starts with `pw/sync-docs-`. A second call while one is open commits onto that branch and updates its body.
2. **Imported repositories are out of scope for v1.** The seed for an imported repo is relocated by `fit_to_existing_repo` against the user's own files, and re-deriving that after the seed exists would mis-classify the seeded files as conflicts. Both new routes answer 409 `sync_not_supported_for_imported_repository` when `project.repo_origin == "imported"`, and the banner is not shown. Follow-up: plan 0029.
3. **Status route cost.** One `get_branch_head` plus one recursive `get_tree_entries`; a truncated listing answers 409 `repo_tree_too_large` instead of guessing.

## Review Focus

1. A repository file a person edited by hand shows as `out_of_date` and appears in the PR diff; nothing is overwritten without review. (Task 3 test `test_hand_edited_file_is_reported_and_goes_in_the_pr`.)
2. Two syncs in a row open one PR, not two. (Task 3 `test_second_sync_updates_the_same_pull_request`.)
3. A token without Pull requests write gets `github_pr_permission_denied`, not a scope message. (Task 3.)
4. A project at `repo_created` with no plan document: status and the stages do not crash. (Task 3 `test_missing_documents_are_skipped_not_reported`, Task 5.)
5. Deployment files and `site/` can never be in the PR. (Task 1 `test_deployment_files_are_never_in_the_set`, Task 3.)

---

### Task 1: Document set and blob-sha comparison (pure functions)

**Files:**
- Create: `apps/cloud/app/integrations/repo_docs.py`
- Test: `apps/cloud/tests/test_repo_docs.py`

**Interfaces:**
- Consumes: `SeedFile` (`app/integrations/repo_seed.py`, fields `path`, `content`).
- Produces: `DOC_PATHS: frozenset[str]`, `git_blob_sha(content: str) -> str`, `DocState` dataclass (`path: str`, `state: Literal["current", "out_of_date", "missing"]`), `classify_docs(seed_files: list[SeedFile], tree_blobs: dict[str, str]) -> list[DocState]`, `changed_files(seed_files, states) -> list[SeedFile]`.

- [ ] **Step 1: Write the failing tests** in `apps/cloud/tests/test_repo_docs.py`:

```python
from app.integrations.repo_docs import DOC_PATHS, changed_files, classify_docs, git_blob_sha
from app.integrations.repo_seed import SeedFile


def test_git_blob_sha_matches_git():
    # `printf 'hello\n' | git hash-object --stdin`
    assert git_blob_sha("hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"
    # git hashes bytes: a multibyte character counts as its UTF-8 length.
    # `printf 'ก' | git hash-object --stdin`
    assert git_blob_sha("ก") == "7fd735ce7bc5bc5be1f7592df7dad8fc56ace878"


def test_classify_current_out_of_date_and_missing():
    files = [SeedFile("AGENTS.md", "a"), SeedFile("docs/scope.md", "b"), SeedFile("docs/architecture.md", "c")]
    tree = {"AGENTS.md": git_blob_sha("a"), "docs/scope.md": git_blob_sha("OLD")}
    states = {s.path: s.state for s in classify_docs(files, tree)}
    assert states == {
        "AGENTS.md": "current",
        "docs/scope.md": "out_of_date",
        "docs/architecture.md": "missing",
    }


def test_deployment_files_are_never_in_the_set():
    files = [
        SeedFile(".github/workflows/deploy.yml", "x"),
        SeedFile("site/index.html", "y"),
        SeedFile("docs/deployment.md", "z"),
        SeedFile("AGENTS.md", "a"),
    ]
    paths = [s.path for s in classify_docs(files, {})]
    assert paths == ["AGENTS.md"]
    assert ".github/workflows/deploy.yml" not in DOC_PATHS
    assert "site/index.html" not in DOC_PATHS and "docs/deployment.md" not in DOC_PATHS


def test_changed_files_returns_only_what_differs():
    files = [SeedFile("AGENTS.md", "a"), SeedFile("docs/scope.md", "b")]
    states = classify_docs(files, {"AGENTS.md": git_blob_sha("a")})
    assert [f.path for f in changed_files(files, states)] == ["docs/scope.md"]
```

- [ ] **Step 2: Run to confirm failure**

Run (from `apps/cloud`): `python -m pytest tests/test_repo_docs.py -q`
Expected: FAIL, `ModuleNotFoundError: app.integrations.repo_docs`.

- [ ] **Step 3: Implement `repo_docs.py`**

```python
"""Which of a repository's seeded planning documents are out of date.

The seed (`repo_seed.build_seed_files`) writes derived views of the stage
documents into the repository. Once those documents can be edited after the
repository exists, the views drift. This module answers "which files differ"
without fetching any file: GitHub's tree listing already carries each blob's
git sha, and a git blob sha is a pure function of the content, so it can be
computed locally from the rebuilt seed file and compared.

Only document views are ever in scope. The deployment template's files
(`.github/workflows/*`, `site/`, `docs/deployment.md`) are owned by the
template and never offered for sync.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

from app.integrations.repo_seed import SeedFile

DOC_PATHS: frozenset[str] = frozenset(
    {
        "AGENTS.md",
        "README.md",
        "docs/scope.md",
        "docs/architecture.md",
        "docs/tasks.md",
        "docs/conventions.md",
        "docs/policy-scope.md",
        ".specify/memory/constitution.md",
    }
)


def git_blob_sha(content: str) -> str:
    """The sha git gives a file with this content: sha1 over `blob <bytes>\\0`
    plus the UTF-8 bytes. (sha1 is git's object id, not a security control.)"""
    data = content.encode("utf-8")
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()  # noqa: S324


@dataclass(frozen=True)
class DocState:
    path: str
    state: Literal["current", "out_of_date", "missing"]


def classify_docs(seed_files: list[SeedFile], tree_blobs: dict[str, str]) -> list[DocState]:
    """One entry per rebuilt document view, in seed order. `tree_blobs` maps a
    repository path to its blob sha at the default branch head."""
    states: list[DocState] = []
    for seed_file in seed_files:
        if seed_file.path not in DOC_PATHS:
            continue
        current_sha = tree_blobs.get(seed_file.path)
        if current_sha is None:
            states.append(DocState(seed_file.path, "missing"))
        elif current_sha == git_blob_sha(seed_file.content):
            states.append(DocState(seed_file.path, "current"))
        else:
            states.append(DocState(seed_file.path, "out_of_date"))
    return states


def changed_files(seed_files: list[SeedFile], states: list[DocState]) -> list[SeedFile]:
    wanted = {s.path for s in states if s.state != "current"}
    return [f for f in seed_files if f.path in wanted]
```

- [ ] **Step 4: Run to confirm pass** — `python -m pytest tests/test_repo_docs.py -q` → 4 passed. Then `ruff check app tests`.
- [ ] **Step 5: Commit** — `git add apps/cloud/app/integrations/repo_docs.py apps/cloud/tests/test_repo_docs.py && git commit -m "feat(cloud): classify seeded repository documents by git blob sha"`

---

### Task 2: GitHub client — branch, pull request, and a fake that models branches

**Files:**
- Modify: `apps/cloud/app/integrations/github.py` (Protocol, `HttpGithubClient`, `FakeGithubClient`)
- Test: `apps/cloud/tests/test_github_pull_requests.py` (HTTP layer, same `httpx.MockTransport` pattern as `tests/test_github_contents_upsert.py`), `apps/cloud/tests/test_repo_docs_fake.py` (fake behaviour)

**Interfaces:**
- Produces (Protocol, Http and Fake, all `async`):
  - `create_branch(self, token: str, repo: str, branch: str, from_sha: str) -> None` — `POST /repos/{repo}/git/refs` `{"ref": "refs/heads/<branch>", "sha": from_sha}`; 422 "Reference already exists" raises `GithubBranchMovedError`; other errors `GithubWriteError(status_code=...)`.
  - `find_open_pull_request(self, token: str, repo: str, head_prefix: str) -> dict | None` — `GET /repos/{repo}/pulls?state=open&per_page=100`, returns the first PR whose `head.ref` starts with `head_prefix` as `{"number", "html_url", "head"}` or `None`.
  - `create_pull_request(self, token: str, repo: str, head: str, base: str, title: str, body: str) -> dict` — `POST /repos/{repo}/pulls`, returns `{"number", "html_url", "head"}`.
  - `update_pull_request(self, token: str, repo: str, number: int, body: str) -> None` — `PATCH /repos/{repo}/pulls/{number}`.
  - `get_branch_head(token, repo, branch)` already exists; the real one reads `heads/<branch>` so it works for the new branch.
- Fake additions: `branch_refs: dict[tuple[str, str], str]`, `pull_requests: list[dict]` (`number, head, base, title, body, html_url, state`), `sha_files: dict[str, dict[str, str]]` (commit sha → path → content snapshot), `fail_pr_status: int | None`.
- Fake behaviour changes (keep every existing test green):
  1. `get_branch_head(repo, branch)`: if `(repo, branch)` is in `branch_refs`, return it; else existing behaviour.
  2. `create_commit_with_files(repo, branch, ...)`: after the existing checks, `parent = branch_refs.get((repo, branch)) or branch_heads.get(repo, "fake-head-0")`; record `sha_files[commit_sha] = {**sha_files.get(parent, {}), **{f.path: f.content for f in files}}`; if `(repo, branch)` is in `branch_refs`, move `branch_refs[(repo, branch)]` and do NOT move `branch_heads[repo]`; otherwise move `branch_heads[repo]` as today. `commits` entries keep their shape.
  3. `get_tree_entries(repo, sha, recursive=True)`: when `sha in sha_files`, also list each snapshot path as `{"path", "type": "blob", "sha": git_blob_sha(content)}` (merged with the existing `trees`/`gitlinks` entries; a snapshot path overrides). When `sha` is the default head and `sha_files` has no snapshot for it, behave exactly as before.
  4. `create_branch`: `branch_refs[(repo, branch)] = from_sha`; raises `GithubBranchMovedError` if it exists; `sha_files[from_sha]` stays as is (a branch starts at the same tree).
  5. `create_pull_request`: assigns `number = len(pull_requests) + 1`, `html_url = f"https://github.com/{repo}/pull/{number}"`, state `open`; honours `fail_pr_status` by raising `GithubWriteError(status_code=...)`. `find_open_pull_request` and `update_pull_request` act on that list.

- [ ] **Step 1: Write failing HTTP-layer tests** (`test_github_pull_requests.py`): with `monkeypatch` of `httpx.AsyncClient` to a `MockTransport` as in `test_github_contents_upsert.py`, assert (a) `create_branch` POSTs `/git/refs` with `refs/heads/pw/sync-docs-x` and the sha, (b) a 422 `{"message":"Reference already exists"}` raises `GithubBranchMovedError`, (c) `find_open_pull_request` returns the PR whose `head.ref` starts with the prefix and `None` otherwise, (d) `create_pull_request` returns `{"number","html_url","head"}` from the 201 body and a 403 raises `GithubWriteError` with `status_code == 403`, (e) `update_pull_request` PATCHes the body.
- [ ] **Step 2: Write failing fake tests** (`test_repo_docs_fake.py`): a seed commit then `get_tree_entries(get_branch_head(...))` lists the committed paths with `git_blob_sha` shas; `create_branch` + a commit onto it changes `branch_refs` and leaves the default branch's listing unchanged; `create_pull_request` numbers 1, 2 and `find_open_pull_request` finds by prefix.
- [ ] **Step 3: Run both** (`python -m pytest tests/test_github_pull_requests.py tests/test_repo_docs_fake.py -q`), expect FAIL.
- [ ] **Step 4: Implement** the four methods in the Protocol and `HttpGithubClient` (use `_send(...)`, build errors as `GithubWriteError(f"<what> failed for {repo}: {resp.status_code} {resp.text}", status_code=resp.status_code)` exactly like `create_tree`), and the fake changes above. Import `git_blob_sha` from `app.integrations.repo_docs` inside the fake's methods to avoid a cycle if needed.
- [ ] **Step 5: Run the whole cloud suite** — `python -m pytest -q && ruff check .` — every existing test must stay green (the fake changes are additive: `trees`-only repos behave as before).
- [ ] **Step 6: Commit** — `feat(cloud): GitHub client branch and pull request calls, fake models branches`

---

### Task 3: `docs-status` and `sync-docs` routes

**Files:**
- Create: `apps/cloud/app/api/repository_docs.py`
- Modify: `apps/cloud/app/main.py` (import and `app.include_router(repository_docs.router)` next to `sync.router`), `apps/cloud/app/models/schemas.py` (new response models)
- Test: `apps/cloud/tests/test_repository_docs_api.py`

**Interfaces:**
- Consumes: `build_seed_files`, `fit_to_existing_repo` not used (Ruling 2); `_seed_stage_docs` and `repo_full_name_from_url`/`resolve_token` as used by `seed_preview` in `app/api/sync.py` (import `_seed_stage_docs` from `app.api.sync` with a one-line comment that it is the shared seed-input read); `classify_docs`, `changed_files`, `git_blob_sha` (Task 1); the client methods from Task 2.
- Produces (schemas.py):

```python
class RepositoryDocFile(BaseModel):
    path: str
    state: Literal["current", "out_of_date", "missing"]

class OpenSyncPr(BaseModel):
    number: int
    url: str

class RepositoryDocsStatus(BaseModel):
    files: list[RepositoryDocFile]
    open_sync_pr: OpenSyncPr | None = None

class SyncDocsOut(BaseModel):
    pr_number: int
    pr_url: str
    branch: str
    files: list[str]
```

- Routes: `GET /projects/{project_id}/repository/docs-status` (`require_project`, any member) and `POST /projects/{project_id}/repository/sync-docs` (`require_project` + `require_stage_access(repo, project, "plan", user)`, i.e. admin, so a tech steward/admin only).
- Shared helper `_load_status(request, repo, project)` returns `(states, seed_files, token, full_name, default_branch, head_sha)`; both routes use it:
  1. `project.lifecycle_status != "repo_created"` or no `repo_url` → 409 `repository_not_created`; `project.repo_origin == "imported"` → 409 `sync_not_supported_for_imported_repository`.
  2. `workspace = repo.get_workspace(project.workspace_id)`; `resolve_token(request.app, workspace)` else 400 `github_not_configured`; `full_name = repo_full_name_from_url(project.repo_url)` else 409 `repo_url_unrecognized`.
  3. `seed_files = build_seed_files(project, _seed_stage_docs(repo, project.id))`.
  4. `default_branch = project.repo_default_branch or "main"`; `head_sha = await gh.get_branch_head(token, full_name, default_branch)`; `entries, truncated = await gh.get_tree_entries(token, full_name, head_sha)`; truncated → 409 `repo_tree_too_large`; `tree_blobs = {e["path"]: e["sha"] for e in entries if e["type"] == "blob" and e.get("sha")}`; `states = classify_docs(seed_files, tree_blobs)`.
  5. `GithubWriteError` while reading → 401/403 → 400 `github_read_forbidden`, otherwise 502 `github_unreachable`.
- `sync-docs` flow after `_load_status`:

```python
changed = changed_files(seed_files, states)
if not changed:
    raise HTTPException(409, "repository_docs_current")
pr = await gh.find_open_pull_request(token, full_name, "pw/sync-docs-")
try:
    if pr is None:
        branch = "pw/sync-docs-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        await gh.create_branch(token, full_name, branch, head_sha)
    else:
        branch = pr["head"]
    await gh.create_commit_with_files(
        token, full_name, branch, changed, "docs: sync planning documents from PromptWorkspace"
    )
except GithubBranchMovedError as exc:
    raise HTTPException(409, "github_branch_conflict") from exc
except GithubWriteError as exc:
    logger.warning("sync-docs write for %s failed: %s", full_name, exc)
    raise HTTPException(502, "github_sync_failed") from exc
body = _pr_body(changed)
try:
    if pr is None:
        pr = await gh.create_pull_request(
            token, full_name, branch, default_branch,
            "docs: sync planning documents from PromptWorkspace", body,
        )
    else:
        await gh.update_pull_request(token, full_name, pr["number"], body)
except GithubWriteError as exc:
    logger.warning("sync-docs pull request for %s failed: %s", full_name, exc)
    code = "github_pr_permission_denied" if getattr(exc, "status_code", None) in (403, 404) else "github_sync_failed"
    raise HTTPException(400 if code.endswith("denied") else 502, code) from exc
return SyncDocsOut(pr_number=pr["number"], pr_url=pr["html_url"], branch=branch, files=[f.path for f in changed])
```

`_pr_body(changed)` lists the changed paths and says, in two sentences, that the files were regenerated from the project's planning documents and that a file edited by hand in the repository appears in this diff and must be reviewed, not assumed overwritten.

- `docs-status` returns `RepositoryDocsStatus(files=[RepositoryDocFile(...)], open_sync_pr=...)` where `open_sync_pr` comes from `find_open_pull_request`; a failure in that lookup is logged and answers `open_sync_pr=None` (it is decoration, never an error).

- [ ] **Step 1: Write failing tests** in `test_repository_docs_api.py`. Helpers: copy `_workspace`, `_connect` and the `ALICE`/`BOB` headers pattern from `tests/test_repo_import.py` (lines 46-57 and the module constants); add `_created_project(client)` that creates a scratch project in the connected workspace, writes `specify`, `constitution`, `plan` and `tasks` stage documents through `PUT /projects/{pid}/stage-documents/{stage}` (use the same payload shape the stage-documents tests use; `tests/test_stage_documents_repo.py`), sets lifecycle to `tech_review` through `client.app.state.repository.update_project_lifecycle_status`, then `POST /projects/{pid}/lifecycle/create-repository` with the fake client, and returns `pid`. Tests (names fixed):
  - `test_status_is_current_right_after_creation` — every file `current`, `open_sync_pr is None`.
  - `test_editing_the_plan_marks_docs_architecture_out_of_date` — PUT a new plan, status shows `docs/architecture.md` `out_of_date` and the others `current`.
  - `test_missing_documents_are_skipped_not_reported` — a project with no `plan` document: status lists no `docs/architecture.md` entry and answers 200.
  - `test_hand_edited_file_is_reported_and_goes_in_the_pr` — set `client.app.state.github_client.sha_files[head]["AGENTS.md"] = "hand edited"` (the head from `get_branch_head`), status says `AGENTS.md` `out_of_date`, sync includes it and the PR body mentions hand edits.
  - `test_sync_opens_one_pr_with_only_changed_docs` — after a plan edit, `POST sync-docs` returns 200 with `files == ["docs/architecture.md"]` (plus any other changed docs), `fake.pull_requests` has one open PR whose `head` starts with `pw/sync-docs-` and `base == "main"`, the new commit's `paths` equals `files`, and the default branch head is unchanged.
  - `test_second_sync_updates_the_same_pull_request` — edit plan, sync, edit plan again, sync: still one PR, a second commit on the same branch, PR body updated.
  - `test_sync_when_nothing_changed_is_409` — `repository_docs_current`.
  - `test_deployment_files_are_never_in_the_pr` — assert no committed path starts with `.github/` or `site/` and none equals `docs/deployment.md`.
  - `test_token_without_pull_request_permission` — `fake.fail_pr_status = 403` → 400 `github_pr_permission_denied`.
  - `test_sync_is_admin_only_and_status_is_member_readable` — add BOB as a workspace member (as in `test_seed_preview_is_admin_only`): BOB GET 200, BOB POST 403.
  - `test_not_created_and_imported_projects_are_refused` — a project at `planning` → 409 `repository_not_created`; a project with `repo_origin == "imported"` → 409 `sync_not_supported_for_imported_repository` (set it through the existing import helper or by `update_project_repo(..., repo_origin="imported")`).
- [ ] **Step 2: Run** `python -m pytest tests/test_repository_docs_api.py -q` — expect FAIL (404 on the routes).
- [ ] **Step 3: Implement** the schemas, the router, and the `main.py` registration.
- [ ] **Step 4: Run** the new tests, then the whole suite and `ruff check .`.
- [ ] **Step 5: Commit** — `feat(cloud): docs-status and sync-docs routes for the seeded planning documents`

---

### Task 4: Token permission copy, error text, docs

**Files:**
- Modify: `apps/web/src/components/project/CreateRepositoryPanel.tsx` (add `github_pr_permission_denied`, `github_branch_conflict`, `github_sync_failed`, `repo_tree_too_large`, `sync_not_supported_for_imported_repository`, `repository_docs_current` messages to the error map if it is shared; otherwise Task 5's banner owns them), the workspace GitHub-connection settings copy (search `Secrets and Variables` under `apps/web/src`), `docs/DEPLOYMENT.md`, `docs/decisions/0017-*.md` (append an amendment line).
- Test: update the settings component test that asserts the permission list, if one exists.

- [ ] **Step 1:** In the GitHub connection copy, add **Workflows** and **Pull requests** (both Read and write) to the permissions list. Find the string with `grep -rn "Secrets and Variables" apps/web/src` and edit it together with its test.
- [ ] **Step 2:** In `docs/DEPLOYMENT.md` extend the token-permissions passage the same way and add a sentence: a seed with a deployment template needs Workflows, opening the sync PR needs Pull requests, and both are discovered only when the call fails because fine-grained tokens cannot be inspected.
- [ ] **Step 3:** Append to ADR 0017 an "Amendment 2026-10-10" paragraph with the same two permissions and a pointer to the spec.
- [ ] **Step 4:** Run `pnpm --filter ./apps/web test -- --run` for the touched test files and `typecheck`.
- [ ] **Step 5: Commit** — `docs: token needs Workflows and Pull requests; sync error texts`

---

### Task 5: Web — unfreeze the stages, confirm on Generate, banner

**Files:**
- Modify: `apps/web/src/components/project/Planner.tsx` (lines near 750 and 1109-1113; `StageSection` at 191), `apps/web/src/lib/types.ts`, `apps/web/src/lib/hooks.ts` (or a local hook beside the component)
- Create: `apps/web/src/components/project/RepositoryDocsBanner.tsx`, `apps/web/src/components/project/RepositoryDocsBanner.test.tsx`
- Test: `apps/web/src/components/project/Planner.test.tsx` (update + add)

**Interfaces:**
- Consumes: `useCloudGet<T>(path, enabled, { refreshOnFocus: true })` (apps/web/src/lib/hooks.ts), `apiFetch` (apps/web/src/lib/api.ts), the cloud schemas of Task 3.
- Produces in `types.ts`: `RepositoryDocFile {path: string; state: "current"|"out_of_date"|"missing"}`, `RepositoryDocsStatus {files: RepositoryDocFile[]; open_sync_pr: {number: number; url: string} | null}`, `SyncDocsResult {pr_number: number; pr_url: string; branch: string; files: string[]}`.

- [ ] **Step 1: Banner tests first** (`RepositoryDocsBanner.test.tsx`), props `{ status: RepositoryDocsStatus | null; canSync: boolean; onSync: () => Promise<SyncDocsResult> }`:
  - all `current` and no PR → renders nothing;
  - 2 files not current → "Repository documents are out of date: 2 files" and, when `canSync`, a "Review and open a pull request" button; when `!canSync` the text only;
  - clicking the button calls `onSync` once, shows "Pull request #7 opened" with a link to `pr_url`;
  - `open_sync_pr` set → "Pull request #3 is open" with its link, and no button;
  - an `onSync` rejection with message `github_pr_permission_denied` shows "The workspace's GitHub token needs the Pull requests permission (Read and write)." and `github_branch_conflict` shows "The default branch changed while syncing. Try again.".
- [ ] **Step 2: Implement `RepositoryDocsBanner.tsx`**: a `role="status"` box, amber styling consistent with `GenerationWarnings`; the error-code to text map above; the ready-to-use button label "Review and open a pull request"; `aria-live` on the result line.
- [ ] **Step 3: Planner tests** (update/add in `Planner.test.tsx`): with `lifecycle_status: "repo_created"` and an admin user, the Plan and constitution documents are editable (Generate button present and the textarea not `readOnly`); the policy scope panel and deployment template panel stay read-only (the existing tests at lines 1055 and 482 keep their policy assertions; adjust only the "read-only docs" expectation of line 482 to the new rule); a member who is not admin still sees the plan read-only (existing line 370 test unchanged); clicking Generate on the plan at `repo_created` calls `window.confirm` with text containing "replace" and does not generate when it returns false; the banner appears above the stages when the mocked `docs-status` has out-of-date files and is absent for an imported project.
- [ ] **Step 4: Implement the Planner changes.**
  - Keep `const readOnly = project.lifecycle_status === "repo_created"` for `PolicyScopePanel`, upload, deployment and repository panels.
  - Replace `const stageReadOnly = (readOnly && stage !== "tasks") || authorGated;` with `const stageReadOnly = authorGated;` and update the comment: after the repository exists the planning documents stay editable; their repository copies are synced through a pull request.
  - Add `confirmReplace` to `StageSection`: when `readOnly` is true and `stage !== "tasks"`, wrap the three `generate(stage, userInput)` call sites with `if (confirmReplace && !window.confirm(confirmReplace)) return;`, with text "This replaces the current document and makes the repository copy out of date. Continue?".
  - Above the stage list, when `project.lifecycle_status === "repo_created" && project.repo_origin !== "imported"`, fetch `docs-status` with `useCloudGet<RepositoryDocsStatus>(path, enabled, { refreshOnFocus: true })`, render `RepositoryDocsBanner` with `canSync={isTechLead}` (the existing admin flag) and `onSync` doing `apiFetch<SyncDocsResult>(..., { method: "POST" })` then `refetch()`. A status-fetch error hides the banner (log only).
- [ ] **Step 5: Run** `pnpm --filter ./apps/web test` (whole suite) and `typecheck` from the main checkout.
- [ ] **Step 6: Commit** — `feat(web): editable planning stages after the repository exists, with a docs sync banner`

---

### Task 6: Approval and task regeneration acceptance test, docs, live check

**Files:**
- Test: `apps/cloud/tests/test_plan_edit_after_repository.py`
- Modify: `docs/plans/0029-agent-native-delivery.md` (one sentence in §1.4 or the slice notes: the planning stages are editable after `repo_created`, synced through a PR), the spec status line to "implemented".

- [ ] **Step 1: Write the test** using the Task 3 helper (move `_created_project` into `tests/conftest.py` or a `tests/_repo_docs_helpers.py` if both files need it): at `repo_created`, request and approve the delivery plan (`POST /projects/{pid}/decisions` flow from `tests/test_delivery_*.py`; reuse their helper if one exists), then `PUT` a different plan document and assert `GET /projects/{pid}/delivery-overview` (or the decisions route) reports the plan decision as stale ("Changed since approval"); then `POST /projects/{pid}/generate/tasks` is not refused at `repo_created`. If the approval API needs more setup than the existing delivery tests show, copy that setup, do not invent one.
- [ ] **Step 2: Run** the test; if the plan approval is not marked stale after an edit at `repo_created`, that is a real defect: fix it in `app/delivery/approvals.py` (hash binding must not depend on lifecycle) and add the regression test here.
- [ ] **Step 3: Docs.** Update plan 0029 and the spec status. Run the full verification (cloud `python -m pytest -q && ruff check .`; web typecheck + `vitest run`).
- [ ] **Step 4: Commit** — `test(cloud): plan edits after the repository make the approval stale; docs`
- [ ] **Step 5: Live check on trust (human steps, record the result in the findings file):** add the **Pull requests: Read and write** permission to the workspace's fine-grained token (the user does this), deploy the branch (push `feature/trust-outcome`), open "Marketing Studio Listings" → Plan, edit the plan to plain JS, confirm the plan card shows "Changed since approval", open the sync PR from the banner, review the diff in GitHub, merge it, reload the Planner and confirm the banner disappears.
