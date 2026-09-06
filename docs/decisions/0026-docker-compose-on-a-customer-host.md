# ADR 0026 — Docker Compose on a server the customer owns, with the scaffold selected from the plan

**Date:** 2026-09-06 · **Status:** Accepted · **Deciders:** product + engineering

**Prompted by:** a request to drop the Fly.io template and offer Docker + Docker Compose instead, with the configuration derived from each project's technical plan.

**Extends:** [ADR 0021](0021-deployment-templates-seeded-ci-cloud-observed.md) — the Deployment Template contract, its freeze semantics and its "adding a template is a directory and two registry entries" property. [ADR 0024](0024-generated-deployment-scaffolds.md) — the boundary on what a model may write into a project repository, and the open question this ADR closes. [ADR 0025](0025-provider-credentials-split-workspace-and-project.md) — the workspace/project credential split, which this template needs in a third provider's clothes.

**Retires:** the `fly-node` template and the `fly` provider. Nothing in the codebase should reintroduce either; a Fly deploy is now the same shape as any other container deploy, and the template that replaces it does not name a hosting vendor at all.

---

## Context

Three templates shipped before this: `static-r2` (platform-owned storage), `fly-node` (a customer-owned provider with a provider-minted URL) and `next-vercel` (the same posture, for the stack most of these projects actually are). `fly-node` existed to prove that a template could carry a credential the platform does not mint. Once `next-vercel` shipped, it proved that too — and better, because Vercel is a provider our users actually asked for. What `fly-node` was left doing was asking a business user to create a Fly account for a placeholder Node service.

Meanwhile ADR 0024 closed its argument with an open question it declined to answer: *which host a generic container template should target*. It named the candidates — Cloud Run, Railway, a customer VPS over SSH — and observed that the VPS "is the one users ask for and the one whose credential posture is worst". That question is what actually blocks the FastAPI, Go and Rails projects the whole discussion was about. This ADR answers it.

The second half of the request — configuration derived from the technical plan — runs straight into ADR 0024's decision 1, which puts the Dockerfile and everything under `.github/**` on the never-model-authored list. That reasoning has not weakened: `create_repository` writes the Actions secrets *before* it commits the scaffold, so any seeded workflow is a file with access to the workspace's deploy credential from its first run, and the plan is free text a business user typed in the Planner. A path from prompt-injectable text to a workflow that reads a deploy secret is not mitigated by review, because nobody reviews a seeded workflow.

---

## Decision

**1. The host is a Linux server the customer administers, reached over SSH.** The credential is an SSH private key. The workspace connects a host address, an SSH user, a host key line and that private key; each project names its own application slug, its own published port and its own public HTTPS URL. That last split is ADR 0025's rule applied to a new provider: one host runs many projects, so anything that names *where a project lands on the host* belongs to the project and not to the workspace credential every project shares. Storing the port or the slug at workspace level would make every project in a workspace fight for one port — the same defect, in different clothes.

We chose the customer's own server over Cloud Run and Railway despite ADR 0024's observation about credential posture, and the reason is that only this option is honestly *Docker Compose*. Cloud Run runs one container; a compose file there is decoration for local development. Compose earns its place when an application and its Postgres and its Redis come up together on one machine, and that machine is a box somebody owns. Choosing a managed host would have delivered "Docker" while quietly dropping the "Compose".

**2. The preview URL is named by a human, not minted.** No API can tell us where a customer's box answers, so the Tech Lead supplies the URL alongside the port, the registry records `preview_url_from="public_url"`, and both the seeded workflow and this service read the same stored value. The workflow health-checks that URL before it reports success, so a green deploy means a stakeholder can open the page — not merely that a container started. It must be HTTPS, and that is refused at the field rather than explained later: the Preview tab is an HTTPS page and a browser will not frame plaintext inside it, so an `http://` URL produces a preview that is empty for every viewer.

**3. The image travels over the SSH connection the job already has.** GitHub Actions builds it, `docker save` streams it to the host, `docker load` receives it. The obvious alternative is GHCR, and it costs a second credential on the host for a private package — a registry login to provision, rotate and explain — to move an image to exactly one place. Nothing is gained. This also keeps the pull-request job honest: it builds the container and touches no secret at all.

**4. Strict host key checking stays on, which is why the admin pastes a host key.** The workspace connection asks for the `ssh-keyscan` line, it is written to the repository as a variable, and the workflow uses it with `StrictHostKeyChecking yes`. Scanning for the key inside the run would be theatre — trusting whatever answers on that address, at the moment the key is about to be handed to it.

**5. The plan selects among hand-written files; it never authors one.** `plan_profile.derive_stack_profile` is a keyword count over the `plan` stage document, yielding a runtime and a list of backing services. The registry's composed-scaffold convention then seeds `base/` always, exactly one `runtimes/<name>/`, and the `services/<name>.yaml` fragments the profile named, spliced in at a marker line. Every candidate file is written by hand in this repository, so the worst outcome of a bad reading is a Python placeholder for a Go project — which the first implementation task replaces anyway, exactly as ADR 0024 observed about placeholders generally.

That framing is what lets this ship without touching ADR 0024's boundary, and it keeps the property ADR 0024 decision 3 warned we would lose: **the selection is deterministic**. The same plan text seeds the same tree, byte for byte, so a seeded pipeline stays reviewable and a template bug stays reproducible from the template id and the plan alone. `template_id` still identifies what was committed, because the tree is a function of `(template_id, plan)` and the plan is stored beside it.

**6. The composed layout is a convention, not a per-template branch.** A scaffold directory containing `base/` is composed; anything else is flat and behaves exactly as before. No registry field selects it, nothing dispatches on a template id, and a future template gets the same behaviour by adopting the same directory names. `static-r2` and `next-vercel` are byte-for-byte unchanged.

---

## What this costs, stated plainly

**An SSH key in a repository secret is shell access to that host for anyone who can push to the repository.** ADR 0021's seeded `docs/deployment.md` has always said that repository secrets are readable by anyone with push access, and for a Vercel token that is a bounded loss. Here it is a login on a machine. The mitigations are real but they are advice, not enforcement: a dedicated unprivileged user, a host that runs previews only, and the pull-request job that never references `secrets.`. This is written into the provider's own notes and into every repository's deployment document, because a Tech Lead should meet it before connecting, not after.

**Verification of the workspace half is weaker than any other provider's.** Proving the key is authorized would mean speaking SSH from this service — an outbound shell session from the cloud and a new dependency. What we check instead is that the address answers on port 22 and that the two pasted values are the right kind of thing. A key the host rejects surfaces on the first deploy, in the run log, where the failure names itself.

**Nothing here issues a certificate or configures a reverse proxy.** The URL a project names has to already work. That is a real gap between "connected" and "deployed", and it belongs to the customer's own infrastructure.

---

## Open questions

Whether the keyword scan should ever become a model call is the interesting one, and the answer is probably not: a model would buy a better guess at a placeholder, at the cost of the determinism decision 5 rests on. If it is revisited, it should be revisited as "the model proposes, the Tech Lead confirms, the confirmed value is stored" — which is a form the freeze semantics can carry.

Managed container hosts remain unbuilt. Cloud Run or Railway would be a fourth template with a lighter credential posture, and this one does not preclude them; it simply is not the same product.
