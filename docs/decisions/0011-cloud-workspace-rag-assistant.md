# ADR 0011 — The cloud becomes a product pillar: collaborative web workspace + RAG project assistant

**Date:** 2026-07-11 · **Status:** Proposed · **Deciders:** product + engineering
**Amends:** the "thin cloud" posture of ADR 0003 / ADR 0010 and architecture doc §2.1 ("does not run models, store credentials, or hold source code"). **Does not reverse** the hybrid deployment shape — the desktop app remains the authoring/execution surface.
Prompted by the question: *what do collaborators and business stakeholders actually get from PromptZone Cloud beyond sync?*

## Context

`apps/cloud` today is a headless sync/collaboration API: task-graph sync (ADR 0010), workspaces + membership + RLS (plan 0001), per-field conflict ownership, the Jira/ClickUp mirror, and presence (plan 0002). Stakeholders without the desktop app see the project only through the tracker mirror — status fields, not understanding. Sync alone is also commercially weak: it's plumbing, not a product.

Meanwhile the cloud already holds a uniquely good substrate for grounded AI answers: the task graph with full lineage (**requirement → spec → task → artifact → agent-run**). Generic "chat with your docs" products retrieve over flat documents; PromptZone can answer "why does this task exist?" by *walking provenance*, then ground the prose with vector retrieval over the artifact text.

Forces in tension:

- Architecture §2.1's pivotal decision keeps compute, model keys, and code on the user's machine. A cloud assistant needs a model to run somewhere, and "the codebase" as a knowledge source appears to violate "no source code in the cloud."
- BYO-model is a core identity, not a cost hack. Any cloud inference must stay BYO.
- Retrieval that ignores workspace membership is a cross-tenant leak. Security scoping must be structural, not a filter bolted on after similarity search.

## Decision

Make the cloud a **first-class product pillar** with two surfaces, phased so v1 requires no change to what data the cloud stores:

1. **Collaborative web workspace** (`apps/web`, new) — join workspaces, browse projects and the requirement→spec→task→artifact graph, track progress across the SDLC. Read-first; authoring stays in the desktop app.
2. **RAG project assistant** — natural-language Q&A grounded exclusively in project artifacts, with citations back to graph nodes. **v1 sources:** requirements, PRDs/specs, architecture docs, tasks, discussions — everything *already synced*. **v2 sources:** pull requests and the codebase, via Git-host integration (below).

Three amendments to the §2.1 posture, each deliberately narrow:

- **"No models" → workspace-BYO models.** A workspace admin connects the team's model key (chat + embedding). Keys live in the server secret store (same handling as Jira credentials — env/secret manager, never in Supabase rows). Personal keys stay in the local keychain; the cloud never sees them.
- **"No credentials" → no *end-user* credentials.** Workspace-level service credentials (model key, Git-host app token) are held server-side; this is the same class of secret the Jira mirror already required.
- **"No source code" → no source code *at rest*.** For v2, the cloud stores **embeddings + chunk references** (repo, path, SHA, line range) only, fetching raw chunks on demand from the team's Git host with the workspace's token. The code already lives in a cloud the team chose (GitHub/GitLab); PromptZone indexes it, it does not become a second copy of record.

Retrieval is **membership-scoped before similarity**: every vector query is filtered to the caller's workspace/project (RLS + explicit predicate) ahead of nearest-neighbour search, mirroring how sync scopes reads today.

## Options considered

### A. Status quo — thin cloud + tracker mirror only

| Dimension | Assessment |
|---|---|
| Complexity | None |
| Product value | Low — stakeholders get status fields, not answers |
| Architectural purity | Perfect |

**Pros:** zero new surface, zero new secrets. **Cons:** cloud remains unmonetisable plumbing; the lineage graph's value stays locked inside the desktop app.

### B. Cloud pillar, phased RAG (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium — pgvector, ingest hook, chat API, new web app |
| Product value | High — grounded Q&A is the differentiator; graph lineage is the moat |
| Architectural purity | Amended, not broken — v1 stores nothing new; v2 stores embeddings only |

**Pros:** v1 ships on existing data and infra (Supabase pgvector, existing sync upsert path); clean BYO story at workspace level; web UI finally answers "what do stakeholders get." **Cons:** cloud now runs inference calls and holds team-level secrets; embedding pipeline is new operational surface.

### C. Full web app (cloud executes everything)

Already rejected in architecture §2.2 option A: breaks local Ollama, local Git, and the privacy/BYO story. Revisited and rejected again — nothing in this decision requires it.

### Codebase-source sub-options (for v2)

1. **Exclude code entirely** — v1 does this; insufficient long-term (PR/code questions are half the engineering value).
2. **Index via Git host, embeddings + refs only, fetch-on-demand** (chosen for v2) — no code at rest, uses the team's existing trust boundary.
3. **Desktop embeds locally, syncs vectors** — preserves purity best, but ties index freshness to one developer's machine being online and duplicates the pipeline per-OS. Kept as a fallback for teams whose Git host is unreachable from the cloud.

## Trade-off analysis

The real choice is between **architectural purity** (A) and **product viability** (B). The purity being defended — user code and keys never leave the user's machine — is preserved in what matters: *personal* keys stay local, code is never stored at rest, and v1 doesn't change the data footprint at all. What's given up is the slogan's simplicity; what's gained is the reason a team pays for the cloud. Option B's phasing also de-risks: if v1 (artifacts-only RAG) doesn't earn usage, v2's Git integration and its secret-handling burden never get built.

## Consequences

- **Easier:** stakeholder value story; monetisation; the read-only web UI decision (chat is its first surface); future features (search, notifications, dashboards) inherit the web app.
- **Harder:** ops — embedding ingest adds load to the sync path (make it async; never block an upsert on an embedding call); the single-instance constraint (plan 0002 M7) gets pressure sooner, though chat itself is stateless; secret management gains model + Git-host keys; prompt-injection via artifact content becomes a real (if low-severity, read-only) concern — the assistant must treat retrieved text as data, not instructions.
- **Revisit:** shared backplane (Redis) before any horizontal scale; retrieval quality evals once real usage exists; whether `pmo`-mirrored discussions (Jira comments) enter the index (they're third-party content — default out, workspace opt-in).

## Action items

1. [ ] Accept/revise this ADR
2. [ ] Plan `docs/plans/0005-cloud-workspace-rag-assistant.md` — milestones M8–M11 (companion to this ADR)
3. [ ] Update architecture doc §2.1 wording ("no code *at rest*, workspace-BYO models") once accepted
4. [ ] Spike: pgvector on the existing Supabase project — index size + query latency on a realistic graph
