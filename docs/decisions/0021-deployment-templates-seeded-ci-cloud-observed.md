# ADR 0021 — Deployment is a repo-seeded template executed by the project's own CI; the cloud observes and embeds it

**Date:** 2026-08-19 · **Status:** Proposed · **Deciders:** product + engineering

**Prompted by the decision:** *a Tech Lead must be able to say how a project is built and deployed, as part of the technical plan — and a business user must be able to open the running application from the workspace without touching a development machine.*

**Extends:** [ADR 0017](0017-cloud-creates-project-repo-at-tech-review-exit.md) — the `tech_review → repo_created` transition gains a second class of seeded content and a second commit-time contract. Its timing, its ordering discipline and its retry semantics are unchanged in substance; the mechanism by which files reach the repo changes (see *One commit, not N files*). [ADR 0015](0015-desktop-requires-workspace-membership.md) — the cloud-projected roster gains one field. [ADR 0011](0011-cloud-workspace-rag-assistant.md) and [ADR 0010](0010-sync-model.md) §5 — a third class of persisted credential, the provider deploy token, joins the model keys and the GitHub PAT.

**Closes:** [ADR 0019](0019-desktop-as-vscode-extension.md)'s open question about whether the deployed preview environment creates a local-side requirement. **Specifies:** [ADR 0020](0020-cloud-is-the-source-of-truth.md)'s assertion that "business stakeholders are served by the cloud, including the deployed preview environment where they review progress without touching a development machine" — an assertion that has, until now, had no mechanism anywhere in this repository.

**Does not decide** how a project is *hosted in production*, how it is billed, or how it handles authentication. The preview environment this ADR defines is a review surface, not an operations story.

---

## Context

### The gap between what the record promises and what exists

ADR 0020 lists six responsibilities for the developer-facing client and then, in a single sentence, hands the business stakeholder to the cloud: they are served there, "including the deployed preview environment where they review progress without touching a development machine." That sentence is the entire specification. There is no deployed preview environment. There is no code path that builds anything, no field that records a URL, and no surface that shows one. Grepping `apps/engine`, `apps/vscode` and `apps/cloud` for `deploy`, `preview_url`, `vercel`, `netlify` or `docker` returns hosting documentation, a Vercel URL in a comment, and Spec Kit template prose. Nothing else.

ADR 0019 noticed the hole from the other side and recorded it as an open question — "whether the deployed preview environment creates any local-side requirement not yet visible, since it is described as wholly cloud-owned." That question has stayed open because nobody could answer it without first deciding what the preview environment *is*.

The practical consequence is that the platform's central promise is only half kept. A business user can read a spec, watch task cards move across a board, and read a commit message. They cannot see the thing being built. Progress is reported to them rather than shown, which is exactly the arrangement the 3S flow exists to replace.

### The gap in the technical plan

The Tech Lead has the same problem from the other direction. The constitution, the spec, the architecture plan and the task list are all captured, versioned and seeded into the repository. How the project is built and deployed is not captured anywhere. It lives in a Tech Lead's head, or in a workflow file somebody wrote later, in a repository most of the workspace never opens. A plan that specifies the architecture but not how it ships is not a complete technical plan.

### Why one shape will not fit every project

The obvious mistake here is to pick a stack. A marketing site, an internal API, a full-stack product and a throwaway prototype have nothing in common at the deployment layer, and a platform that assumes one of them is useless for the other three. Whatever this ADR decides must be a *contract* that many deployment shapes satisfy, not a deployment shape that many projects are forced into. The Policy Scope feature already solved a structurally identical problem — a registry of built-in templates, selected per project, persisted on the project row, injected into generation and rendered into the seeded repository — and it is the pattern to follow rather than reinvent.

---

## Decision

**1. A project selects exactly one Deployment Template during tech review, and the template is part of the technical plan.** The selection is stored on the project as `deployment_config`, alongside `policy_scope`, and it **freezes at `repo_created`** exactly as policy scope does. At the `tech_review → repo_created` transition ADR 0017 already owns, the cloud seeds a runnable application scaffold, a CI/CD workflow, an env/secret contract and a `docs/deployment.md` into the new repository, in the same commit as the AI-context documents. The preview URL is therefore live from the first commit, before a single implementation task has run — which is what makes incremental progress visible rather than only final delivery.

**2. Execution lives in the project's own repository, never in the cloud.** GitHub Actions builds and deploys, using a workspace-owned provider credential the cloud writes as a repository secret. The cloud runs no builder, stores no build artifact, and proxies no application traffic. This is ADR 0009's BYO stance applied one layer down: PromptConnext orchestrates the CI the customer already has, exactly as it orchestrates the coding agent the customer already pays for. The workflow file is a normal file in a normal repository; the repository owner may edit it, and nothing here overwrites it. That includes a workflow the repository already had before the platform ever saw it: when a project adopts an imported repository whose default branch already carries a file at the template's workflow path, repository creation refuses with `deploy_workflow_conflict` rather than skipping the workflow (which would leave a project that looks deployable and is not) or merging into it (which ADR 0024 forbids). The rest of the seed follows [ADR 0017's 2026-09-22 amendment](0017-cloud-creates-project-repo-at-tech-review-exit.md#amendment--2026-09-22-an-adopted-repository-is-never-overwritten): existing scaffold files are skipped one at a time, and the derived documents, `docs/deployment.md` included, go under `docs/promptzone/`.

**3. Status and the resulting URL return over the existing signed per-repo webhook.** The seeded workflow creates a GitHub Deployment carrying `environment_url`; the cloud subscribes to `deployment_status` and `workflow_run` on the same hook that already carries `push` and `pull_request`, verified by the same per-repo HMAC secret in `pz_repo_webhooks`. **No second inbound authentication mechanism is introduced,** and no second secret per repository.

**4. The preview is an embed with a link fallback, and embeddability is measured rather than guessed.** The web app frames the deployed application in a Preview tab, visible to every project member with no role gate, and degrades to a prominent link card when framing cannot be confirmed. A browser cannot read a cross-origin response header, cannot read the frame's document, and receives an `onload` event even for a blocked frame — so client-side detection alone is not capable of answering the question. The cloud probes the deployed URL's headers server-side, and the scaffold posts a one-line `postMessage` handshake that proves the frame actually rendered. Both are recorded; neither is inferred.

**5. Templates are additive by construction.** A new template is one registry entry plus one directory of files, and optionally one provider entry. It cannot introduce a new inbound callback, a cloud-side build step, a per-template route, or a per-template database column. The registry mirrors `app/policies/registry.py` down to the `ws:<uuid>` namespacing reserved for future workspace-owned templates, so org-authored templates land later without the shape changing. **If a proposed template needs something the contract cannot express, that is an ADR, not a template.**

---

## Boundaries

The value of this decision is mostly in where the lines fall, so they are worth stating plainly. Five zones, four crossings, and nothing owns two of them.

**Planning** stays exactly as it is: stage documents and policy scope, authored in the cloud, untouched by this ADR.

**Deployment configuration** is cloud-owned and splits by scope. At the workspace level an admin connects a provider credential, stored in `Workspace.integration_config["<provider>"]` in the same shape and with the same Fernet encryption as the GitHub PAT. At the project level the Tech Lead selects a template, stored in `deployment_config` and frozen at `repo_created`.

**The first crossing** happens once, at `create-repository`: the cloud creates the repository, writes the Actions secrets and variables, registers the webhook, and lands one seed commit. After that moment the cloud never writes to the repository again except through an explicit, admin-invoked re-provision.

**CI/CD** belongs to the customer's repository. It builds, it deploys, and it posts a GitHub Deployment carrying the environment URL.

**The second crossing** is per-deploy and signed: `workflow_run` and `deployment_status` arrive over the existing webhook.

**The deployed application** belongs to the provider, which owns the URL and serves the browser **directly**. That directness is the third crossing and it is what keeps this cheap; a design in which application traffic flows through `apps/cloud` would destroy it, and is rejected below.

**The preview** belongs to the web app: presentation only, reading one status endpoint.

**The fourth crossing** is free: `deployment_url` rides the cloud-authoritative roster projection ADR 0015 already established, which is how `lifecycle_status` and `repo_url` already reach the engine.

So: the cloud owns **configuration and observation**, GitHub owns **execution**, the provider owns **the URL and the traffic**, and the web app owns **presentation**.

---

## One commit, not N files

ADR 0017's seeding loop writes each file with a separate Contents-API call — a read for the blob SHA and a write — producing one commit per file. At eight derived documents that is roughly sixteen round-trips and eight commits, which is unremarkable. A runnable application scaffold is fifteen to forty files. The same loop would mean thirty to eighty sequential round-trips inside a single HTTP request, thirty to ninety seconds of wall time against proxies that commonly cut at sixty, and forty junk commits in the repository's history before its first real one. Worse, a failure at file thirty of forty leaves a repository that looks seeded and has no workflow.

Per-file seeding does not survive this feature, so **the seed becomes a single commit built through the Git Data API**: blobs (created concurrently, which is what keeps forty files inside a few seconds), then a tree on top of the base tree, then a commit, then one non-forced ref update. Only that last step is observable. A crash anywhere before it leaves dangling blobs GitHub garbage-collects and a branch that never moved — so the partial-seed window collapses from *N files* to *one atomic reference update*, and the existing adopt-on-retry path works perfectly because a retry simply rebuilds everything.

This is worth noting as a strict improvement to ADR 0017 rather than a cost of this one. It turns the repo-creation panel's existing promise — try again, it will pick up where it left off — from a hope into a fact, and it would be the right change even if no scaffold were ever seeded.

Two steps of `create_repository` also move earlier, and both reorderings are load-bearing. **Actions secrets must be written before the seed commit,** because that commit fires `on: push` immediately and a workflow that starts before its secrets exist fails its first run for no reason. **The webhook must be registered before the seed commit,** because otherwise the first `deployment_status` can arrive before the `pz_repo_webhooks` binding row exists and is silently dropped as an unknown repository — losing precisely the first deploy's URL. Registration does not depend on repository content, so moving it costs nothing and stays best-effort.

---

## Consequences

- **Positive:** the platform's stated promise to business users is kept for the first time — a live application, discoverable from the workspace, updating as tasks land. The technical plan gains the one section it was missing. The cloud takes on no compute, no hosting, no build artifacts and no traffic. And ADR 0017's partial-seed window shrinks from proportional-to-file-count to a single atomic operation.

- **The GitHub PAT scope requirement grows, and this will bite before anything else does.** The workspace PAT now needs **Secrets: write** and **Variables: write** in addition to Contents, Administration and Webhooks. Fine-grained PATs expose no permission-introspection endpoint, so the connection-time verification cannot detect the gap — it surfaces at repo creation, in front of a Tech Lead, on a token that has worked fine for months. **Every existing workspace's PAT will fail.** The failure needs its own error code, its own message, and a warning on the workspace settings page shipped *with* the feature rather than after it.

- **Anyone with write access to a project repository can use its deploy credential.** A repository secret is readable by any workflow anyone with push access can author; GitHub's log masking is a convenience, not a control. This is inherent to decision 2 and cannot be mitigated away — only bounded. Templates therefore use the narrowest provider scope available, deploys run only on pushes to the default branch, pull-request checks are build-only with no secret access and never use `pull_request_target`, and rotation is a first-class operation.

- **Platform-owned credentials get stricter treatment than customer-owned ones,** because a leak of ours is a leak across tenants rather than within one. Where the platform is itself the provider, the cloud holds the account-wide credential and mints a per-workspace, resource-scoped credential at repo-creation time; only the minted one is sealed into a repository. The account-wide token never leaves the cloud. The honest end state is GitHub OIDC exchanged for short-lived presigned credentials, eliminating long-lived secrets in customer repositories entirely; that is recorded as the intended direction, not built here.

- **`Workspace.integration_config` is member-readable through RLS,** so the encrypted `secret_ref` is visible to members. This is a pre-existing accepted posture from the GitHub PAT, and this ADR multiplies it from one credential to several. The ciphertext is inert without `RAG_KEY_ENCRYPTION_KEY`, which is not in the database, and no route returns the field raw — but the multiplication is real and is recorded here rather than discovered later.

- **The webhook is the only status channel, and it is best-effort by construction.** ADR 0017 made registration failure non-fatal on purpose: a repository that exists and is seeded should not be stranded because a hook did not register. The cost, under this ADR, is that a deploy whose delivery never arrives looks permanently "building". Mitigated in the interface — the run link is always offered, and the poller bounds *stuck* rather than *slow* — and not mitigated in the backend. A reconciliation pass against the repository's deployments is the correct fix and is deferred deliberately.

- **`create_repository` now does a great deal in one non-transactional request:** create, secrets, hook, commit, two database writes and a lifecycle flip. The single-commit change shrinks the worst window substantially, and one benign new partial state appears — secrets written, commit failed, which a retry overwrites.

- **The preview cannot help with an application behind authentication.** Every template produces a public URL, and a business user reviewing a real product will eventually reach something that requires a login. That is out of scope and is stated rather than papered over.

- **A workflow's reported `environment_url` is attacker-chosen input, and is treated as such.** The webhook delivery is HMAC-verified, but the URL inside it is written by the workflow, which anyone with push access to the project repository can edit. Three consequences follow. Anything that is not an absolute `http(s)` URL is refused on the *storage* path, before it is ever recorded — this value is rendered by the web app as an `<a href>` and an `<iframe src>`, so a `javascript:` URL reaching the database would be script execution in the workspace's own origin for every member who opened the project, delivered through a signed webhook. That check is deliberately separate from the probe guard below, which decides only whether the cloud may *fetch* a URL and never runs on the storage path at all. The server-side header probe resolves the hostname and refuses any address that is loopback, private, link-local, reserved or multicast, and follows no redirects — without that it is a request-forgery primitive into the cloud's own network, answered by a three-valued oracle. And for a template whose URL the platform itself mints, a reported URL outside the provisioned prefix is discarded rather than recorded, so a repository pusher cannot choose what the workspace's Preview tab embeds or what its project list links to. Both refusals degrade to the link card and a logged warning rather than to an error. The residual risk is DNS rebinding between the resolution and the connection; closing it properly means an egress proxy enforcing the rule at the network layer, which is the production recommendation rather than something this code can do alone.

- **Each provider is a billing relationship the customer owns.** PromptConnext must never appear to be the biller, and the interface should not imply it is.

---

## What this closes and what it specifies

**ADR 0019's open question is answered: there is no local-side requirement, and it can be marked resolved rather than merely addressed.** The engine's roster is cloud-authoritative and persisted as JSON in `app_state`, so carrying a deployment URL down to it costs no schema change and no forward migration. The graph sync snapshot carries no project-level fields in either direction, so deployment state cannot and should not ride it. The VS Code extension needs nothing at all: its three upward writes are untouched and no fourth is introduced, preserving ADR 0020's decision 2. One deliberate restraint belongs on the record — `docs/deployment.md` is **not** added to the three files the extension reads as coding rules. It is operational documentation, and widening that list would change what every developer's AI assistant reads.

**ADR 0020's line about the preview environment is now specified** rather than asserted: the artifact is the application the project's own CI deployed, the Tech Lead configures it during tech review, the cloud learns of it over the existing signed webhook, and the business user sees it embedded in a Preview tab and flagged on the workspace project list.

---

## Alternatives rejected

- **Cloud-side build and deploy runners.** The cloud builds each project and hosts the preview itself. This gives total control over URLs, embedding and lifecycle — and reintroduces exactly the compute, sandboxing, quota, cost and abuse surface ADR 0009 refused, in order to provide a capability every project repository already has for free. The cloud is additionally a single instance with in-process state today; adding build workloads to it is not a small step.

- **Provider-native GitHub Apps instead of a seeded workflow.** Vercel, Cloudflare and Northflank each offer a GitHub integration that deploys on push with no workflow file. Each is a different installation flow with a different status shape, installed by the customer rather than by us, which makes a single template contract impossible and leaves the platform unable to explain what will happen before it happens. Worth keeping as a future *addition* rather than a replacement: they emit `deployment_status` too, and the deployment record's external key already accommodates an identifier the platform did not mint.

- **A seeded bearer token and a custom callback endpoint.** The workflow POSTs its status directly to the cloud. This means a second inbound authentication mechanism and a second secret per repository, to carry data that `deployment_status` already carries over a channel already built, already signed and already attributable to exactly one project.

- **Modelling a deployment as a graph entity or an artifact.** The local artifact kind is constrained to code, PR and doc, and the sync snapshot carries no project-level fields — so this route forces a local schema migration and a fourth field-authority question in exchange for nothing. Deployment state is project metadata written by one authority, and it rides the roster projection ADR 0015 already established.

- **A cloud-hosted preview proxy** that re-serves the application to sidestep framing headers. It would make embedding unconditional, and it would make the cloud a traffic path for customer applications, with the authentication, cost, latency and liability that implies. It also defeats the direct provider-to-browser crossing that keeps this design cheap.

- **Per-file seeding of the scaffold**, retaining ADR 0017's loop unchanged. Rejected on the round-trip count, the commit noise, and a partial-seed window proportional to scaffold size.

- **Making the template a post-repository setting** rather than a planning input. Simpler to build, and it breaks decision 1's core property: the preview is live from the first commit only if the pipeline is in the first commit.

- **Letting the template stay editable after `repo_created`.** More flexible on its face, but the repository already contains the previous scaffold, and switching stacks leaves dead files and a half-migrated repository the cloud cannot clean up. The template freezes, and changing it is an explicit re-provision operation with its own semantics.

---

## Notes for the implementing agent

- **Build the zero-third-party-account template first.** A template whose provider is the platform itself proves the entire loop — selection, seeding, secrets, webhook, status, URL, preview — without anyone signing up for anything, and it is the only way to verify this feature end to end in a single sitting.

- **Ship the second template before considering the contract proven.** If adding a second provider touches anything beyond one registry entry, one directory and one provider entry, decision 5 has already failed and that is the signal to stop and redesign, not to add a special case.

- **Do not build a progress bar.** A deploy's duration is unknown to the platform. The reindex panel's docblock already states the rule this feature must inherit: every number shown comes from the server, and an animated estimate is worse than an honest "still building" plus a link to the run.

- **A failed deploy must not blank a working preview.** Current state and last-known-good URL are different questions and are stored as different fields.

- **The webhook event list must be a single named constant.** It is currently inline in one call site, and it is about to have two consumers and a repair path.

- **Existing repositories need a repair path, and the obvious one does not work.** Hook registration swallows the "already exists" response as success — the behaviour that makes retries safe is the behaviour that makes re-registration a no-op — and repo creation returns early for projects already at `repo_created`, so the code path is never reached at all. An explicit repair operation that lists hooks and patches the event list is the only migration route, and it is the one thing here that must ship in the first phase rather than a later one.

- **Correct the two pieces of adjacent drift while in the area:** the GitHub client protocol declares one fewer parameter than its implementations take, and migration 0025's header names a runner path that no longer exists.
