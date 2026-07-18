# ADR 0010 — Task-graph sync model: cloud hub, push/pull projection, manual trigger, last-write-wins

**Date:** 2026-07-05 · **Status:** Accepted (model of record; implementation phased). Extends ADR 0003 (which deferred all cloud sync and said "cloud sync later becomes a projection of this schema"). Prompted by the question: *the local SQLite graph isn't shared with the team — it syncs only when the user pushes to the cloud, correct?*

## Context

Per ADR 0003, each desktop engine owns a local `node:sqlite` task graph that is the **offline source of truth** — it must keep working with no network. That raises the question this ADR answers: how, and when, does one engine's graph become visible to the rest of the team.

## Decision

**1 — Hub-and-spoke through the cloud, not peer-to-peer.** Every engine has its own local graph; PromptConnext Cloud holds the **shared** copy. A user's changes reach teammates only after they travel *up* (push) to the cloud, and teammates' changes reach that user only after they come *down* (pull). Convergence is always through the cloud hub; engines never talk directly to each other.

```
Engine A (sqlite) --push--> Cloud graph <--pull-- Engine B (sqlite)
                 <--pull--             --push-->
```

**2 — The cloud graph is a projection of the local schema.** Same entities as architecture §3.1 / ADR 0003 (projects, requirements, spec documents, tasks, agent-runs, stage states). Implemented in `apps/cloud`: `PUT /sync/projects/{id}/graph` pushes a delta, `GET /sync/projects/{id}/graph?since=<cursor>` pulls what changed. The server stamps `updated_at` on every write; that timestamp is the incremental-pull cursor.

**3 — Trigger is manual for v1 (Git-like).** Sync happens on an explicit user push/pull, not continuously. It is predictable, matches the developer mental model, and sidesteps concurrent-edit conflicts while the product is young. **Automatic background sync** (debounced push + periodic pull) is deferred until the conflict story (decision 4) is hardened.

**4 — Conflict policy is last-write-wins by `updated_at` for v1.** Adequate under manual, low-contention sync. The refinement — **per-field ownership** (PromptConnext authoritative for AI-native fields: agent-runs, artifacts, spec traceability, acceptance criteria; external trackers authoritative for PMO fields: assignee, sprint) — lands together with auto-sync and the Jira/ClickUp mirror, per the task-management memo. LWW is knowingly lossy under concurrent offline edits; that is accepted until then.

**5 — Sync boundaries.** Only the **task graph** flows through this path. Model **credentials never sync** (they stay in the local OS-keychain vault — architecture §2.3). **Source code does not sync here** either — it goes through Git (ADR 0003 G3). The cloud makes no model calls and stores no code.

**6 — Offline-first.** The engine works fully offline; when disconnected, deltas queue locally and flush to the cloud on reconnect. A cloud outage never blocks local work.

## Consequences

- The user's instinct is correct and by design: a graph is **not** shared with the team until a sync occurs. "Local-first, sync on demand" is the intended behaviour, not a gap.
- Manual trigger keeps v1 simple; the cost is that collaboration feels turn-based rather than live until auto-sync ships.
- LWW can drop a concurrent edit — acceptable for now, but **per-field ownership must precede auto-sync** to avoid silent data loss.
- **Dependency:** sync requires identity to scope projects to a team. ADR 0003 G5 shipped no auth; the cloud API currently stubs identity via an `X-User-Id` header and is owner-only. Real Supabase Auth + Row Level Security is the prerequisite milestone before multi-user sync is safe.
- The cloud stays thin (a projection + collaboration hub), preserving the privacy posture: compute, keys, and code remain local; only the shared graph leaves the machine, and only when the user pushes.
