# PromptConnext — Product vision

**Date:** 2026-09-12 · **Status:** Draft for review · **Basis:** the repository at `c30a5fd` on `main` — source, tests, migrations, the twenty-six ADRs in `docs/decisions/`, the [cloud codebase review of 2026-09-06](./cloud-codebase-review-2026-09-06.md), and git history.

**Relationship to existing documents.** This supersedes the positioning in [`promptzone-product-roadmap.md`](./promptzone-product-roadmap.md) (2026-06-29) and the deployment-shape assumptions in [`promptzone-platform-architecture.md`](./promptzone-platform-architecture.md) where they conflict. Both were written for a two-persona desktop product that ADR 0019 and ADR 0020 cancelled in August. Their risk analysis survives; their product description does not.

Where the documentation and the code disagree, this document treats the code as the product.

---

## 1. Where the product actually is

PromptConnext already decided to stop being a local-first desktop application and become a cloud-authoritative delivery platform with an editor extension on the end. [ADR 0020](./decisions/0020-cloud-is-the-source-of-truth.md) inverted the authority model: the cloud authors the task graph and the local SQLite database becomes a cache that may be deleted and rebuilt without loss. [ADR 0019](./decisions/0019-desktop-as-vscode-extension.md) followed it, retiring both desktop shells in favour of a VS Code extension and a portable MCP server. Everything worth doing next follows from finishing that sentence.

The cloud and the web app made the move. The desktop and the engine did not. Commit history tells the strategy more honestly than the documentation does:

| App | Files touched, last 60 days | Last touched | State |
|---|---:|---|---|
| `apps/cloud` | 492 | 2026-09-12 | Active |
| `apps/web` | 309 | 2026-09-06 | Active |
| `apps/vscode` | 105 | 2026-08-22 | Slowing |
| `apps/engine` | 96 | 2026-08-20 | Slowing |
| `apps/corp` | 97 | 2026-08-09 | Slowing |
| `apps/desktop` | 172 | 2026-08-13 | Frozen |
| `apps/desktop-theia` | 39 | 2026-08-02 | Frozen |

The desktop stopped on the exact day the pivot ADRs were written and never resumed. Both of those ADRs still carry the status **Proposed**, a month after the code moved. Nothing was formally decided, so nothing was formally retired: the Tauri shell and the Theia shell were abandoned in place rather than deleted, and `README.md` and `CLAUDE.md` still present the desktop as the application you run and the local graph as the offline source of truth. The record describes a system that no longer exists, which is precisely the failure mode ADR 0020 wrote itself to prevent.

Judged on its own, `apps/cloud` is not a prototype. Twenty-three Postgres tables across twenty-seven migrations, fifty-six test modules, a project lifecycle state machine, four deployment templates, six compliance policy templates, a membership-scoped retrieval assistant, and a GitHub integration that seeds a repository and then reads its own webhooks back. It contains essentially no TODO markers. It is the most finished thing in the repository, and `apps/web` is close behind it.

### 1.1 The open data-loss path

ADR 0020 gave one sequencing instruction above all others: **disable the full-graph push before anything else**, because a read-only desktop is a degraded product while a desktop that overwrites the Tech Lead's plan is a data-loss incident. That step was skipped.

`startCloudSyncLoop` in `apps/engine/src/sync/loop.ts:494` still calls `pushProjectSnapshot` on every interval tick, and `assembleSnapshot` (`:126`) still builds a complete local snapshot of requirements, spec documents, tasks, artifacts and agent runs to push over cloud state that is now the authored original. The cloud's own `push_graph` (`apps/cloud/app/api/sync.py:617`) compounds it: it checks project membership only, while the newer `set_task_status` (`:566`) and `assign_task` (`:533`) routes enforce task ownership and admin-only stage authoring. Finding 1 of the cloud review reaches the same conclusion from the other side.

The cloud built its half of the inversion — the dedicated status PATCH exists and works. The engine never stopped pushing around it. Any shipped desktop build that opens a cloud-planned project is a live regression vector, on a twenty-second timer. This is the first thing to fix, ahead of every recommendation below.

---

## 2. The asset worth building on

Strip away the workflow branding and one capability is genuinely differentiated, half-built, and unmatched by the tools this product sits next to.

The platform can draw an unbroken line from a business requirement to a running application. A requirement produces a spec; the spec produces tasks; a developer commits against a task reference; the extension recognises that commit only once it has actually reached the remote; the cloud attributes the push to tasks; the project's own CI deploys; the webhook records the deployment; and the web app shows a stakeholder the live build alongside the tasks inside it. `pz_deployment_tasks` (migration 0027) is the join table nobody else has.

A project-management tool knows the task closed. A deployment dashboard knows the build shipped. This is the only system that knows they are the same event.

Three details make that credible rather than aspirational. `partitionByPublication()` in `apps/vscode/src/git/publication.ts` distinguishes a commit that was published from one amended or rebased away, so a task closes on publication rather than on a local commit ([ADR 0022](./decisions/0022-task-loop-closes-on-push.md)). `_probe_frame_policy` in `apps/cloud/app/api/github.py:438` probes the deployed URL server-side to decide whether the preview can be embedded, because a browser cannot read cross-origin frame headers. And deployment scaffolds are hand-written files *selected* by `plan_profile.derive_stack_profile`'s keyword read of the project's plan, never generated by a model — which is what keeps the seeded pipeline deterministic and reviewable ([ADR 0024](./decisions/0024-generated-deployment-scaffolds.md), [ADR 0026](./decisions/0026-docker-compose-on-a-customer-host.md)).

The chain has two breaks, both already identified in [ADR 0023](./decisions/0023-development-preview-for-every-project-type.md) and the cloud review. The cloud matches `\bT\d{3}\b` while the extension matches `/\bT(\d{1,6})\b/`, so a project numbering its tasks `T12` closes them from the editor and produces no build attribution at all. And regeneration mints fresh entity identifiers instead of reconciling existing rows (review finding 5), so a second generation leaves duplicate tasks beside the originals with their assignments and statuses intact.

---

## 3. Short-term vision — finish the pivot, then make it operable

Ordered by dependency, not by appetite. The first three are prerequisites to shipping anything; the last two decide whether shipping it matters.

### 3.1 Close the write path, then delete the old one

Disable the graph push from the engine. Retire `push_graph` as a public mutation surface, or constrain it to explicitly authorised operations, since it currently bypasses the ownership and admin rules its own replacements enforce. Then delete the local planning path rather than re-pointing it: `runStage()`, its templates, the local stage routes and the approval gates all have a cloud twin, and maintaining two implementations of a workflow only one side runs is how the vocabularies diverged in the first place.

Align the two task-status vocabularies and remove the mapping tables at `sync/loop.ts:19` and `:522` rather than adding a third state to them. Both maps are lossy in ways that only bite once tasks round-trip, and under cloud authority every task round-trips: `failed → todo` erases a failed run upward, and `implemented` and `verified` both collapse to `done` downward, so a desktop that pulls a verified task and later pushes its status silently demotes it.

### 3.2 Decide the desktop's fate in writing

Move ADRs 0019 and 0020 out of **Proposed**. Delete both shells or fund one. Leaving a Tauri app and a Theia shell frozen in the tree costs a code-signing story that was never finished, a release pipeline for an artifact nobody is improving, and a marketing site whose primary conversion surface points at it.

The macOS builds ship unsigned today — `desktop-theia-build.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: false`, and `update-lifecycle.js` documents macOS auto-update as expected-non-functional until notarisation, leaving an sha512 checksum served from the same origin as the payload. That is a corruption check, not an authenticity one. Retiring by deletion closes the gap for free, which is ADR 0019's own argument.

`apps/desktop-theia` in particular has working auth, updater and sidecar plumbing and no product interface at all; its own comments say the planner extension lands in a milestone (ADR 0016 M3) that ADR 0019 cancelled. It is infrastructure ahead of a feature that will never be built.

### 3.3 Fix the correctness defects the internal review already found

The [cloud codebase review](./cloud-codebase-review-2026-09-06.md) catalogued twenty-two findings, seven of them High, and its suggested order of work is sound. The sharpest are structural rather than cosmetic:

- **Production pagination implements a different contract from memory** (finding 3). The Supabase adapter applies the limit per table and filters the ID continuation in Python afterwards, never setting continuation metadata. Real clients can stop early, exceed the page size, or permanently skip entities.
- **Row-level security is more permissive than the API** (finding 2). Graph-table policies allow all operations for any project workspace member, so a member can bypass route-level admin and ownership restrictions by writing tables directly.
- **Repository adoption on a name collision** (finding 9). The route adopts any accessible repository returned by `get_repo`, without requiring a provisioning record proving this project created it, then seeds project files, deployment secrets and a webhook into it.

The reason these survived a 558-test suite is one fixture choice: `tests/conftest.py` forces the in-memory backend for the whole suite, so the production adapter's divergence passes green. A focused repository-contract suite run against both adapters is the durable fix, prioritising pagination, membership, concurrent updates and task filtering.

### 3.4 Build the operational floor a hosted product needs

There is no continuous integration for the cloud, the web app, the extension or the marketing site. `.github/workflows/` contains three files, and two of them build frozen desktop shells. There is no error tracking, tracing or metrics anywhere in the repository — no Sentry, OpenTelemetry, Prometheus or equivalent.

Presence (`ws/manager.py`), rate limiting (`app/ratelimit.py`), the daily token budget (`rag/budget.py`) and the indexing queue (`rag/queue.py`) are all in-process and single-instance. That is a documented, deliberate trade-off rather than an oversight, but it caps the cloud at one container, and `docs/DEPLOYMENT.md` already says so.

Sequence it: continuous integration first, because it protects everything else and the test suites already exist; then error tracking, because a single-instance hosted service with no observability fails silently; then a shared backplane when a second instance is genuinely needed, not before.

### 3.5 Make the public story match the product

`apps/corp` sells a **Free** tier described as "The full desktop app, forever", against an **Enterprise** tier priced on request. Four of the five free-tier features describe the desktop application or the local-first graph. The free tier is the product being retired, and `/download` is the site's primary conversion surface.

There is no billing code of any kind in the repository — no payment provider, no seat model, no enforced quota beyond the in-memory daily token counter. Before the next launch push, decide what is actually free in a cloud-authoritative product and rewrite the pricing page around it. The extension is the natural free surface; the workspace is the natural paid one. `apps/corp` is also the only app with no test framework at all.

---

## 4. Long-term vision — governed delivery, not another AI coding tool

The original positioning, "VS Code for the whole team", described a two-persona desktop application. That product was cancelled in August and its replacement has not been named. The codebase has already chosen a better one.

The competitive ground for AI coding assistants is settled, and this product does not sit on it. It ships no model, no agent runtime and — after ADR 0019 — no editor. What it does own is the thing those tools deliberately skip: the record of how a business requirement became running software, who approved each step, which compliance regime governed the plan, which tasks entered which build, and where that build is serving. That is a governance and auditability product wearing a planning-tool interface, and it should be sold as one.

### 4.1 The market signal already in the code

The managed model is Typhoon (`managed_model_base_url = "https://api.opentyphoon.ai/v1"`), a Thai large language model. Two of the six templates in `app/policies/registry.py` are `thai-pdpa` and `thai-law`. `apps/corp` is fully bilingual with exact EN/TH parity across every page, article and blog post. This is a Thai and Southeast Asian regulated-market play that none of the English-language vision documents state out loud.

It is worth committing to rather than hedging. Regulated buyers in that market need exactly what this product accidentally built: a defensible audit trail, data residency they choose, and no obligation to send source code to a foreign model vendor.

Bring-your-own-everything then stops being a cost story and becomes a compliance story. Code never leaves the customer's Git host. Source is never persisted at rest in the retrieval index ([ADR 0011](./decisions/0011-cloud-workspace-rag-assistant.md) — `CodeChunk` has no `content` field, by design). One deployment template is a plain Docker Compose stack on a server the customer owns, reached over SSH. A bank or a hospital can adopt this without a data-transfer review, and that is an argument no foreign competitor can match locally.

### 4.2 Four bets worth funding

**Compliance as the product, not a prompt prefix.** Policy templates today inject text into a generation prompt and a seeded `docs/policy-scope.md`. The next step is evidence: which requirements a regime touched, which controls a plan satisfies, and an export a regulator or an auditor accepts. Organisation-custom templates (`ws:<uuid>` namespacing) are already designed for and unbuilt.

**The delivery evidence graph, completed.** Unify the two task-reference grammars, make regeneration reconcile instead of append, and freeze build attribution once rather than recomputing it on every terminal redelivery (review finding 12). Then the chain from requirement to live preview holds under audit, which is what makes it sellable rather than merely impressive.

**Reach every editor through one small server.** ADR 0019's decision 3 — an MCP server as the portable second channel — was never built; there is no MCP reference anywhere in `apps/`. It is a small artifact over the same cloud API, and it gives developers in JetBrains, Neovim and Zed their assigned tasks, project rules and task closing without a second interface to design or maintain.

**Deployment templates as the extension point.** Adding one is a directory plus a registry entry, and the three-valued `credential_owner` already covers customer, platform and host ownership. This is the cheapest surface to grow and the one that widens which project types the platform can carry all the way to a live preview.

### 4.3 What this means for the two-persona ambition

It survives, but the seam moved. The roadmap put it at the Skill stage inside one desktop window. It now sits between two applications: business users live entirely in the browser, developers live entirely in their editor, and neither installs the other's tool. That is a cleaner product than the one the roadmap describes, it removes the "two-persona product is hard to keep coherent" risk that roadmap §8 flagged, and it is the one that already exists.

The honest comparison is therefore not Cursor or Copilot. It is a requirements tool, a project tracker and a compliance binder, collapsed into one system where the evidence is generated by the work rather than assembled afterwards.

---

## 5. What to stop

- **Both desktop shells**, including the Theia planner extension that ADR 0016's M3 would have built.
- **The local Spec Kit stage runner** and its templates. Two implementations of one workflow exist and only the cloud one runs.
- **ClickUp.** It is registered and configurable, but `_outbound_auth` (`apps/cloud/app/api/integrations.py:62`) supplies only Jira credentials and `_webhook_secret` (`:40`) only Jira's signing secret, so every outbound call fails and every inbound verification receives an empty secret (review finding 14). Hide it or finish it; a provider catalogue that promises what the runtime cannot execute is worse than a shorter catalogue.
- **OCR for scanned documents.** `StubOcrProvider.extract_text` intentionally raises `NotImplementedError`, so scanned-PDF uploads fail predictably. Surface the limitation in the interface rather than leaving it to discovery.
- **Per-stage model routing.** Migration `0015_stage_model_routing.sql` shipped, `generation/routing.py::select_model` is a pass-through that returns its argument, and ADR 0013's 2026-07-25 update already dropped the idea. Remove the remains.

---

## 6. Open questions for the deciders

1. **Is the desktop retired or funded?** Everything in §3 branches on this, and the ADRs cannot stay Proposed while the code behaves as though they were accepted.
2. **What is free?** The current answer describes a product being deleted. The extension and the workspace are the two candidate boundaries.
3. **Is Thailand and Southeast Asia the stated market, or an implementation detail?** The code says the former and the English documentation says neither. Committing changes what §4.2's first bet is worth.
4. **Does `apps/engine` survive at all?** ADR 0019 moves the surviving logic into the extension host as ordinary modules and retires the sidecar, the gateway and the Anthropic façade. That is a deletion of roughly two thousand lines that nobody has scheduled.
