# ADR 0017 — The cloud creates the project's Git repository at tech-review exit and seeds it with the project's AI context

**Date:** 2026-07-28 · **Status:** Proposed · **Deciders:** product + engineering

**Prompted by the question:** *at what stage should the platform require a Git repository — at project creation, before planning, or only when the Tech Lead starts technical planning?*

**Numbering note:** `0016` was accidentally used twice (`0016-assign-tasks-to-workspace-members.md` and `0016-vscode-compatible-shell.md`). This ADR takes `0017`; future authors should check before claiming a number.

**Amends / extends:**

- **ADR 0009** (orchestrate external agents, no own runtime): the agents PromptConnext orchestrates read their instructions from the repository. This ADR makes those instructions exist *before* the first agent ever runs.
- **ADR 0010** §5 (credentials never sync): upheld, and extended to a new credential class. The cloud gains GitHub *write* capability but still persists no token; the desktop gains *clone* capability but holds no token at all.
- **ADR 0015** (cloud-projected roster): the roster already carries `lifecycle_status` and `repo_url` down to the engine. This ADR is what finally puts values in those fields and teaches the consumer side to act on them.
- **Design spec** `docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md` §D, which named the desktop clone handoff and explicitly deferred it as unbuilt.

---

## Context

### Where things stand

The lifecycle `planning → pending_tech_review → tech_review → repo_created` is declared in `apps/cloud/app/models/schemas.py` and migrated in `migrations/0018_project_lifecycle.sql`, complete with `repo_url` and `repo_default_branch` columns. The engine mirrors all three fields into its roster cache. On paper the whole path exists.

In practice only the first transition is wired. `POST /projects/{id}/lifecycle/submit-for-review` flips `planning → pending_tech_review`; nothing in the codebase ever writes `tech_review` or `repo_created`, and `repo_url` has **zero writers** — every reference to it is a read. The GitHub integration (`apps/cloud/app/integrations/github.py`) can mint installation tokens and fetch file contents for RAG indexing, but has no write path and cannot create a repository.

The consequence lands on the developer. `POST /engine/cloud/projects/:id/open` ignores `repo_url` entirely and calls `createLocalProjectShell`, which unconditionally runs `git init -b main` in an empty directory. A developer who syncs a fully planned project on the desktop arrives at a blank folder: no `AGENTS.md`, no architecture, no conventions, no scope. Everything the business user and Tech Lead produced in the cloud stays in the cloud, and the coding agent that ADR 0009 orchestrates starts with nothing to read.

### The question this ADR answers

Requiring a repository **at project creation** is dead weight. At that moment the project is a name typed into an inline form on the workspace home; the scope, the stack, and often the real name are unsettled. Worse, planning is business-user work that happens entirely in the web app, where Git does not exist as a concept — a repo created then would sit empty through the whole planning phase and would likely need renaming by the end of it.

Requiring one **before planning begins** has the same defect for the same reason.

The right moment is the **exit of tech review**, because that is the first instant at which a repository can be born already useful. The Tech Lead has finished the constitution, spec, plan, and task breakdown; those four documents *are* the AI context. Creating the repo then means it never exists in an empty state.

---

## Decision

### 1 — The repo is created by the cloud at the `tech_review → repo_created` transition

`POST /projects/{id}/lifecycle/create-repository` creates the repository through the GitHub API under the workspace's installation, commits the seed files, and only then advances the project to `repo_created`. A companion `POST /projects/{id}/lifecycle/start-tech-review` fills the previously unwired `pending_tech_review → tech_review` hop.

The alternative — having the Tech Lead create the repo by hand and paste its URL into a form — was considered and rejected. It is a smaller build, but it makes the guarantee this ADR exists to provide (*every project that reaches a developer has a repo containing its AI context*) advisory rather than structural. A pasted URL can point at anything, including an empty repo, and nothing seeds it.

### 2 — The cloud commits the AI context; it is derived, not authored

Six files are written at repo creation, composed from the four existing stage documents:

| Path | Source |
|---|---|
| `AGENTS.md` | the `constitution` stage document, wrapped in a short preamble |
| `README.md` | project identity, a link back to the cloud project, and the `specify` summary |
| `docs/scope.md` | `specify`, in full |
| `docs/architecture.md` | `plan` |
| `docs/tasks.md` | `tasks` |
| `docs/conventions.md` | the conventions section of `constitution`, or a stub pointing at `AGENTS.md` |

These are **derived views composed at commit time**, not new authored documents. That distinction is load-bearing: the `stage` literal is closed in four places (the Pydantic model, the stage-documents router, a Postgres CHECK constraint, and the web's stage ordering), and widening it to add an "agents" stage would drag in a migration and re-open questions about RAG indexing for a file nobody edits in the cloud. Composing at commit time costs one pure function and no schema change. If authored AI-context ever becomes a real requirement, the answer is a dedicated table, not a widened enum.

A missing or empty stage document simply yields no file, except `README.md` and `AGENTS.md`, which always get a stub. Repo creation must never fail because planning was thin.

### 3 — Credential posture: reuse the App JWT, persist nothing

`apps/cloud/app/integrations/github.py` already mints short-lived installation tokens from the shared GitHub App's private key (`Settings.github_app_id` / `github_app_private_key`, server env) and discards them after a single request. Its module docstring states the rule plainly: *"No installation access token is ever persisted."*

That mechanism is reused unchanged for the write path. Explicitly rejected: a stored Personal Access Token, and putting a GitHub credential in `app/secrets.py` (which exists for workspace-scoped RAG model keys). Both would trade a strictly better posture for marginal convenience.

**The real cost is a permission widening, not a storage one.** Creating a repository requires the App to hold organization **Administration: Read & write**, and the installation must be scoped to **All repositories** — a repo-selected installation cannot see the repository it just created, so the follow-up contents write would 404. This is a genuine expansion of blast radius: the App can now create repositories in the customer's organization. It is the main trade-off this ADR accepts, and it is accepted because the alternative (a per-workspace stored PAT) is worse on every axis except this one.

### 4 — Membership-gated; no Tech Lead role

Both new transitions are gated by `require_project` — workspace membership — exactly as `submit-for-review` is today. "Tech Lead" remains a job description in the UI copy, not a role in the data model.

Introducing a real `tech_lead` role means touching the `Role` enum, the members table and its RLS policies, the invitation flow, the web member-management UI, and the desktop's cached member roster. That is a coherent piece of work, but it is a *different* piece of work, and coupling it to this one would delay a structural guarantee behind an access-control refactor. The cost of deferring is that any member can trigger repo creation. In a workspace where every member was invited by an admin, that is an acceptable v1 posture — and the transition is idempotent and observable, not destructive.

### 5 — Failure semantics: the external write is not transactional, so lifecycle advances last

Creating a repository and committing six files are remote mutations that can fail halfway. The ordering is therefore fixed and deliberate:

1. Resolve the GitHub config and **compose the seed files first** — cheap, local, and fails fast before anything external is touched.
2. Mint the installation token.
3. Create the repository with `auto_init: true` (the contents API cannot write into a zero-commit repository without blob/tree plumbing).
4. Commit each seed file. A failure here leaves a partially seeded repo and returns `502 github_seed_failed` — **the lifecycle does not advance**.
5. Only after every write succeeds: set `repo_url`, **then** set `lifecycle_status = repo_created`.

Step 5's order matters. The worst crash window leaves `repo_url` populated with the status still `tech_review`, which a retry treats as an adoptable repository. The reverse order would produce a `repo_created` project with no repo URL — a state nothing in the system can recover from. Retries re-enter at step 3, adopt an existing repository that looks like ours, and re-commit idempotently.

### 6 — The desktop clones; it never holds a token

The engine gains `cloneLocalProjectShell` alongside the existing `createLocalProjectShell`. `POST /engine/cloud/projects/:id/open` now refuses with `409 project_not_ready` unless the roster says `repo_created`, then branches on `repo_url`: clone when present, `git init` when null (local-only projects that were never cloud-provisioned). Pre-repo projects render in the desktop as informational badges with no open action.

**Clone authentication relies entirely on the developer's own Git credentials** — credential helper, `gh auth setup-git`, SSH agent, or a public repo. The engine never receives, stores, or forwards a GitHub token. This preserves ADR 0010 §5 and keeps the engine's threat surface unchanged, at the cost of a one-time `gh auth login` for private repositories.

**`repo_url` is untrusted input to the engine.** It arrives over the roster from the cloud, which is a separate trust boundary, and it lands in a `git clone` argument on the developer's own machine. Git's `ext::` transport executes an arbitrary shell command, and a URL beginning with `-` is parsed as a flag — so a compromised cloud, or a workspace admin who can write `integration_config`, would otherwise have remote code execution on every developer who opens the project. The engine therefore validates the URL against a scheme allowlist (`https://` and `git@host:` SSH shorthand only, no leading `-`) *before* spawning git, and additionally passes `-c protocol.ext.allow=never` and a `--` separator so the exploit fails even if validation is ever bypassed. This is the one place in the system where a cloud-authored value becomes a local process argument, and it is treated accordingly.

One operational detail is non-negotiable: the clone runs with `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=""`. Without them, a private-repo clone with no saved credentials blocks forever waiting on a terminal that does not exist inside an HTTP handler, hanging the engine rather than returning an error. The resulting failure must surface actionable copy naming `gh auth login` — a bare "clone failed" would be a dead end for the exact user most likely to hit it.

---

## Consequences

**Easier / better**

- **The handoff finally closes.** A developer who syncs a project gets a working tree that already contains the same source of truth the cloud holds. That is the "seamless business-planning-to-implementation" transition the product promises.
- **ADR 0009's external agents get their instructions for free.** `AGENTS.md` exists in the repo before any agent runs, without anyone remembering to write it.
- **`repo_created` becomes a meaningful state.** The desktop can distinguish "planned but not ready" from "ready to build" and stop offering a misleading open action.

**Harder / costs**

- **The GitHub App now needs org admin write.** A real privilege expansion, and one a security-conscious customer will ask about. A workspace-level org allowlist is the obvious future mitigation.
- **A failure mode with an external system.** Partial seeding is possible and must be retried; the regression test that pins "seed failure leaves lifecycle at `tech_review` with `repo_url` null" is the guard against silently shipping a half-transition.
- **Private repos need developer-side Git setup.** Unavoidable given the no-token posture, but it is friction at exactly the wrong moment (first clone), so the error copy carries real weight.
- **Newly created repos are not webhook-indexed.** `find_workspace_by_github_repo` matches a single repo per workspace, so PR and push events for a repo created this way will not reach the RAG pipeline. Known gap, accepted for v1, tracked separately.

**Revisit when**

- A customer refuses org `Administration: write` → consider a bring-your-own-repo path (Tech Lead pastes a URL, cloud seeds into the existing repo) as a fallback rather than a replacement.
- The single-repo-per-workspace webhook lookup becomes load-bearing → widen it to a list before the RAG gap compounds.
- Authored (not derived) AI context is demanded → add a dedicated table, do not widen the `stage` enum.
- A `tech_lead` role lands for other reasons → re-gate these two transitions on it.

---

## What changes, concretely (non-binding implementation map)

- **`apps/cloud/app/api/sync.py`** — `start-tech-review` and `create-repository` endpoints.
- **`apps/cloud/app/integrations/github.py`** — `create_org_repo`, `get_repo`, `put_file_content`, plus `GithubWriteError` / `RepoAlreadyExistsError`; `FakeGithubClient` extended so tests stay network-free.
- **`apps/cloud/app/integrations/repo_seed.py`** *(new)* — `build_seed_files`, pure and I/O-free.
- **`apps/cloud/app/db/repository.py`** + `supabase_repository.py` — `update_project_repo`, the first writer `repo_url` has ever had.
- **`apps/web/src/components/project/Planner.tsx`** — per-lifecycle-state branching; a new `CreateRepositoryPanel`; a minimal admin form for the GitHub install endpoint, which has had no UI at all.
- **`apps/engine/src/routes/projects.ts`** — `cloneLocalProjectShell` beside `createLocalProjectShell`, sharing a `registerLocalProject` tail.
- **`apps/engine/src/routes/cloud.ts`** — lifecycle gate and init-vs-clone branch on project open.
- **`apps/desktop/src/api.ts` / `Workspace.tsx` / `CloudOpenPanel.tsx`** — restore the roster fields the type currently drops; badges for pre-repo states; clone-mode copy.

No database migration is required: `repo_url` and `repo_default_branch` already exist, and the new `owner` field lives inside the existing `integration_config` jsonb.

---

## Action items

1. [ ] Accept / revise this ADR, especially §3 (the org `Administration: write` grant) and §4 (deferring the Tech Lead role).
2. [ ] Configure the shared GitHub App with org Administration: Read & write, installation scoped to All repositories, before enabling the endpoint in any environment.
3. [ ] Decide whether repo visibility should default to private per workspace policy rather than per request.
4. [ ] Track the webhook single-repo-per-workspace gap so newly created repos eventually reach the RAG pipeline.
5. [ ] Update `CLAUDE.md`'s cloud section once the endpoints land — the lifecycle description there currently says `submit-for-review` is the only wired transition.
