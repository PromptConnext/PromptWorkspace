# ADR 0023 — The development preview generalizes to every project type, and every build names the tasks inside it

**Date:** 2026-09-01 · **Status:** Proposed · **Deciders:** product + engineering

**Prompted by the decision:** *a stakeholder must be able to open the latest working version of any project — web, mobile, desktop or API — from the project page, see which completed tasks produced what they are looking at, and say something about it, without a development machine and without knowing what a commit is.*

**Extends:** [ADR 0021](0021-deployment-templates-seeded-ci-cloud-observed.md) — the Deployment Template contract gains one discriminator and one optional asset record; its boundaries, its webhook, its freeze semantics and its "the cloud never builds, hosts or proxies" rule are unchanged and are re-asserted here. [ADR 0022](0022-task-loop-closes-on-push.md) — the cloud starts *reading* the same task refs the extension reads, to attribute builds; it does not start writing task status. [ADR 0018](0018-assign-tasks-to-workspace-members.md) and [ADR 0020](0020-cloud-is-the-source-of-truth.md) — the task graph gains a derived relationship to deployments, authored by neither the desktop nor the editor.

**Does not decide** production hosting, billing, or how a project authenticates its own users. Like ADR 0021, this is a review surface.

---

## Context

### What already exists

ADR 0021 shipped further than the record suggests, and the honest starting point for this ADR is an inventory of it.

A project selects one template (`Project.deployment_config`, frozen at `repo_created`). At the `tech_review → repo_created` transition, `create_repository` (`apps/cloud/app/api/sync.py:160`) writes the Actions secrets and variables, registers a per-repo webhook with its own HMAC secret in `pz_repo_webhooks`, and then commits the scaffold, `.github/workflows/deploy.yml` and `docs/deployment.md` in one Git Data API commit. The project's own CI deploys. The cloud learns what happened through two events on the hook it already owns: `deployment_status` filtered to `environment == "preview"` (`apps/cloud/app/api/github.py:282`) and `workflow_run` filtered to terminal failures of the one seeded workflow path (`:325`), the latter existing purely so a build that dies before opening a deployment does not leave a preview stuck at "building" forever.

Each event upserts a `Deployment` row keyed `(project_id, external_key)` carrying `state`, `url`, `commit_sha`, `ref`, `run_url`, `error_code` and a measured `frame_policy`. `_refresh_deployment_state` (`:377`) then denormalizes the newest row onto `Project.deployment_state`, deliberately keeping `state` current and `url` last-known-good so a failed build never blanks a preview that is still serving.

The web app renders it. `PreviewPanel.tsx` reads exactly one endpoint, polls only while `pending > 0` with a bounded budget, and picks between a sandboxed `<iframe>` and a link card based on the server's measured `frame_policy` plus a `postMessage` handshake the scaffold performs (`site/pz-preview.js`). `safeWebUrl()` rejects anything that is not absolute http(s) before it reaches an `href` or a `src`. The workspace project list already shows a green "Live" pill from the denormalized state.

That is a working preview. It is not a working preview *feature*, for three reasons.

### The three gaps

**One template.** `BUILTIN_TEMPLATES` contains exactly one entry, `static-r2`: a static site synced to a per-workspace Cloudflare R2 bucket. ADR 0021's own implementation notes say to build the zero-third-party-account template first and then "ship the second template before considering the contract proven." The second template has not shipped, so the contract is, by its author's own standard, unproven. Worse, every field in `DeploymentTemplate` that could describe a non-web project — `embeddable`, `health_path`, `url_kind` — assumes the deliverable is a URL a browser can open. A native mobile app has no URL. A desktop app has an installer. An API has a URL that is meaningless in an iframe.

**No build knows what is in it.** `Deployment.commit_sha` records which commit produced a build. Nothing maps that commit to the tasks it completed. The only commit→task linkage anywhere is the `Artifact` row keyed `(task_id, commit_sha)` (`apps/cloud/app/models/schemas.py:165`), and it is written from exactly two places: the VS Code extension, when it observes a commit reach the remote and closes the task through `PATCH /projects/{id}/tasks/{tid}/status`; and `_handle_pull_request`, which links a PR to a task but never touches status. The cloud's `push` handler (`apps/cloud/app/api/github.py:531`) reads changed paths for RAG re-indexing and nothing else — it never looks at a commit subject. So the platform can show a task board and it can show a running application, and it cannot draw a single line between them. That line is the entire point of the request this ADR answers.

The two readers that do exist disagree, which is its own defect. The extension matches `/\bT(\d{1,6})\b/` on the subject, falls back to a segment-bounded ref in the branch name, and numerically normalizes `T001 | T01 | T1 → T1` (`apps/vscode/src/git/taskRefs.ts`). The cloud matches `\bT\d{3}\b` and compares `feature_tag.split(" ")[0]` textually (`apps/cloud/app/integrations/github.py:74`). A project numbering its tasks `T12` closes tasks correctly from the editor and produces no PR linkage at all.

**No progress signal is a product signal.** `ProgressRollup.tsx` derives percentages from task statuses and reads no deployment data. A stakeholder sees "7 of 12 tasks" and, in a different tab, "live". Whether those seven tasks are the ones in the live build is not expressible.

### Why the answer is not a mock

The obvious cheap version of this feature is to generate a clickable prototype from the spec. It is cheap because it is disconnected, and it is disconnected in the one way that matters: it drifts. The spec says one thing, the implementation does another, and the mock keeps showing the spec. A stakeholder who reviews a mock is reviewing the plan a second time, not the product. ADR 0021 already chose the harder and correct thing — show the real build — and this ADR extends that choice rather than hedging it.

---

## Decision

**1. A Deployment Template declares a `delivery_kind`, and delivery kind — not stack — decides how the platform presents a build.** `stack` stays a display string that dispatches nothing, as ADR 0021 requires. The new discriminator takes one of five values:

- `embedded_url` — the deliverable is a web page the platform frames. Today's `static-r2` behaviour, unchanged.
- `external_url` — the deliverable is a web page that refuses framing, or is otherwise better opened in its own tab. Already reachable today by measurement (`frame_policy == "deny"`); becomes declarable up front so a template that knows it sets `X-Frame-Options` does not spend a probe and a four-second handshake to discover it.
- `api_console` — the deliverable is an HTTP API. The build publishes an OpenAPI document alongside itself; the platform renders an operation list and a read-only request console against the deployed base URL. An API's preview is its contract plus a way to exercise it, not an iframe of a JSON body.
- `artifact_download` — the deliverable is a file a person installs: a desktop installer, an Android APK, a signed `.app` archive. CI publishes it; the platform lists versions and hands out links.
- `store_build` — the deliverable reaches its audience through a distribution service the platform does not own: TestFlight, a Play internal track. CI submits; the platform records the build number and the invitation link, and can never itself serve the binary.

`embeddable` remains, and remains *measured* rather than declared, exactly as ADR 0021 decided — the declaration narrows what the platform attempts, the probe decides what it does.

**2. Every delivery kind reuses the existing `Deployment` row and the existing webhook. No delivery kind introduces an inbound channel.** This is the load-bearing constraint and the reason the generalization is affordable. A mobile CI job opens a GitHub deployment against `environment: preview` exactly as the static template does, and reports its result the same way. What differs is the payload it points at:

- `artifact_download` and `store_build` publish a **build manifest** — a small JSON document listing each downloadable asset with its platform, architecture, size, checksum and, for store builds, the external invitation URL — and report the manifest's URL as `environment_url`. The cloud fetches and validates that manifest with the same guards it already applies to a preview URL, and stores the parsed result in a single new nullable `assets` column on `pz_deployments`. No per-template column, no per-template route.
- For the platform-owned R2 provider, artifacts are written by CI to `previews/<project_id>/builds/<commit_sha>/` in the workspace's existing preview bucket, under the same minted, bucket-scoped credential that already exists. The prefix check in `_trusted_environment_url` (`apps/cloud/app/api/github.py:235`) extends to cover it unchanged in spirit: a platform-minted URL that does not sit under the platform's own prefix is discarded.

The cloud stores a manifest, a state and a set of URLs. It does not fetch, rehost, sign, or serve a binary, and it does not proxy an API console's requests — the browser calls the deployed API directly, as it already calls the deployed site directly.

**3. The cloud reads task refs from `push` events and records attribution. It does not write task status.** `_handle_push` gains a second responsibility beside RAG indexing: for every commit in the delivery, extract task refs from the subject and upsert the idempotent `Artifact(task_id, commit_sha, kind="code")` row that already exists for exactly this purpose. Status stays where ADR 0022 put it — authored by the client that observed the publication — because the cloud cannot distinguish "implemented" from "pushed" and should not guess. What the cloud gains is the ability to answer *which tasks are in this build*, for repositories whose developers never install the extension, and for commits that arrive through a merge the extension never saw.

The ref reader must be **one rule expressed twice, not two rules**. `apps/vscode/src/git/taskRefs.ts` is the reference implementation: `T` followed by one to six digits, numerically normalized, revert subjects yielding nothing, a collision between two tasks normalizing to the same ref blocking attribution rather than guessing. The cloud's `_TASK_REF_RE` and its textual `feature_tag` compare are replaced by a port of it, and the port is unit-tested against the same cases. This also repairs the existing PR-linkage defect as a side effect.

**4. A build names its tasks, and the association is stored, not recomputed.** When a deployment reaches a terminal state, the cloud resolves the task set for that build — the tasks whose attribution artifacts fall in the range between this build's commit and the previous successful build's commit — and persists it as `pz_deployment_tasks(deployment_id, task_id)`. Storing it rather than deriving it on read is deliberate: a force-push, a task reassignment or a later edit must not silently rewrite the history of what a stakeholder reviewed last Tuesday.

**5. The Preview tab answers "what changed", and the Progress tab answers "is it live".** The Preview panel gains a *What's in this build* list above the embed: the tasks this build closed, in the platform's own vocabulary, with a version label and a relative time. The Progress rollup gains a per-requirement build indicator, so "7 of 12 tasks" becomes "7 of 12 tasks, 5 of them in the version you can open". A stakeholder who wants to say something about what they see opens a Discussion thread bound to the task, through the discussion surface that already exists — feedback lands on the unit of work, not on a free-floating comment stream.

**6. No Git vocabulary reaches a business user.** The Preview tab may not show a SHA, a branch, a workflow name or a run URL to a member. It shows a version ordinal, a time, a task list and a state. The build log link, the commit and the run URL stay — they are how a Tech Lead diagnoses a red build — behind the same admin gate that already governs the Planner's authoring stages. This is a rule about the surface, not a preference about copy: the moment a member has to understand a merge to interpret the preview, the feature has failed its stated purpose.

**7. Reconciliation ships with this ADR rather than after it.** ADR 0021 knowingly deferred it: the webhook is the only status channel, it is best-effort, and a lost delivery leaves a preview reading "building" forever. One template and a handful of pilot projects could absorb that. Five delivery kinds, mobile builds that take twenty minutes, and a stakeholder who has been told to check the preview cannot. A periodic sweep reconciles any non-terminal deployment older than a threshold against the GitHub deployments and workflow-runs APIs using the workspace PAT already resolved by `github_auth.resolve_token`, and closes it out. This is an inbound *poll*, not an inbound callback, and so does not breach ADR 0021's decision 3.

**8. What the platform still refuses.** No cloud-side build runner. No proxy or rehost of application traffic, including a reverse proxy that would exist only to strip a framing header — ADR 0021 rejected that explicitly and it stays rejected. No per-template route, no per-template DB column, no second inbound authentication mechanism. No platform-operated device emulator: if streamed mobile preview is ever wanted, it is a third-party service embedded as an iframe with the cloud outside the data path, and it is its own ADR with its own cost and data-residency argument.

---

## How this answers the nine questions

**How a project defines its preview environment.** It selects a Deployment Template during tech review, in the Planner, exactly as today (`DeploymentTemplatePanel.tsx`). The template carries the scaffold, the workflow, the secret and variable contract, and now the delivery kind. The selection freezes at `repo_created`; changing it afterwards is a re-provision, not an edit.

**How Git events update the preview.** They do not update it — the project's own CI does, and the cloud observes. `push` to the default branch triggers the seeded workflow; the workflow opens a GitHub deployment against `environment: preview` before it does any work, so the platform can show "building" immediately, and posts a terminal status when it finishes. `workflow_run` catches builds that die before opening a deployment. `push` additionally now yields task attribution. All four events arrive on the one per-repo hook with the one HMAC secret.

**How builds associate with tasks, commits and milestones.** `Deployment.commit_sha` gives the commit. `Artifact(task_id, commit_sha)` gives commit→task, now written from both the editor and the server. `pz_deployment_tasks` freezes the build→task set at terminal state. Requirements roll up from tasks through `spec_documents`, which is how the Progress tab already computes percentages — so a milestone view is a join away rather than a new model.

**How a user launches the latest version.** From the Preview tab: an embed for `embedded_url`, a launch button for `external_url`, an operation console for `api_console`, a version list with per-platform download buttons for `artifact_download`, and an invitation link plus build number for `store_build`. One tab, five renderings, one endpoint.

**How it works per project type.** Web → embedded or external URL. Backend/API → `api_console`, with the OpenAPI document as the reviewable artifact and the deployed base URL as the thing exercised. Desktop → `artifact_download`, macOS and Windows installers published per build; the repo's own release workflow is the model, since `apps/desktop` already builds exactly this way in a platform matrix. Android → `artifact_download` with an APK, or `store_build` on an internal track. iOS → `store_build` only; there is no legitimate way to hand an unsigned iOS build to a stakeholder from a web page, and pretending otherwise would be the mock problem in a new costume.

**Embedded, external, streamed or distributed.** Embedded when the application permits it and the platform has measured that it does. External when it does not. Distributed for anything installable. Streamed: not built, not in this ADR.

**Authentication, secrets, sandboxing, boundaries.** Unchanged in mechanism, extended in reach. Provider credentials stay Fernet-encrypted in the server secret store and are written to the repository as Actions secrets exactly once, at repo creation; the platform-owned R2 credential stays minted per workspace and bucket-scoped, and the account-wide `DEPLOY_R2_API_TOKEN` is still used only to mint and never sealed into a repo. Store credentials (Apple, Google) follow the workspace-PAT pattern: workspace-provided, verified where verification is possible, encrypted at rest, never platform-owned. The preview iframe keeps its current sandbox and `referrerPolicy`. `environment_url` and every manifest URL remain attacker-influenced input behind a signed webhook and stay subject to the scheme check, the SSRF guard on the probe path, and the platform-prefix check. A build manifest is parsed with a size cap and a strict schema, and a manifest that fails validation degrades the deployment to a link rather than being partially trusted. Anyone with write access to a project repo can still use that repo's deploy credential — bounded by scope, default-branch-only deploys and build-only PR checks, as ADR 0021 recorded, and not newly mitigated here.

**Lifecycle, versioning, rollback, cleanup.** A deployment row per build, newest current, `url` last-known-good. Versioning is the ordered deployment history the API already returns as `recent[]` and the UI has never rendered. Rollback is the project's own CI re-running against an earlier ref — the platform surfaces the action for an admin and records the result; it does not itself move bytes. Cleanup is a retention policy on the R2 build prefix, enforced by the platform's own scheduled job against the workspace bucket it minted, since nothing else will ever delete those objects.

**How a business user uses this without understanding CI.** They open the project, click Preview, and see either the application or a plain sentence about why they cannot yet. They read a version label and a list of features in the words the spec used. They click a task to comment. Decision 6 makes that a constraint on the surface rather than an aspiration.

---

## Phased plan

**Phase 1 — prove the contract (no new delivery kinds).** Add `delivery_kind` to `DeploymentTemplate`, defaulting every existing path to `embedded_url` so behaviour is byte-identical. Ship the second template ADR 0021 asked for — a containerized Node/Next.js service on a customer-owned provider — which exercises `provider_credential_kind`, `url_kind == "provider"` and the customer-credential path that `static-r2` never touches. Ship the reconciliation sweep. Ship the `recent[]` history UI. Nothing in the task graph changes.

**Phase 2 — attribution.** Port `taskRefs.ts` to the cloud and replace `_TASK_REF_RE` and the textual `feature_tag` compare, with tests mirroring the extension's. Extend `_handle_push` to upsert attribution artifacts. Add `pz_deployment_tasks` and freeze the set at terminal state. Render *What's in this build* in the Preview tab and the build indicator in Progress. This is the phase that delivers the request's core ask, and it depends on nothing in Phase 3.

**Phase 3 — non-web delivery.** Add the `assets` column and the build-manifest schema, validator and fetch guard. Ship `artifact_download` with a desktop template (the repo's own `desktop-build.yml` matrix is the working reference) and an Android template. Ship `api_console` with a FastAPI or Express template that publishes its OpenAPI document. Extend `PreviewPanel` to the five renderings.

**Phase 4 — distribution and lifecycle.** Ship `store_build` with TestFlight and Play internal-track templates and the workspace-owned store credential. Ship the retention job and the admin-invoked redeploy/rollback action.

**Phase 5 — feedback loop.** Bind Discussion threads to tasks from the Preview surface, and surface unresolved preview feedback on the task board.

Phases 1 and 2 are independent and can run in parallel. Phase 3 depends on Phase 1's discriminator. Phase 5 depends on Phase 2's attribution and on nothing else.

---

## Open questions

The manifest fetch is a cloud-initiated outbound request to a URL derived from webhook input. It is guarded by the same SSRF checks as the frame probe, but it also *parses* what it retrieves, which the probe does not — whether that warrants an egress proxy before Phase 3 ships is a decision this ADR raises and does not make.

Whether `store_build` is worth its credential-custody cost, or whether iOS review should simply be an out-of-platform TestFlight link a Tech Lead pastes once, should be settled before Phase 4 rather than during it.

Whether a preview for an application behind its own authentication is in scope at all remains open, as ADR 0021 left it. The practical answer — a seeded demo account exposed as a template variable — is cheap and is also a standing credential in a preview environment, which is a trade this ADR does not make on its own authority.
