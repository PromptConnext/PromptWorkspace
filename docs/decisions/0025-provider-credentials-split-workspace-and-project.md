# ADR 0025 — A deploy credential has two halves: the account belongs to the workspace, the target belongs to the project

**Date:** 2026-09-06 · **Status:** Accepted · **Deciders:** product + engineering

**Prompted by the defect:** *a workspace has many projects; a Vercel project holds one production deployment. Storing the Vercel project id on the workspace credential made every project in a workspace deploy over the top of the last one, and told the second Tech Lead to go fix it in workspace settings.*

**Amends:** [ADR 0021](0021-deployment-templates-seeded-ci-cloud-observed.md) — `DeploymentConfig` gains a second field, and `DeployProvider.fields` gain a scope. The freeze at `repo_created`, the secret/variable contract, the single webhook and the "adding a template is a directory and two registry entries" property are unchanged. [ADR 0023](0023-development-preview-for-every-project-type.md) — this is Phase 1 work, and it repairs a limitation that ADR's `next-vercel` amendment recorded as structural.

**Does not decide** whether the platform should create provider-side projects on a workspace's behalf. That question is raised at the end and deliberately left open.

---

## Context

ADR 0021 gave a deployment provider one shape: a workspace admin connects a token, non-secret identifiers sit beside it in `Workspace.integration_config`, and `create_repository` seals the lot into a project's repository as Actions secrets and variables. `fly-node` shipped that way with `app_name` and `org_slug`; `next-vercel` copied it with `project_id` and `org_id`.

The shape is wrong, and the two providers disguise it identically. `org_slug` and `org_id` genuinely describe the account the token belongs to — one Fly organisation, one Vercel team, one token, typed once. `app_name` and `project_id` do not. They name a provider-side resource that holds exactly one running deployment. A workspace with three projects needs three of them.

Because both sat on the workspace credential, the second project created in a workspace inherited the first project's Vercel project and deployed over it. Nothing failed loudly. The preview URL for project B would quietly start serving project A's code, or the reverse, depending on which pushed last — and the platform would report both as live, because from the webhook's point of view both were.

The user-visible symptom was smaller and stranger than the bug: the Planner's picker told a Tech Lead that Vercel "must be connected in workspace settings", and workspace settings asked for a Vercel *project* id — a per-project answer demanded on a page that governs every project at once.

---

## Decision

**1. `CredentialField` carries a scope, and the scope decides which surface asks for it.** `scope="workspace"` is the default and means what ADR 0021 assumed: the account the token reaches, typed once in workspace settings. `scope="project"` means the field names the provider-side resource one PromptConnext project deploys to, and it is asked for in the Planner beside the template selection.

`app_name` (Fly) and `project_id` (Vercel) become project-scoped. Nothing else does. A platform-owned provider has no project-scoped fields at all, because there is no provider-side project — a build is a prefix inside a bucket the platform already minted, and the prefix is derived from the project id the platform already knows.

**2. Project-scoped values live in `DeploymentConfig.provider_values` and freeze with the template.** `pz_projects.deployment_config` is already a `jsonb` column, so this is additive and needs no migration. Freezing is not a new rule but the existing one applied honestly: these values are part of what the seeded pipeline was built against, exactly as `template_id` is, and letting them drift after `repo_created` would leave a repository whose recorded target and actual target disagree.

**3. The merge is restricted to declared project-scoped keys, at both ends.** The PATCH endpoint keeps only keys the provider declares `scope="project"` and silently drops the rest; `_resolve_deployment_provisioning` layers those same declared keys over the resolved workspace credential before any secret or variable is computed.

This is a security property, not tidiness. `provider_values` is admin-supplied input that ends up merged into the dict from which repository *secrets* are read. An unfiltered merge would let a project admin write `{"token": "..."}` and choose what gets sealed into a repository as the deploy credential. Filtering by declaration is what makes the merge safe, and it is why the filter appears twice rather than once — the stored value is already narrow, and the read narrows it again.

**4. Verification splits with the credential.** `DeployProvider.verify` now answers only "does this token reach this account", because at connect time there is no project to check. A new `DeployProvider.verify_project` answers "does the named project exist under it", and runs where a human named it — the deployment-config PATCH — because that is the only place the answer is actionable. Skipped when the workspace has no credential yet: selecting a template before connecting the provider is a legitimate order of operations, and repository creation remains the hard gate.

Vercel's connect check therefore moves from `GET /v9/projects/{id}` to a listing under the team, and `deploy_project_not_found` moves from the workspace form to the project form.

**5. A missing project-scoped value fails repository creation with its own code.** `deployment_project_values_missing`, not `deployment_provider_incomplete`. The distinction is the whole point of this ADR: one is fixed by reconnecting a workspace credential, the other by naming a project on that project's own deployment template, and telling a Tech Lead the wrong one sends them to the wrong page — which is the defect this ADR exists to repair.

---

## Consequences

Fly gains the same fix without a Fly-specific line of code, which is the test of whether the abstraction is the right one. Its `app_name` becomes project-scoped and its notes stop implying one application per workspace.

A workspace connected before this change keeps its stored `app_name` or `project_id` in `integration_config`, where nothing now reads it. It is inert rather than harmful: `_resolve_deployment_provisioning` overlays the project's declared keys and refuses when they are absent, so an old workspace value cannot silently become a project's deploy target. Projects created before this change and not yet at `repo_created` need their provider project named once in the Planner; projects already at `repo_created` are frozen and unaffected.

The picker's warning stops being a dead end. It now names what is missing on each side — the workspace's account, this project's project — instead of pointing at one page for both.

---

## Open question

The platform already creates a GitHub repository per project and mints an R2 bucket per workspace, so "create the provider-side project too" is a smaller step than it sounds, and it would remove this ADR's only manual field. It was not taken here because it means the platform creating a billable resource in a customer's account without being asked, and because the token scope it needs cannot be verified in advance for a fine-grained credential — the same blind spot ADR 0017's amendment records for GitHub PATs. If it is ever built, it writes into `provider_values` and needs nothing else from this decision.
