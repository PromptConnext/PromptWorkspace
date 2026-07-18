# PromptConnext — Long-Term Product Roadmap & Vision

**Date:** 2026-06-29
**Status:** Living document. Supersedes the model-strategy assumptions in the earlier local-first memo where they conflict; keeps its risk analysis and the task-management memo intact.
**Companion docs:** [`promptconnext-platform-architecture.md`](./promptconnext-platform-architecture.md) (this repo). Background research memos live in the `ideva-kit` repo under `docs/`: `local-first-ai-workspace-decision-memo.md`, `local-first-ai-workspace-architecture.md`, and `promptconnext-task-management-decision-memo.md`.

---

## 1. Vision

**PromptConnext is an AI-native development workspace — think VS Code, but equally approachable for business teams and developers — that orchestrates whichever AI models a team already pays for, according to each model's strengths.**

One workspace carries a project from business requirement to running code, with full transparency at every step. Business users work with scope, planning, and specifications; developers continue in the same workspace for implementation and coding. PromptConnext does not sell a proprietary model. It is the **orchestration layer** that makes a team's existing AI investments work together on the software lifecycle.

Two shifts define the product:

1. **Bring-your-own-model (BYO), not proprietary.** Teams connect the AI they already have — cloud API keys, agentic-tool subscriptions, or local models. PromptConnext's value is orchestration and workflow, not the model.
2. **One workspace, two personas.** The same tool serves a business analyst writing requirements and a developer shipping code, without either feeling like they're in the wrong product.

---

## 2. Positioning: "VS Code for the whole team"

VS Code won by being a light, extensible shell that developers made their own. PromptConnext borrows the shape but widens the door:

- **For business users:** a guided, jargon-free surface for defining scope, reviewing plans, and approving specifications. They never see a CLI or a Spec Kit command.
- **For developers:** the same project, continued into implementation — models, MCP servers, and coding settings under their control.
- **Shared spine:** every requirement, spec, task, and AI action lives in one traceable graph (see the task-management memo). Business and technical users see the *same truth* at different altitudes.

The competitive wedge is not "a better editor" or "a better model." It's that **business intent and technical execution live in one AI-orchestrated workspace**, visible end to end.

---

## 3. The 3S experience — PromptConnext's product language

Spec Kit (GitHub) is the **implementation engine**. **3S is the product experience** layered over it. Users move through Scope → Spec → Skill and never need to know Spec Kit exists.

| Stage | What the user does | What PromptConnext runs underneath | Primary persona |
|---|---|---|---|
| **Scope** | Describes what the project should achieve, in business terms | `speckit.specify` | Business |
| **Spec** | Reviews and approves the generated plan, presented as *the project specification* | `speckit.plan` | Business + Tech Lead |
| **Skill** | Tech Lead configures the AI skills, models, MCP servers, and implementation settings that will build the project | model/skill/MCP configuration → implementation | Technical |

Design principles for the 3S layer:

- **Abstract the engine completely.** No `speckit.*` command, constitution jargon, or pipeline terminology surfaces in the business-facing UI. Those are implementation details.
- **Each S is a clear, guided step** with an obvious "done / approve" moment — this is where the readiness gates live (you can't reach Spec without an approved Scope, can't reach Skill without an approved Spec).
- **Skill is the handoff point** from business to technical. It's also where BYO-model connection is enforced (Section 4).

> Naming note: "Skill" doubles as the stage *and* the thing configured in it (AI skills/models). That's intentional and reinforces the mental model — the stage where you equip the project with the skills to build itself.

---

## 4. Bring-your-own-model orchestration

### 4.1 The minimum to start a project (the connect-two rule)

**Assume users arrive with nothing configured.** A first-run onboarding gate guides every new user to connect and verify **at least one working model** before they enter the workspace — no one should hit the product with a dead configuration. Onboarding includes a **zero-cost path** (local Ollama, or a free-tier/OpenRouter key) so a user with no prior AI spend can still complete setup.

To enforce the full 3S workflow, a project ultimately requires:

- **One model optimized for specification & planning** — powers Scope and Spec (connected first, at onboarding).
- **One model optimized for coding & implementation** — powers Skill/implementation (prompted just-in-time at the Skill stage, not required to cross the onboarding gate).

A **Thai-language model is a future evaluation**, not a requirement — kept as an optional third role to revisit once the core two-model flow is proven (see Section 7).

### 4.2 Two connection modes (this is the important architectural nuance)

"Leverage existing AI subscriptions" is not one thing, because providers bill chat and programmatic access differently. PromptConnext must support **both** of these, and be honest about which is which:

| Mode | What it is | Works with | Caveat |
|---|---|---|---|
| **API key / endpoint** | User pastes an API key or OpenAI-compatible base URL | OpenAI, Anthropic, Google, Z.AI (GLM), OpenRouter, local Ollama/vLLM | Metered per-token, billed separately from any chat subscription |
| **Subscription / agentic auth** | User signs in with an existing plan where the provider allows programmatic use | Agentic tools that permit subscription login (e.g. Claude Code on Pro/Max plans, with a dedicated programmatic budget) | Availability and terms vary by provider; some prohibit proxying a chat plan as an API |

**Critical honesty for the product and the marketing:** a consumer chat subscription (ChatGPT Plus, Claude Pro) does **not** automatically grant general API access — that's separately billed. So "use the AI you already pay for" is true *sometimes* (local models always; agentic-tool sign-in where supported; API keys the user already holds) and *not* a blanket promise. Position it as **"connect your own models and keys — cloud or local — no PromptConnext model tax,"** not "reuse your ChatGPT subscription for everything."

### 4.3 Model-agnostic router

The orchestration layer routes each task to the connected model best suited to it — the quality-aware router from the architecture doc, now **provider-agnostic**: Scope/Spec tasks → the planning model; implementation tasks → the coding model; optional escalation to a stronger connected model for hard work. Because models are BYO, the router selects among *what the team connected*, and degrades gracefully when only the two required models are present.

### 4.4 Local vs. cloud is now the user's choice, not the platform's

The earlier local-first memo treated local models as the default engine. Under BYO, **local becomes one connection option among several.** A privacy-sensitive team connects Ollama; a team optimizing for capability connects GLM-5.2 or a frontier API. PromptConnext stays neutral and orchestrates either. This is a strictly more flexible position and resolves the "laptop hardware caps quality" risk — teams that need more just connect a bigger model.

---

## 5. Dual-persona experience

| | Business user | Developer / Tech Lead |
|---|---|---|
| **Enters at** | Scope | Skill / implementation |
| **Sees** | Requirements, plan review, spec approval, live progress | Models, MCP servers, coding settings, the execution graph, code artefacts |
| **Never forced to touch** | CLI, Spec Kit, model config | — |
| **Shared** | The same project, the same traceable requirement→spec→task→agent-run graph |

The seam between personas is the **Skill stage**: business hands an approved spec to the Tech Lead, who equips the project with models/skills/MCP and lets implementation proceed. Both keep watching the same progress view afterward — the end-to-end transparency that is Ideva Kit's founding goal, now the shared surface of PromptConnext.

---

## 6. How this ties to prior decisions

- **Task management (from its memo):** unchanged and reinforced. The AI-native execution graph (requirement → spec → task → artefact → agent-run → progress) is what makes 3S transparent and what no external tracker can hold. Jira/ClickUp remain a thin sync boundary.
- **Model architecture:** the router survives; it becomes provider-agnostic rather than local-only. GLM-5.2 becomes *a model a team may connect for the coding/strong role*, not a built-in tier.
- **Ideva Kit:** stays as-is; PromptConnext is the separate, BYO, dual-persona productization of the same requirement-to-code transparency thesis.

---

## 7. Roadmap (phased)

**Phase 1 — The 3S core, two-model BYO.** Workspace shell + the Scope→Spec→Skill flow over Spec Kit, fully abstracted. **First-run model onboarding gate** — assume the user has zero models and guide them to connect and *health-check* at least one working model (including a zero-cost local/Ollama path) before entering the workspace; prompt for the coding model just-in-time at the Skill stage. Support the two required model roles via **API-key/endpoint connection** first (most universal). Native AI-native task graph with a simple traceability view. Serves greenfield teams standalone. *Goal: prove the dual-persona 3S loop end to end, with a cold-start user reaching a working config.*

**Phase 2 — Connection breadth + one enterprise sync.** Add subscription/agentic auth where providers allow it; add local (Ollama) as a first-class connection. Ship the Jira two-way status sync from the task memo. *Goal: fit both greenfield and enterprise; remove the "which AI can I use?" friction.*

**Phase 3 — Orchestration depth.** Provider-agnostic quality-aware routing across the connected models, escalation policy, MCP-based optional tool/connector ecosystem, richer agent-run evidence in the graph. *Goal: the "orchestrates multiple models by strength" promise, fully realized.*

**Phase 4 — Evaluations & specialization.** Evaluate whether to recommend/require a **Thai-language model** role (Typhoon et al.), plus any other role-specialized models demand surfaces. Formalize fine-tune/eval tooling if a specialized-model advantage proves out. *Goal: extend the model roster on evidence, not speculation.*

---

## 8. Risks & open decisions

1. **BYO connection honesty.** Over-promising "reuse your subscription" will burn trust when a user's ChatGPT Plus can't be used as an API. Mitigate with clear connection UX that names the mode and its billing. *(Decided: dual-mode, honestly labeled.)*
2. **Two-persona product is hard to keep coherent.** One workspace that's genuinely comfortable for both audiences is a real design challenge; resist forking into two products. The 3S spine and shared graph are the unifying device.
3. **"VS Code but for everyone" scope risk.** VS Code is enormous. Stay disciplined: PromptConnext is the *3S workflow + model orchestration + transparency graph*, not a general editor. Coding depth can lean on developers' existing IDEs via integration rather than rebuilding an editor.
4. **Model quality variance across BYO setups.** A team that connects two weak models gets a weak experience you don't control. Mitigate with recommended model profiles per role and honest capability signals — analogous to the hardware-aware onboarding from the first memo.
5. **Provider terms of service.** Agentic/subscription auth must respect each provider's ToS on programmatic use. Legal review before shipping Mode 2 per provider.

**Open decisions to confirm:** (a) which providers to support at launch for each connection mode; (b) whether developers code *in* PromptConnext or in their IDE with PromptConnext orchestrating; (c) the minimum recommended model profile per role.

---

## 9. Bottom line

PromptConnext's durable advantage is the combination no one else offers: **a business-friendly 3S workflow and a developer's implementation workspace, over a single transparent AI-native task graph, orchestrating the models a team already owns.** The model layer is deliberately not proprietary — that's a feature, not a gap. Build the 3S experience and the orchestration/transparency spine deeply; keep the model layer open and the editor scope disciplined.

---

## Sources
- [Why paid Claude subscriptions bill API access separately — Claude Help Center](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)
- [Use Claude Code with your Pro or Max plan — Claude Help Center](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Claude subscriptions get separate budgets for programmatic use — The Decoder](https://the-decoder.com/claude-subscriptions-get-separate-budgets-for-programmatic-use-billed-at-full-api-prices/)
