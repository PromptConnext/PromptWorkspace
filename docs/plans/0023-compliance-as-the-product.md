# Plan 0023 — Compliance as the product

**Date:** 2026-09-12 · **Status:** Exploratory — needs an ADR before implementation

This is a direction document, not a build plan. Nothing below is sequenced into milestones, nothing is estimated, and no file is marked for editing. Its job is to make the first of the four bets in [the product vision](../product-vision-2026-09-12.md) §4.2 concrete enough that somebody can write the ADR it calls for. An implementation plan should follow the ADR, not this.

PromptConnext's durable advantage is not that a model writes a plan; every vendor in this category can make a model write a plan. The advantage is that the plan's provenance is recorded — which regime governed it, which requirement it came from, which tasks it became, which commits closed them, which build carried them. Policy scope is where that advantage should start, and today it stops one step in.

## What exists today, accurately

Six built-in templates are declared in `apps/cloud/app/policies/registry.py:37`: `thai-pdpa`, `thai-law`, `gdpr`, `iso-27001`, `soc-2` and `internal-policy`. Each is a `PolicyTemplate` of id, name and description, its prose body in a sibling markdown file loaded by `template_body` (`:92`). The bodies are not freeform: all six share one seven-section skeleton — data handling, consent and lawful basis, retention and deletion, cross-border transfer, security controls, audit/logging/breach notification, and a closing "Implications for System Design". The first six sections are guidance for a reader; the last is different in kind, a short list of imperative sentences (thirty-seven across the six templates) each beginning "The system MUST". `apps/cloud/app/policies/templates/thai-pdpa.md:70-85` is the clearest example — seven obligations, from per-field classification and consent history to a breach path able to meet the 72-hour PDPC window. `apps/cloud/app/policies/templates/soc-2.md:43-65` shows the other shape: a control-family mapping (CC1 through CC9, plus the optional TSC categories) already speaking in identifiers an auditor recognises.

Three render functions consume a `PolicyScope`. `render_policy_context` (`apps/cloud/app/policies/registry.py:104`) emits full bodies under `[policy_template:<id>]` labels; `render_policy_summary` (`:124`) emits a compact `## Policy Scope` block of names and descriptions; `render_policy_scope_doc` (`:144`) emits a self-contained document. The first two are called by `_policy_block` (`apps/cloud/app/api/generation.py:475`), which gives the constitution stage the full context (`:491`) and every later stage the summary (`:492`), server-side from `project.policy_scope` and never from client input. The third is called once, at `apps/cloud/app/integrations/repo_seed.py:157-161`, where a non-empty scope becomes a seeded policy-scope.md in the new repository's docs directory.

The selection itself is two fields — `PolicyScope.selected` and `PolicyScope.custom_text` (`apps/cloud/app/models/schemas.py:362`) — in a nullable JSON column added by `apps/cloud/migrations/0022_policy_scope.sql:9` and hung off the project at `:500`. The user chooses it with checkboxes and one textarea (`apps/web/src/components/project/PolicyScopePanel.tsx:152-157`, `:193`), nudged to choose before generating the constitution (`:218-223`). The PATCH route refuses once the project reaches `repo_created` (`apps/cloud/app/api/policies.py:61-62`) — the same freeze the deployment config takes, for the same stated reason (`apps/cloud/app/models/schemas.py:382`) — at the repo-creation exit in `apps/cloud/app/api/sync.py:408`. Freezing buys exactly one thing: the seeded document in the customer's repository and the project's declared scope can never disagree afterwards. That is the only immutability the feature has, and an evidence story would have to generalise it.

Organisation-custom templates are designed for and unbuilt. The identifier scheme reserves them — built-in ids are bare slugs never containing a colon, and `ws:<uuid>` ids are meant to resolve against a `pz_workspace_policy_templates` table (`apps/cloud/app/policies/registry.py:11-15`, restated at `apps/cloud/app/models/schemas.py:359-361`) — and `GET /policy-templates` already accepts a `workspace_id` it does not use, reserved for that merge (`apps/cloud/app/api/policies.py:39-42`). A search for `pz_workspace_policy_templates` returns that one docstring and nothing else: no migration, no table, no resolver branch. The scheme is real; the feature is not.

## Why prompt injection is not compliance

Putting a regime's text in front of a model is genuinely useful: a plan written under `thai-pdpa` looks materially different from one written without it. But biasing a generation is not the same as asserting a control was satisfied, and the mechanism leaves no artifact that survives the generation. The prompt is assembled in memory at `apps/cloud/app/api/generation.py:125` and discarded. The audit row that does persist — `GenerationRun` (`apps/cloud/app/models/schemas.py:1026`), created at `apps/cloud/app/api/generation.py:174`, backed by `apps/cloud/migrations/0014_generation_runs.sql:6` — records workspace, project, stage, model source, model, status and token counts, and not which templates were in scope when it ran. So even *that a regime governed this generation* is unrecoverable from the database; it is inferable only from the project's current scope, which is a different claim. A regulator does not accept a prompt, and would not accept that inference either.

## What a regulated buyer actually needs

Four things, and the useful observation is that this platform already holds the raw material for all four without organising any of it as evidence.

*Traceability from an obligation to the work that addresses it.* Obligations are not objects yet, but the far end of the link is: `Requirement` (`apps/cloud/app/models/schemas.py:134`) and `SpecDocument` (`:141`, carrying `approved_by`) are graph entities with stable ids.

*Evidence that the work was done, and by whom.* A task closes with a commit: `TaskStatusArtifact` (`:203`) is an append-only child row carrying `commit_sha` and `uri`, and `Artifact` (`:165`) keys the same pairing into the graph. Authorship is pz-owned through `Task.assigned_user_id` (`:162`), and stage documents carry `created_by` (`:1007`).

*A record that cannot be quietly rewritten.* Partially present. `pz_deployment_tasks` (`apps/cloud/migrations/0027_deployment_tasks.sql:16`) was deliberately built as a frozen table rather than a view, the reasoning written into the migration header: a force-push or a reassignment must not rewrite what a stakeholder reviewed last Tuesday.

*An export somebody outside the company can read.* Absent entirely.

The argument of this plan is contained in that list. The evidence exists. It is not yet organised as evidence.

## Direction one — obligations as first-class

A policy template stops being a block of prose and becomes a set of identified obligations: a stable id (`thai-pdpa.consent-history`, `soc-2.CC6`), a normative sentence, and a pointer to the body section it came from. The bodies stay — a human still needs to read them — but "Implications for System Design" becomes structured data rather than the tail of a markdown file. That is the natural seam: those thirty-seven sentences are already discrete and testable, and `soc-2` is easier still, its control families already identified.

The cost is non-trivial. Every body needs restructuring, so the three render functions change together, and `render_policy_context` in particular returns one truncated string under a 30,000-character budget an obligation list would want spent differently. The seeded policy-scope.md is the awkward part: it already sits in customer repositories and is an *output* of the current shape. Either it keeps rendering as prose from the structured source — cheapest, repository contract unchanged — or it gains an obligation table and then differs between releases for two otherwise identical projects. The ADR should choose deliberately rather than let the renderer decide.

## Direction two — the coverage view

Given obligations, the product question is which ones a project's plan actually addresses. Some of it is computable rather than asserted: an obligation id cited in a requirement, a spec or a task title is a mechanical link, and the repository already has a precedent for convention-driven attribution of this kind in the T-ref commit grammar (`apps/cloud/app/integrations/task_refs.py`). A generated plan can be asked to cite the obligation ids it satisfies, and each citation verifies against the registry — a wrong id becomes a caught error rather than a silent gap.

What cannot be computed is whether the requirement genuinely satisfies the obligation. No amount of graph structure establishes that, and a coverage view implying it would be worse than none. The defensible product is a three-state view — cited and reviewed, cited but unreviewed, not cited at all — and the third state is the valuable one, because "five of this template's seven PDPA obligations are addressed and here are the two that are not" is a finding a Tech Lead can act on before an auditor produces it for them.

## Direction three — the export

An auditor receives a per-project compliance record: the frozen policy scope, the obligation set it resolved to at the time, every requirement and spec citing an obligation, the tasks derived from them, the commits that closed those tasks, and the builds those commits shipped in. The format should be boring — a stable JSON document as the machine-readable primary, rendered to a paginated binder for humans; the JSON is what the platform commits to and the rendering is a view over it.

Defensibility rests on immutability, and the story is uneven. Policy scope freezes at `repo_created`. Build attribution is *stored* frozen (`apps/cloud/migrations/0027_deployment_tasks.sql:16`) but the write is not once-only: `freeze_build_tasks` (`apps/cloud/app/deployments/attribution.py:65`) recomputes the task set from the commit range and replaces it wholesale at `:97`, and the webhook path calls it on every terminal-state delivery (`apps/cloud/app/api/github.py:337`, `:381`) — so a redelivery recomputes against a graph that may have moved. That is review finding 12, owned by `0024-delivery-evidence-graph.md` rather than here; this plan depends on it being fixed, because an export whose attribution can change afterwards is not an audit artifact. The ADR should also settle whether an export is itself immutable — signed, hashed, retained — or regenerated on demand from frozen inputs. The second is cheaper and probably sufficient, but only if every input really is frozen.

## The Thai and Southeast Asian market case

Two of the six templates are Thai regimes, the managed model is Typhoon, and `apps/corp` maintains exact EN/TH parity. The thesis is that a regulated Thai buyer — a bank, a hospital, a government-adjacent SOE — needs a PDPA evidence trail more than better code completion, cannot send source to a foreign model vendor, and has no local vendor offering this. Bring-your-own-everything then reads as a compliance property, not a cost saving.

Because this plan is exploratory it should name its own evidence test rather than assume the thesis. The test is cheap: take the seven "MUST" obligations already written in `apps/cloud/app/policies/templates/thai-pdpa.md:70-85` to three prospective buyers in that segment and ask what their PDPA evidence process costs in person-days per audit cycle, and what artifact their auditor accepts today. Confirmed if the answer is a hand-assembled spreadsheet costing real weeks; refuted if the auditor accepts a signed management assertion with sampling — in which case the export is a convenience rather than a purchase reason, and the bet should be re-priced before anything is built. Run this before the ADR, not after.

## What the ADR must decide

Whether obligations become first-class objects at all, or policy scope stays a prompt input and the evidence story is built over the existing graph without touching the templates. Whether obligation-to-requirement links are human-asserted, model-cited and verified, or both — and what the coverage view may claim when a link is uncited. Whether an export is a generated view or a retained signed artifact. Whether `ws:<uuid>` organisation templates ship with this or after, given that a customer's own control framework is plausibly what closes an enterprise deal. And whether Thailand and Southeast Asia is the stated market — open question 3 in the product vision, and the one that decides what this bet is worth.

One procedural note: the ADR directory already reached 0026, and this repository has claimed a number twice before — 0016 briefly covered both the Theia shell decision and task assignment, which is why the latter is now 0018. List `docs/decisions/` before taking a number.
