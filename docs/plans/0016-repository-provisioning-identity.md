# Plan 0016 — Persist a repository provisioning identity

**Date:** 2026-09-12 · **Status:** Implemented (M1–M5, 2026-09-20) · **ADR:** [0017](../decisions/0017-cloud-creates-project-repo-at-tech-review-exit.md)

`apps/cloud/app/api/sync.py:162-408` (`create_repository`) is the route that turns a project's tech review into a live GitHub repository, seeded with the constitution, spec, plan and tasks the Tech Lead just approved. Stated plainly because the impact is unusual for a "High" finding in this codebase: on a repository-name collision, that route adopts whatever repository the GitHub API hands back for the requested name, with nothing persisted anywhere that proves this project created it. It then writes Actions secrets, registers a webhook, and commits six files of planning documents into that repository — all before it has any evidence the repository is the one this project is supposed to own. A name collision with an unrelated but token-accessible repository is therefore not a retry recovery. It is writing a customer's planning documents and deployment credentials into someone else's repository. This plan closes that gap by giving the route a real identity to check before it adopts anything.

## What happens today, traced

`create_repository` runs a fixed, well-ordered sequence documented in its own docstring (`apps/cloud/app/api/sync.py:170-200`): build the seed files locally, resolve the token, resolve the deployment provider, create the repo, write secrets, register the webhook, commit, persist `repo_url`, flip the lifecycle. The step that matters here is repo creation, at `apps/cloud/app/api/sync.py:242-272`:

```python
description = f"PromptZone-managed repository for project {project.id}"
try:
    created = await github_client.create_org_repo(
        token, owner, name, description, body.private, github_config.get("owner_type", "Organization"),
    )
except RepoAlreadyExistsError:
    try:
        existing = await github_client.get_repo(token, f"{owner}/{name}")
    except GithubWriteError as exc:
        ...
    if existing is None:
        raise HTTPException(status_code=409, detail="repo_name_taken") from None
    created = existing
```

`create_org_repo` (`apps/cloud/app/integrations/github.py:517-562`) sends `description` to GitHub's `POST /orgs/{org}/repos` (or `/user/repos`) and returns only `full_name`, `html_url` and `default_branch` from the response — `description` is written but never read back. `RepoAlreadyExistsError` is raised at `apps/cloud/app/integrations/github.py:551` on GitHub's 422 "name already exists." The handler's only response to that is to call `get_repo` (`apps/cloud/app/integrations/github.py:564-585`), which itself returns only `full_name`, `html_url` and `default_branch` — no `id`, no `description`. If `get_repo` returns anything at all, `create_repository` treats it as `created` and continues straight into writing Actions secrets (`apps/cloud/app/api/sync.py:283-300`), registering a webhook with a freshly generated signing secret (`apps/cloud/app/api/sync.py:313-352`), and committing the seed files (`apps/cloud/app/api/sync.py:358-380`). Nothing between the `except RepoAlreadyExistsError:` at line 254 and the commit call at line 359 asks whether the repository GitHub just returned is one this project has ever touched.

The test suite documents the gap rather than catching it. `test_create_repository_retry_adopts_existing_repo_without_duplicate_create` (`apps/cloud/tests/test_lifecycle.py:264-283`) seeds `fake.existing_repos["acme/rocket-ship"]` with a bare `{full_name, html_url, default_branch}` dict — no `id`, no `description` — and asserts the route happily adopts it and advances to `repo_created`. That is the exact shape of an unrelated repository that merely happens to share a name: the fake cannot even express "this repo has a different owner" because nothing the route reads distinguishes one repository from another beyond the name it already used to look it up. `FakeGithubClient.create_org_repo` (`apps/cloud/app/integrations/github.py:1072-1092`) and `FakeGithubClient.get_repo` (`apps/cloud/app/integrations/github.py:1094-1099`) mirror the same omission: the fake's `existing_repos` dict is exactly as identity-blind as the real client's return shape.

The one signal that could have distinguished "our earlier attempt" from "a stranger's repository" — the project-specific `description` written at line 243 — is composed, sent, and then discarded. It is never compared against anything on the adoption path.

## Why a name is not an identity

A workspace's GitHub token, per the ADR 0017 amendment, is a fine-grained PAT scoped by its issuer — "All repositories," an organization, or an explicit list. Any of those grants can and typically does cover repositories this project never created: teammates' side projects, a former project's leftover repo, an unrelated team's service. `get_repo` succeeding is proof the token can read a repository with the requested name; it is not proof of provenance. Names collide for ordinary reasons that have nothing to do with retries: `_slugify(project.name)` (`apps/cloud/app/api/sync.py:242`) is deterministic, so two differently-scoped projects with similar names, or a project renamed to match something that already exists in the org, produce the identical string `create_org_repo` sends. Treating "GitHub returned a repo for this name" as "this is our repo" conflates a lookup key with an identity, and a lookup key that any accessible repository can satisfy is not an identity at all.

## M1 — Persist the binding at the moment creation succeeds

Persist the repository's stable numeric `id` (GitHub's own repository identifier, immutable across renames and transfers, unlike `full_name`) on the project row, at the same step and in the same non-best-effort code path that already writes `repo_url`.

**Why the project row, not `pz_repo_webhooks`.** `pz_repo_webhooks` (`apps/cloud/migrations/0020_repo_webhooks.sql`) looks like the natural home — it already exists to bind a repository to a project — but it is the wrong table for this identity. Its write in `create_repository` is conditional on `public_api_url` being set (`apps/cloud/app/api/sync.py:314`: `if public_api_url:`) and is explicitly best-effort even when that condition holds: the `service_repo.upsert_repo_webhook` call is wrapped in a bare `except Exception` that logs and swallows (`apps/cloud/app/api/sync.py:334-352`), on the stated reasoning that "bookkeeping must not strand the repo." A local `uvicorn app.main:app --port 8080` run with no `PUBLIC_API_URL` — the documented no-Supabase dev path in `CLAUDE.md` — never writes a `pz_repo_webhooks` row at all, yet still creates and seeds a repository and flips the project to `repo_created`. An identity binding that can silently not exist is not a binding a security-critical check can depend on. `Project.repo_url` and `Project.repo_default_branch` (`apps/cloud/app/models/schemas.py:496-497`), by contrast, are written unconditionally, synchronously, and non-best-effort at step 8 (`apps/cloud/app/api/sync.py:383`, `repo.update_project_repo(...)`) — a failure there is not swallowed, it propagates. The new identity field belongs next to them.

**Migration.** The highest existing migration is `apps/cloud/migrations/0027_deployment_tasks.sql`; add a new file in that directory numbered 0028, named 0028_project_repo_id.sql:

```sql
-- 0028 — persist the GitHub repository this project actually created (finding
-- 9, docs/cloud-codebase-review-2026-09-06.md). `repo_id` is GitHub's stable
-- numeric repository id, immutable across a rename or transfer — unlike
-- `repo_url`/`full_name`, which a collision can share with an unrelated
-- repository. Written once, at the same step that first writes `repo_url`
-- (apps/cloud/app/api/sync.py::create_repository), before the lifecycle
-- flips to repo_created. Nullable: every project created before this
-- migration has a repo_url with no recorded id.

alter table pz_projects add column if not exists repo_id bigint;
```

**Model.** Add `repo_id: int | None = None` to `Project` in `apps/cloud/app/models/schemas.py`, immediately after `repo_default_branch` (line 497), with a comment naming it the identity field this plan introduces.

**Repository layer.** Widen `update_project_repo` to take the id. The abstract method is `apps/cloud/app/db/repository.py:210-218`; its docstring already explains the write-before-lifecycle-flip ordering this field rides along with. Change the signature to `update_project_repo(self, project_id: str, repo_url: str, repo_id: int, default_branch: str) -> Project`. Update both implementations: `InMemoryRepository.update_project_repo` (`apps/cloud/app/db/repository.py:648-660`) adds `"repo_id": repo_id` to the `model_copy(update={...})` dict; `SupabaseRepository.update_project_repo` (`apps/cloud/app/db/supabase_repository.py:276-288`) adds `"repo_id": repo_id` to `patch`.

**GitHub client.** Both `create_org_repo` and `get_repo` currently discard the numeric id GitHub returns. Extend their return dicts to include it:

- `HttpGithubClient.create_org_repo` (`apps/cloud/app/integrations/github.py:517-562`): add `"id": data["id"]` to the dict returned at lines 558-562.
- `HttpGithubClient.get_repo` (`apps/cloud/app/integrations/github.py:564-585`): add `"id": data["id"]` to the dict returned at lines 581-585.
- `FakeGithubClient.create_org_repo` (`apps/cloud/app/integrations/github.py:1072-1092`): assign each fake-created repo an incrementing integer id (e.g. a `self._next_repo_id` counter on the fake) and store it in the `record` dict alongside `full_name`.
- `FakeGithubClient.get_repo` (`apps/cloud/app/integrations/github.py:1094-1099`): unchanged — it already returns whatever `self.existing_repos.get(repo)` holds, so once the create path stores an id, retrieval carries it for free. Tests that hand-seed `fake.existing_repos[...]` to simulate an *unrelated* repository (as `test_create_repository_retry_adopts_existing_repo_without_duplicate_create` does today) must now set that dict's `id` explicitly, which is what makes M4's collision tests meaningful rather than vacuous.

**Write site.** `apps/cloud/app/api/sync.py:383` becomes `repo.update_project_repo(project_id, created["html_url"], created["id"], default_branch)`.

## M2 — Only auto-adopt the known repository

The identity check has to work in two states a real retry can land in, not one. If a previous attempt crashed *after* `create_org_repo` succeeded but *before* step 8 persisted `repo_id` (`apps/cloud/app/api/sync.py:383`), `project.repo_id` is still `None` on the retry even though the repository is genuinely ours — that is the "safe retry" M3 also cares about, and a check that requires `repo_id` to already be set would wrongly reject it. The description written at creation (`apps/cloud/app/api/sync.py:243`) is exactly the signal available in that window, which is why the review calls it out as ignored rather than merely uncomputed.

Replace the current `except RepoAlreadyExistsError:` block (`apps/cloud/app/api/sync.py:254-272`) with logic that adopts only when one of two things holds:

1. **`project.repo_id` is already set and `existing["id"] == project.repo_id`** — a retry after `repo_id` was persisted once; the numeric id is authoritative regardless of what the description or name now say (a repo can be renamed or transferred without losing this project's ownership of it).
2. **`project.repo_id` is `None` and `existing.get("description") == description`** — the description-matching path covers the crash window between repo creation and `repo_id` persistence, where the id was never recorded but the exact string this project would have written is present on the repository GitHub just returned.

When neither holds — the case that matters most, an unrelated but accessible repository sharing the name — return a new conflict code rather than adopting:

```python
except RepoAlreadyExistsError:
    try:
        existing = await github_client.get_repo(token, f"{owner}/{name}")
    except GithubWriteError as exc:
        ...  # unchanged: 400 github_repo_not_in_token_scope / 502 github_repo_create_failed
    if existing is None:
        raise HTTPException(status_code=409, detail="repo_name_taken") from None
    is_our_repo = (
        project.repo_id is not None and existing["id"] == project.repo_id
    ) or (
        project.repo_id is None and existing.get("description") == description
    )
    if not is_our_repo:
        raise HTTPException(status_code=409, detail="repo_name_collision") from None
    created = existing
```

`repo_name_collision` follows the existing vocabulary in `apps/web/src/components/project/CreateRepositoryPanel.tsx:17-44` (`DETAIL_MESSAGES`), which already maps snake_case `detail` codes — `not_in_tech_review`, `repo_name_taken`, `github_repo_not_in_token_scope`, `deployment_provider_not_configured` — to user-facing sentences. `repo_name_taken` already means "GitHub says this name is claimed but we cannot resolve what claimed it"; `repo_name_collision` is the sibling for "we resolved it, and it is provably not ours." Add an entry to `DETAIL_MESSAGES` distinct from the existing `repo_name_taken` copy — for example, pointing the admin at choosing a different name or renaming the conflicting repository, rather than the "try again" framing `repo_name_taken` uses today, since retrying with the same name will hit the identical conflict every time.

## M3 — Make the seed idempotent against a real retry

M2 decides whether to adopt; this milestone bounds what a legitimate retry is allowed to repeat once it does. Two of the four post-adoption steps are already safe to repeat: `put_actions_secret` / `put_actions_variable` (`apps/cloud/app/api/sync.py:283-300`) are overwrites by construction, and `create_repo_webhook` (`apps/cloud/app/integrations/github.py:471-499`) treats GitHub's 422 as success (lines 493-494) specifically so a retry does not error on an already-registered hook — though the *local* `secret_ref` written by `upsert_repo_webhook` at that point can drift from GitHub's actual signing secret, since a fresh `new_webhook_secret()` (`apps/cloud/app/api/sync.py:316`) is generated and stored every retry regardless of whether GitHub's side changed. That drift is finding 8's problem exactly, and it is owned by a companion plan, docs/plans/0017-webhook-secret-rotation.md, once written — this plan does not fix it, only names it so M2's adoption fix is not mistaken for a fix to both.

The step this plan's scope does need to bound is the seed commit itself (`apps/cloud/app/api/sync.py:358-380`, calling `create_commit_with_files` at `apps/cloud/app/integrations/github.py:699-788`). ADR 0017 §5 notes the seed commit "fires `on: push` immediately," and a genuine retry — one that correctly adopts the same repository under M2 — currently rebuilds `seed_files` from the project's current stage documents and calls `create_commit_with_files` unconditionally, producing a brand new commit and a brand new CI/deploy run even when the six files are byte-identical to what the previous attempt already committed. That is the duplication worth preventing: not a correctness bug (the content converges either way), but a retry that silently re-triggers a customer's deployment pipeline. `create_commit_with_files` already computes the candidate `tree_sha` (`apps/cloud/app/integrations/github.py:760`) against `base_tree`, the branch's current tree read at `apps/cloud/app/integrations/github.py:730`; add a short-circuit immediately after line 760 that returns the existing `base_sha` without creating a commit or moving the ref when `tree_sha == base_tree`. A retry that lands on an unchanged repository then costs one read and no write; a retry that lands after the stage documents changed still commits, exactly as today.

What a genuine retry must not duplicate, restated: a second Actions-secret write and a second webhook-registration call are safe no-ops; a second *seed commit* with identical content is not a no-op, because GitHub's own `on: push` trigger cannot tell "retry" from "new work" — only this route can, and only by comparing trees before it commits.

## M4 — Tests

Add to `apps/cloud/tests/test_lifecycle.py`, alongside the existing retry tests at lines 264-330:

1. **Fresh creation** — no `existing_repos` entry; `create_org_repo` succeeds directly. Assert `repo_id` is persisted on the returned project and matches the fake's assigned id (extends the existing `test_create_repository_happy_path`, line 181, to assert on `repo_id` once M1 lands).
2. **Retry of our own partially-completed attempt** — seed `fake.existing_repos["acme/rocket-ship"]` with `description` equal to `f"PromptZone-managed repository for project {pid}"` and no `id` recorded on the project row (simulating the crash window before step 8 ran), the way `test_create_repository_retry_adopts_existing_repo_without_duplicate_create` (line 264) already sets up its fixture. Assert adoption succeeds, `lifecycle_status` reaches `repo_created`, and `repo_id` is now persisted.
3. **Collision with an unrelated accessible repository** — seed `fake.existing_repos["acme/rocket-ship"]` with a *different* `id` and a `description` that does not match this project's (e.g. `"Alice's personal fork"`), and leave the project's `repo_id` unset. Assert the route returns `409 repo_name_collision`, `lifecycle_status` stays `tech_review`, and — critically — assert no Actions secret, webhook, or commit call reached the fake (`fake.call_log` stays empty for this project), since the whole point is that none of those side effects should fire against a repository that failed the identity check.
4. **Collision with a repository the token cannot read** — unchanged from today's `test_create_repository_retry_reports_token_scope_when_the_repo_is_unreadable` (line 286) and `test_create_repository_retry_is_502_when_github_is_unwell` (line 310); confirm both still pass with the widened `except RepoAlreadyExistsError` block, since those branches return before the identity check ever runs.

Note for whoever implements M2/M3 together with the webhook fix in the companion plan: the review observed that the current fake "does not faithfully model the existing-hook case" (finding 8) — `FakeGithubClient.create_repo_webhook` (`apps/cloud/app/integrations/github.py:1054-1065`) simply appends to `self.webhooks` every call rather than modeling GitHub's 422-on-duplicate behavior the real client special-cases at lines 493-494. Test 2 above will pass against today's fake regardless, but it does not exercise that gap; docs/plans/0017-webhook-secret-rotation.md owns making the fake model the existing-hook case faithfully, since that is squarely about the secret-rotation half of the problem, not the identity half this plan fixes.

## M5 — Cross-workspace collision on the *import* path

M1–M4 close the gap on the *creation* path (`create_repository`, a name collision against an unrelated repository). A second, separate entry point shares the same underlying question and was not in scope when this plan was written: `POST /projects` with `import_repo_full_name` (`apps/cloud/app/api/sync.py:105-160`), where a workspace member points the platform at an *existing* GitHub repository rather than asking it to create one.

That path already guards against re-importing the same repo twice, but only within one workspace and only by string match:

```python
for existing in repo.list_projects_by_workspace(body.workspace_id):
    if existing.repo_url and repo_full_name_from_url(existing.repo_url) == full_name:
        raise HTTPException(status_code=409, detail="repo_already_imported")
```

(`apps/cloud/app/api/sync.py:136-138`). Two gaps, same root cause as M2's: a name, not an id, is being treated as identity, and the check's scope is arbitrarily narrowed to the importing workspace.

1. **Cross-workspace collision isn't checked at all.** A workspace's GitHub PAT is scoped by its issuer (ADR 0017 amendment) and routinely covers repositories an unrelated workspace already imported — an org-wide token sees every project's repo, not just the importer's own. Workspace B can currently "import" a repository workspace A already owns; nothing in `sync.py:136-138` looks past `body.workspace_id`. The result mirrors M1's original problem: two `pz_projects` rows both pointing at the same GitHub repository, with webhook delivery, deploy state and CI attribution ambiguous between them.
2. **`full_name` string matching is the same fragile key M2 replaced with `repo_id` for the creation path.** A rename or transfer changes `full_name` without changing the repository; two differently-named-over-time projects could both legitimately match or fail to match depending on when each check ran. `get_repo` (called at `sync.py:142`, just below the current check) already returns `id` as of M1 — the import path simply never reads it for this purpose.

**Fix — move the check after `get_repo`, key it on `repo_id`, and make it workspace-independent.** `find_project_by_repo_id` is a new repository method with no existing analogue (`list_projects_by_workspace` and `list_projects` are both membership-scoped by design — see `apps/cloud/app/db/repository.py:176-180` — neither can answer "does *any* project already own this repo"). Add it to the `Repository` ABC (`apps/cloud/app/db/repository.py`), alongside `get_project`:

```python
@abc.abstractmethod
def find_project_by_repo_id(self, repo_id: int) -> Project | None:
    """The project, in any workspace, whose repo_id matches — deliberately
    unscoped by membership, since this exists to detect a repository already
    claimed by a workspace the caller may not belong to."""
```

`InMemoryRepository`: scan `self._projects.values()` for a `repo_id` match (mirrors `list_projects_by_workspace`'s pattern at `repository.py:853`). `SupabaseRepository`: `self._client.table(_PROJECTS).select("*").eq("repo_id", repo_id).limit(1).execute()`, same shape as `get_project`.

Widen `create_project` (abstract + both implementations, `apps/cloud/app/db/repository.py:162-170`, `repository.py:737-755`, `apps/cloud/app/db/supabase_repository.py:332-349`) to accept `repo_id: int | None = None` and persist it at insert time — today only `update_project_repo` (the *creation* path's write site) persists `repo_id`; the import path calls `create_project` directly and would otherwise leave `repo_id` null forever, defeating M5 for every project imported after this lands.

Replace `sync.py:132-138`'s workspace-scoped loop with a global check run *after* `get_repo` returns (so `found["id"]` is available), before the empty-repo check is fully settled but after it — ordering matters only in that this must run once `found` exists:

```python
existing_project = repo.find_project_by_repo_id(found["id"])
if existing_project is not None:
    raise HTTPException(status_code=409, detail="repo_already_imported")
```

and pass the id through on creation: `repo.create_project(..., repo_id=found["id"])`.

**Why the error must stay generic.** `repo_already_imported`'s existing message ("Another project in this workspace already imports that repository," `apps/web/src/components/NewProjectDialog.tsx:24`) is safe today only because the check was workspace-scoped — the requester is necessarily a member of the workspace it's naming. Once the check spans workspaces, the requester may have no membership in whichever workspace already imported the repo, so the response must not name it, its project, or any other identifying detail — doing so would let any workspace member fingerprint another workspace's existence and project names just by trying to import repositories they don't otherwise have access to. Reuse the same `409 repo_already_imported` code for both the same-workspace and cross-workspace case (the fix is identical from the requester's side — pick a different repository) and update the copy to be scope-neutral: "This repository is already connected to a PromptConnext project." No new `DETAIL_MESSAGES` entry needed, only a copy edit.

**Tests**, added to `apps/cloud/tests/test_repo_import.py` alongside `test_import_duplicate_repo_in_same_workspace` (line 264):

1. **Same-workspace duplicate, by id.** Existing `test_import_duplicate_repo_in_same_workspace` continues to pass unchanged — same behavior, now reached via `repo_id` instead of `full_name`.
2. **Cross-workspace duplicate.** Create two workspaces both connected to the same GitHub owner (or with tokens that can both see the same repo), import the repo into workspace A, then attempt to import the identical repo into workspace B as a different user with no membership in A. Assert `409 repo_already_imported` and that the response body contains no reference to workspace A's id, name, or its project.
3. **Rename tolerance.** Import a repo, then have the fake report a different `full_name` for the same `id` on a second attempt (simulating a GitHub rename) — assert the collision is still caught, which `full_name`-only matching could not do.

## Suggested commit sequence

1. `feat(cloud): persist repo_id on project + migration 0028 (M1)` — schema, repository methods, GitHub client id plumbing.
2. `feat(cloud): only auto-adopt the known repository on name collision (M2)` — the identity check, `repo_name_collision`, web copy.
3. `feat(cloud): skip a no-op seed commit on retry (M3)` — tree comparison short-circuit.
4. `test(cloud): repository-identity adoption and collision cases (M4)`.
5. `feat(cloud): key the import-path duplicate check on repo_id, not workspace + name (M5)` — `find_project_by_repo_id`, `create_project` widening, scope-neutral copy, tests.

M1+M2 close the severity this plan exists for and should ship together; M3 is a correctness/cost improvement that can follow without re-opening the adoption logic; M4 should land with whichever of M1/M2 introduces the behavior it tests, not as a trailing cleanup. M5 is independent of M1–M4's internals (it touches the import path, not `create_repository`) but depends on M1's `repo_id` field and GitHub-client id plumbing already existing.
