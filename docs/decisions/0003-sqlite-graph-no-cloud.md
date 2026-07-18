# ADR 0003 — SQLite task graph, zero cloud in the skeleton (gaps G3–G5)

**Date:** 2026-07-03 · **Status:** Accepted (skeleton).

## Decisions
- **G4 — local persistence:** the task graph lives in SQLite (`node:sqlite`, no native deps) at `~/Library/Application Support/PromptConnext/promptconnext.db`, schema mirroring architecture §3.1 (`apps/engine/src/db.ts`). Cloud sync later becomes a projection of this schema, not a migration.
- **G5 — no cloud:** the skeleton and Phase 1 have no identity, sync, or collaboration. The local engine is the sole source of truth — consistent with the offline requirement in architecture §4.
- **G3 — project bootstrap:** `POST /engine/projects` with a name creates `~/PromptConnext-Projects/<slug>`, git-inits it, and seeds the three stage states. The business persona never touches Git; every stage output is committed by the engine.
