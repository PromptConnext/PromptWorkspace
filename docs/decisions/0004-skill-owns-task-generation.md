# ADR 0004 — Skill stage owns task generation (gap G2)

**Date:** 2026-07-04 · **Status:** Accepted.

## Decision
The Skill stage is more than configuration: after the spec gate passes, it runs Spec Kit's **tasks template** through the agent loop (`POST /engine/projects/:id/tasks`) and ingests the resulting `- [ ] T### [P] …` checklist lines as `Task` rows under the latest SpecDocument. The `[P]` parallelizable marker and T-number are kept in `feature_tag`. Regeneration replaces the spec's tasks (they are `todo`-only until implementation lands).

Task breakdown is planning work, so it uses the `plan`-role model; the `code`-role model stays reserved for implementation execution — still the next milestone, and still prompted just-in-time in the Skill panel.

## Consequences
- The task graph's Requirement → Spec → Task chain is now fully populated end-to-end; `tasks.md` is committed to the project repo like the other stage outputs.
- Parsing depends on the checklist shape; the driver prompt pins it explicitly. If real models drift from it, harden `parseTaskLines` before blaming the model.
