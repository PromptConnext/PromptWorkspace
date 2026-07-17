# ADR 0013 — A managed Thai-LLM tier (Typhoon) for web-app planning, reached through stage-based model routing

**Date:** 2026-07-13 · **Status:** Proposed · **Deciders:** product + engineering
**Extends:** ADR 0011 (cloud as product pillar; workspace-BYO key) and ADR 0012 (paired local compute node). This adds a **third** way the web app can reach a model — a PromptZone-operated managed tier — and the routing layer that decides which of the three runs each Spec Kit stage.
**Prompted by:** business users won't install a desktop app or a Connector; they expect an online service to plan requirements and write PRDs. That forces a hosted model, which forces the cost question — and, since PromptZone targets Thailand, the Typhoon question.

## Context

ADR 0012 solved "web-app authoring without a token-brokered provider" by routing jobs to a laptop. Its own §2/§6 admit the limit: the business persona *is* the population least likely to run a node, and "your node is offline" is a poor first experience for a PM writing a PRD. The honest conclusion is that a fully-online path needs a model **PromptZone operates** — the exact thing ADR 0011's "workspace-BYO key" made optional and ADR 0003/§2.1 originally forbade.

Operating a model means paying for it, so two questions collapse into one:

1. **Which model** gives acceptable quality for Thai-language business planning at a cost we can run as a default (ideally free) tier?
2. **How** do we wire it into `constitution → specify → plan → tasks` without abandoning BYO-model as PromptZone's identity (ADR 0009/0011)?

Typhoon (SCB 10X / SCB DataX) is the obvious candidate for (1) because it is Thai-first and open-weight. The rest of this ADR assesses it, then answers (2) with a routing layer.

---

## Part A — Typhoon assessment

### What it is

A family of **open-weight, Thai-optimised** LLMs plus OCR/ASR models, from SCB 10X. Current text flagships (per the model docs, last updated Nov 2025):

| Model | Size | Base | Context | Notable | License note |
|---|---|---|---|---|---|
| `typhoon-v2.5-30b-a3b-instruct` | 30B MoE, **~3B active** | Qwen3 | **128K** | Agentic, **function calling**, MoE → fast/cheap per token | Qwen3 lineage → **Apache-2.0-class** |
| `typhoon-v2.1-12b-instruct` | 12B dense | Gemma 3 | 56K | Hybrid reasoning | **Gemma license** — commercial-OK but carries Google's Gemma terms/use policy, *not* pure Apache |
| `typhoon-ocr` (1.5, 2B) | 2B | — | — | Thai document/form OCR | Relevant: business users upload Thai PRDs/specs as images/PDFs |
| `typhoon-asr-realtime` | ~114M | — | — | Thai streaming speech-to-text | Meeting-to-requirements capture, later |

The **licensing split is a real decision input**, not a footnote: the 30B (Qwen3-based) is the clean commercial default; the 12B inherits Gemma terms. Standardise on the **30B** and the licensing story stays simple.

### Quality

- **Thai:** best-in-class for its size. Typhoon 2 reports beating Typhoon-1.5 and matching much larger SOTA models on **ThaiExam, M3Exam, IFEval-TH, MT-Bench-TH** — the benchmarks that actually matter for Thai business prose. This is the whole reason to consider it.
- **Function calling / structured output:** the 30B is explicitly built for agentic use and function calling — directly useful for emitting structured specs and task lists rather than free text.
- **Where it is *not* frontier:** long-context English technical reasoning. A Thai-specialised 30B (3B active) will trail Claude/Gemini/GPT-class models on `speckit.plan` — the most technical, most English, least Thai stage. **This shapes the routing decision below:** lean on Typhoon where it's strong (Thai business language), not where it's weak (technical planning).

### Cost & deployment

There are three ways to consume it, and their **maturity differs sharply right now:**

1. **Free hosted API** (`opentyphoon.ai`) — real, live, but rate-limited (**5 req/s, 200 req/min**, shared) and explicitly *not* for production. Excellent for a **pilot / free tier**, not for guaranteed SLA.
2. **Production managed API** — **this is the risk.** The Together-AI "API Pro" was **sunset 31 Dec 2025**; the promised **AWS-native production API was projected for Q1 2026 and is not confirmed live** as of this writing. **Verify current status before depending on it.** Historical API-Pro pricing for reference: 12B ≈ **$0.20 / 1M tokens**, 70B ≈ **$0.88 / 1M**.
3. **Self-host the open weights** — the durable path, and the one immune to the hosting-gap above. Typhoon's own benchmarks (vLLM):

| Model | GPU | Best cost / 1M tokens | Notes |
|---|---|---|---|
| 2.5 **30B** A3B (FP8) | H100 (80GB) @ $2.50/hr | **~$0.09–0.12** at concurrency 64–128 | MoE keeps it cheap despite 30B total |
| 2.1 **12B** Gemma | H100 @ $2.50/hr | **~$0.15** at concurrency 64 | |
| 2.1 12B Gemma | L4 (24GB) @ $0.71/hr | ~$0.41 at concurrency 32 | cheap baseline box |
| 2.5 30B A3B | 32GB-RAM laptop (Ollama, quantized) | — | **dev/offline only**, CPU, slow |

The headline: **at self-host concurrency, a Thai planning turn costs a fraction of a cent.** The 30B's MoE design (3B active) is the reason a "30B" is affordable. The real cost is not tokens — it's **GPU idle time**, which the architecture below addresses with a shared, scale-to-zero pool.

### Scalability & lock-in

Open weights = **no vendor lock**: PromptZone can start on the free API, move to self-host, or adopt the AWS API, swapping without rewriting anything above the OpenAI-compatible boundary. That is strategically aligned with BYO-model. The **near-term risk** is purely operational: the production managed offering is mid-transition, so anything needing an SLA today means **self-hosting**, which means we run GPUs.

### Verdict

**Good fit — as the Thai-language, business-facing default — provided PromptZone self-hosts (or the AWS API ships).** Use the **30B (Qwen3-based)** as the standard model for its clean license, 128K context, and function calling. Do **not** make Typhoon the default for `speckit.plan`. Treat the free API as the pilot tier and self-host FP8 30B on a shared H100 pool as the production tier.

---

## Part B — Architecture: three tiers, one router, per-stage routing

### Decision

**1 — A "Model Source" abstraction with three tiers, chosen per workspace.** All three already share the engine's OpenAI-compatible `ModelConnection` shape, so this is a routing concern, not three codebases:

| Tier | Who runs the model | Credential location | From ADR |
|---|---|---|---|
| **Managed (new)** | PromptZone-operated Typhoon pool | none (platform-side) | this ADR |
| **BYO workspace key** | vendor cloud, team's key | server secret store | 0011 |
| **Local node** | user's laptop | OS keychain | 0012 |

Business-only workspaces default to **Managed** (zero setup, always online). Teams with a frontier key keep **BYO**. Privacy-strict or offline teams use the **Local node**. The default is Managed; the others remain first-class.

**2 — Stage-based model routing is the cost lever.** The Spec Kit stages have very different shapes, and routing each to the cheapest model that clears its quality bar is what keeps the managed tier affordable *and* the plans trustworthy:

| Stage | Default model | Why |
|---|---|---|
| `speckit.constitution` | **Typhoon 30B (Managed)** | Short, principle-setting, often Thai. Cheap, Typhoon's strength. |
| `speckit.specify` | **Typhoon 30B (Managed)** | Thai business requirements → structured spec — *the* Typhoon sweet spot; function calling emits the spec shape. |
| `speckit.plan` | **Frontier / Tech-Lead BYO** | Technical, English-heavy, architectural. Owned by the Tech Lead (their note), so it naturally rides their BYO key or local node — **not** the managed Typhoon default. |
| `speckit.tasks` | **Typhoon 30B (Managed)** | Structured extraction from an approved spec; function calling → task list. Cheap and high-volume. |

Typhoon carries the three high-volume, Thai, business-facing stages; the frontier model is reserved for the one stage that needs it. The router default is per-stage but **overridable per workspace/project** — a fully-Thai team could run `plan` on Typhoon too; an English-first team could point `specify` at their frontier key.

**3 — Serve the managed tier as one multi-tenant, scale-to-zero pool.** A single vLLM deployment of FP8 30B behind an OpenAI-compatible endpoint, shared across workspaces, **membership-scoped before every call** exactly as ADR 0011 scopes RAG retrieval. Scale-to-zero (or scale-to-one small box) off-hours; burst to H100 concurrency under load. Idle GPU is the cost, so the pool is shared, not per-tenant.

**4 — Cost controls, reusing what exists.**
- **Per-workspace token budgets** via the existing `apps/cloud/app/rag/budget.py` pattern, extended from RAG chat to planning stages.
- **Free-tier = the free Typhoon API** (rate-limited) with a clear ceiling; **paid/managed = the self-hosted pool.** A workspace that exhausts the free tier is offered BYO-key or the managed pool, never a silent frontier bill.
- **Cache** constitution/spec prompts; they repeat across a project.
- **OCR pre-step** (`typhoon-ocr`) so a PM can drop a Thai requirements PDF and have it become spec input — a differentiator that costs ~$0.12/1M and reuses the same pool.

```
apps/web (business user, browser)
   │  "Generate spec" (Thai requirements)
   ▼
Cloud router ── stage? ──► specify/tasks/constitution ─► Managed Typhoon pool (30B FP8, scoped)
                        └► plan ───────────────────────► Tech-Lead BYO key / local node (0012)
   │                                                     (frontier model)
   ▼
Task graph (ADR 0010 projection)  ◄── artifacts, citations, lineage
```

### Options considered

**A. Managed Typhoon + stage routing (chosen).** Medium complexity (a GPU pool + a router). Product value high: business users plan online in Thai, cost stays sub-cent, BYO preserved as override. Con: PromptZone now operates inference infra and eats idle-GPU cost.

**B. Managed frontier model (GPT/Claude/Gemini) for everyone.** Lowest complexity (just an API key). **Fails the cost test** at scale and **fails the Thailand/BYO thesis** — you'd pay frontier rates to write Thai a specialised 30B does well, and you'd re-introduce exactly the token-brokered spend ADR 0012 rejected, now on *PromptZone's* bill.

**C. Local node only (ADR 0012 as-is).** Zero new infra. **Fails the usability test** for business users — the whole reason this ADR exists.

**D. Free Typhoon API only, no self-host.** Near-zero cost, zero ops. **Fails on SLA** — rate-limited and not production-grade, and the production managed offering is mid-transition. Fine as the *pilot* tier, not the *only* tier.

### Trade-off analysis

The decision balances three axes: **usability** (B ≈ A > D > C), **cost at scale** (A > D > C > B), and **strategic alignment / no lock-in** (A ≈ C > D > B). Only **A** is acceptable on all three, and it degrades gracefully: launch on **D** (free API, no GPU bill) to validate demand, then stand up the self-hosted pool when volume justifies it — same code, same OpenAI-compatible boundary, just a different endpoint. Stage routing is what lets A be cheap *without* being low-quality, by never spending frontier money on Thai prose and never spending Typhoon quality on technical plans.

The load-bearing risk is **operational, not architectural**: running a GPU pool is a new competency, and Typhoon's own production API being mid-transition means we can't lean on someone else's SLA yet. That argues for the phased path (D → A), not against the decision.

## Consequences

**Easier**
- Business users plan and write PRDs fully online, in Thai, with no install — the gap ADR 0012 left open.
- Per-project planning cost drops to fractions of a cent; the managed tier can plausibly be a **free/default** offering.
- BYO-model survives as identity: Managed is a default and an on-ramp, not a lock-in — open weights mean a workspace can graduate to self-host or swap models freely.
- Thai-first positioning gets a concrete technical expression for the Thailand market.

**Harder**
- PromptZone now **operates inference infrastructure** — GPU pool, autoscaling, vLLM ops, idle-cost management. New competency, new on-call surface.
- The **§2.1 "no models in the cloud" posture is now amended twice** (0011 workspace keys, this ADR's managed pool). The privacy story narrows to "compute you *chose*; your credentials never leave your machine" — must be stated plainly to users.
- A **router** is a new correctness-and-cost-critical component (wrong route = surprise frontier bill or low-quality plan). Needs tests and per-workspace override UX.
- Dependency on Typhoon's **production hosting maturing** if we don't self-host; **licensing diligence** on whichever base model we standardise (prefer the Qwen3-based 30B).

**To revisit**
- **Verify the AWS-native Typhoon production API status** before choosing self-host vs managed-API for the production tier (projected Q1 2026, unconfirmed).
- Whether `speckit.plan` ever defaults to Typhoon for fully-Thai teams (quality bar test).
- Multimodal: fold `typhoon-ocr`/`typhoon-asr` into requirements capture (Thai PDF → spec, meeting → requirements) once text planning is proven.

## Action items

1. [ ] Spike: self-host FP8 `typhoon-v2.5-30b-a3b-instruct` on one H100 (RunPod) behind vLLM's OpenAI-compatible server; confirm the engine's `ModelConnection` talks to it unchanged.
2. [ ] Quality eval: run real `constitution`/`specify`/`tasks` prompts (Thai business inputs) through Typhoon 30B vs a frontier model; confirm the routing table's assumptions — especially that `plan` genuinely needs frontier.
3. [ ] Verify current Typhoon production-API status (AWS launch) and re-price managed-API vs self-host accordingly.
4. [ ] Confirm the license of the standardised model (prefer Qwen3-based 30B, Apache-class) for commercial hosting.
5. [ ] Router: implement per-stage model selection with per-workspace/project override; default table as above.
6. [ ] Cost controls: extend `rag/budget.py` token budgets to planning stages; wire free-Typhoon-API as the free tier with a ceiling and a BYO/managed upsell.
7. [ ] Membership-scope every managed-tier call (reuse the RAG scoping from ADR 0011); load-test the shared pool with scale-to-zero.
8. [ ] Web: model-source picker (Managed / BYO key / Local node) + per-stage override, defaulting business workspaces to Managed.

## Open questions

- Do we launch on the **free Typhoon API** (tier D) to validate demand before paying for a GPU pool, accepting the rate limit as a beta constraint? (Recommended.)
- Is the managed tier **free** (loss-leader for adoption) or metered above a budget? The `budget.py` plumbing supports either; product must pick.
- Should `speckit.plan` on a **Tech-Lead's local node** (ADR 0012) be the *default* for `plan`, making 0012 and 0013 complementary rather than alternative tiers within one project?
