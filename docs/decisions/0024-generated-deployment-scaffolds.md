# ADR 0024 — A model may author a project's application scaffold, never its deployment pipeline

**Date:** 2026-09-06 · **Status:** Proposed · **Deciders:** product + engineering

**Prompted by the question:** *most AI-generated projects arrive as one of a handful of stacks, and Typhoon already writes each project's architecture and technical plan — so why maintain a Deployment Template per stack at all, instead of generating the deployment setup from the plan?*

**Extends:** [ADR 0021](0021-deployment-templates-seeded-ci-cloud-observed.md) — the Deployment Template contract, its freeze semantics and its "adding a template is a directory and two registry entries" property. [ADR 0023](0023-development-preview-for-every-project-type.md) — Phase 1's requirement that the contract be proven by more than one template, and its decision 8 list of what a template may never introduce. [ADR 0013](0013-managed-thai-llm-tier-stage-routing.md) — the managed Typhoon tier is the generator this question proposes to point at repository files.

**Does not decide** which hosting providers get templates, or whether the cloud Planner's stage generator gains any new stage. This ADR decides only what a model may and may not write into a project repository, and records why the obvious version of the idea is worth less than it looks.

---

## Context

Three templates now ship: `static-r2` (platform-owned storage), `fly-node` (a customer-owned provider with a provider-minted URL) and `next-vercel` (the same posture, for the stack most of these projects actually are). ADR 0023's amendment adds a fourth credential posture with GitHub Pages, where the credential belongs to the git host and nobody connects anything.

Each of those is a directory under `app/deployments/templates/`, one `BUILTIN_TEMPLATES` entry and, where a credential exists, one `PROVIDERS` entry. `template_files()` reads the directory off disk, sorted, and `create_repository` commits the result verbatim alongside the derived documents in a single Git Data API commit — after writing the Actions secrets and registering the repository's webhook.

The pressure the question responds to is real. A FastAPI project, a Go service and a Rails app each need their own directory today, and none of them exists. Generating the deployment setup from the plan Typhoon already writes would collapse that work into a prompt. It is the natural thought, and it deserves a written answer rather than a shrug, because the answer is not obvious in either direction.

---

## What the idea is worth, examined

**A generated scaffold is replaced by the first implementation task.** This is the argument that decides the value question, and it is easy to miss. The scaffold exists for exactly one reason: so the preview URL is live from the first commit rather than after the first implementation task (`registry.py`'s own opening paragraph says so). It is a placeholder that proves the pipeline works. The moment an agent picks up task one, the placeholder is rewritten. Generating a *better-informed* placeholder — one that already knows the project is a booking system rather than a generic app — buys a nicer holding page for a few hours of a project's life, and buys nothing at all afterwards.

**Containerization is not the missing piece; the host is.** `fly-node` already ships a Dockerfile. A generated "Dockerized deployment setup" that does not name where the image runs produces no `environment_url`, therefore no `deployment_status` delivery, therefore nothing in the Preview tab — the whole feature is downstream of a URL arriving on the webhook. Naming the host is a product decision with a credential posture attached (Cloud Run, Railway, a customer VPS over SSH and a self-hosted registry are four different postures), and no amount of generation makes that decision for us.

**Template count is driven by hosts, not by stacks.** Once a host is chosen, the workflow that deploys to it is nearly stack-independent: build a container, push it, deploy it, report a GitHub Deployment. Stack variation lives almost entirely inside the Dockerfile, which is the one file a project's own developers are most likely to rewrite anyway. So the directory count this idea proposes to eliminate is smaller than it appears, and it does not grow with the thing that actually varies.

---

## Decision

**1. If a model ever authors repository files, the boundary is the application root.** A model may write files the workflow *builds*. It may never write the files that *deploy* — `.github/**`, the Dockerfile, the secret and variable contract, and `docs/deployment.md` stay authored by this repository, hand-written, per template.

The reason is not stylistic. `create_repository` writes the Actions secrets **before** it commits the scaffold, so any file under `.github/workflows/` is a file with access to the workspace's deploy credential from its first run. The input that would drive generation is a project plan a business user wrote as free text in the Planner. A path from prompt-injectable text to a workflow that reads a deploy secret is a different class of risk from a model writing application code, and it is not mitigated by review, because nobody reviews a seeded workflow — the entire point of seeding is that it is there before anyone looks.

**2. The boundary is enforced by an allowlist at the commit seam, not by the prompt.** Were this built, `DeploymentTemplate` would gain an optional generator, `template_files()` would keep returning the fixed files unchanged, and generated files would be concatenated by `build_deployment_files` behind a path allowlist that *drops* anything outside it. This mirrors the `..`-escape re-check already in `template_files()`, and for the same reason recorded there: a scaffold is committed verbatim into a customer's repository, so a path that escapes its boundary is a real defect and not a cosmetic one. A prompt instruction not to write `.github/**` is not a control.

**3. Determinism and freeze semantics are the cost, and they are stated rather than solved.** `template_files()` sorts its output so the seed commit is deterministic: two projects with the same selection produce the same tree, which is what makes a seeded pipeline reviewable and a template bug reproducible. A generated tree is neither. Separately, `deployment_config` freezes at `repo_created` and re-selecting is a re-provision rather than an edit (ADR 0021); with generation, `template_id` names the generator and not the artifact, so the frozen value no longer identifies what was actually committed. Recording the generated file list on the project row would answer that, and it would be a per-template database column, which ADR 0023 decision 8 forbids. Anyone reviving this should start there.

**4. This is not built now.** Given decision 1's boundary, what remains generable is the placeholder — and per the section above, the placeholder is discarded by the first implementation task. The cheaper answer to the original question is a small number of hand-written host templates. `next-vercel` covers the stack most of these projects are; a generic container template naming one host covers most of the rest. This ADR exists so that the trade is written down and so that a future revival starts from the boundary rather than rediscovering it.

---

## Open questions

Which host a generic container template should target is the decision that actually unblocks the FastAPI, Go and Rails projects this question was really about, and it is not answered here. Cloud Run and Railway are the candidates with the least credential ceremony; a customer VPS over SSH is the one users ask for and the one whose credential posture is worst.

Whether a generated scaffold is worth anything in the narrow case where a project has *no* implementation tasks yet and a stakeholder is looking at the preview during planning is the strongest remaining argument for building this, and it is a question about how projects are actually used rather than one this repository can answer.
