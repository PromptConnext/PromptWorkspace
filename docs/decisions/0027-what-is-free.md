# ADR 0027 — What is free: planning is free and metered, provisioning is paid

**Date:** 2026-09-13 · **Status:** Accepted · **Deciders:** product + engineering

**Prompted by the decision:** *the marketing site sells a free tier whose features describe the desktop application and the local-first graph. [ADR 0019](0019-desktop-as-vscode-extension.md) deletes that product. So what is free now?*

**Depends on:** [ADR 0019](0019-desktop-as-vscode-extension.md) and [ADR 0020](0020-cloud-is-the-source-of-truth.md), both accepted the same day. Implementation is [plan 0022](../plans/0022-positioning-and-pricing.md), which asked for this ADR before its first milestone.

---

## Context

The public pricing page offers two tiers. Free is "the full desktop app, forever", and its five features are the complete 3S workflow, bring-your-own-model, the local-first task graph, external agent orchestration, and local and personal workspaces. Enterprise is contact-sales and adds shared cloud workspaces, single sign-on, role-based access, two-way tracker sync and priority support.

Three of those claims are already false rather than merely about to be. Local and personal workspaces contradict ADR 0015, which made a cloud identity and workspace membership mandatory to reach the product at all. Single sign-on has no implementation anywhere in the cloud or the web app. ClickUp sync cannot work, because the credential and webhook-secret resolvers only ever answer for Jira. The remaining two describe the desktop, which ADR 0019 now deletes.

So the free tier does not describe a product that exists, and after the retirement it will not describe one that ever ships again. Meanwhile the thing the platform actually does — carry a project from a business requirement through a compliance-scoped plan to a provisioned repository and a live preview — is named by neither tier.

There is one more fact that shapes the answer. The cloud operates a managed Typhoon model against a shared platform key, throttled by a global rate limiter and a per-workspace daily token budget defaulting to 200,000 tokens. That is a real marginal cost the platform pays per free user, and it is the only one at planning time. Everything downstream of planning — creating a repository, sealing deployment credentials, running a customer's CI, serving a preview — costs the platform either a third-party quota or an operational obligation.

## Decision

**Planning is free, and metered. Provisioning is paid.**

**1. The free tier covers Scope, Spec and the task graph, for any number of people in one workspace.** Requirement authoring, stage generation, the plan, the task board, assignment, discussion and the assistant. No seat wall. The business user this product exists to reach must be able to bring colleagues in without a purchase, because a plan reviewed alone is not the workflow.

**2. The free tier is bounded by a token ceiling, not by seats or projects.** The per-workspace daily budget already exists and is already enforced at the generation and assistant call sites. Free workspaces get a ceiling lower than today's default; paid workspaces get a raised one. This is the only free-tier limit, and it is the one that tracks the only cost.

**3. Paid begins at repository provisioning.** Creating the project repository at tech-review exit, seeding the deployment template, sealing provider credentials, and the preview that follows are all paid. This is the boundary where the platform starts holding customer credentials and taking on an operational obligation, and it is where a customer's own willingness to pay appears, because it is the point at which the plan becomes software.

**4. The editor extension is free and unmetered.** It reads assigned tasks and closes them. It costs the platform nothing per use and it is the distribution surface; charging for it would be charging for adoption.

**5. Billing stays manual for now.** There is no payment integration in the repository and this ADR does not add one. Contact-sales remains the path to a paid workspace. Self-serve billing is worth building when the volume of inbound requests exceeds what a person can answer, and not before; the enforcement point in the meantime is the ceiling in decision 2, which is a comparison rather than a product.

## Consequences

- **The pricing page is rewritten around what the product does.** Plan 0022's M1. Both locales stay at parity, which the typed content modules enforce structurally.
- **The download page loses its job as the primary conversion surface**, because the thing it downloads is being deleted. Plan 0022's M2 covers what replaces it.
- **The daily budget stops being purely an abuse control and becomes a product boundary.** It is currently in-process and single-instance, which is acceptable while billing is manual and unacceptable once it gates revenue. Plan 0021's M4 already tracks it as one of four components needing a shared backplane; this ADR raises its priority within that set, because a ceiling that resets when a container restarts is not a ceiling.
- **Single sign-on is removed from the public copy** rather than promised. It can return when it exists.
- **A free workspace can plan a project it cannot provision.** That is the intended shape of the funnel, but the interface must say so before a Tech Lead reaches the tech-review gate rather than at it. Plan 0022 must cover the copy; the lifecycle transition itself is the natural place to surface it.

## Alternatives rejected

- **Free extension plus a single-person workspace, paid at collaboration.** The conventional seat story, and the one a sales team would ask for. Rejected because it puts the wall in front of exactly the person the product is trying to win — a business user whose first action is to share a plan — and because it bounds none of the managed-model cost, which a solo user can consume as readily as a team.
- **Free trial with an expiry.** Rejected because planning is the part of this product with the longest natural latency: a scope written in one week may not reach tech review for a month. An expiry would punish the customers behaving most like the intended ones.
- **Metering by project count.** Rejected because a project costs the platform nothing until it is provisioned, which is already the paid boundary. It would be a limit that does not track a cost.
- **Keeping the current tiers and correcting only the false claims.** Rejected as the option that leaves the page describing no product at all. It was considered seriously because it is cheap, and it remains the fallback if the boundary above proves wrong in front of real buyers.

## What would refute this

If inbound contact-sales requests come overwhelmingly from teams who have already provisioned a repository through a trial exception, the boundary is in the wrong place and paid should start earlier. If instead free workspaces routinely hit the token ceiling before ever reaching tech review, planning is costlier than assumed and the ceiling, not the boundary, is the thing to revisit.
