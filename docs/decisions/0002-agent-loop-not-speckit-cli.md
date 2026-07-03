# ADR 0002 — Minimal agent loop over Spec Kit document templates (gap G1)

**Date:** 2026-07-03 · **Status:** Accepted (skeleton) — the plan's "G1 crucible".

## Finding
Spec Kit is **not a callable engine**. Its command files (`templates/commands/specify.md`, vendored in `apps/engine/src/agent/templates/`) assume a full coding-agent harness: shell scripts (`create-new-feature.sh`), `$ARGUMENTS` substitution, multi-turn tool use. The architecture doc's "Spec Kit Runner" component cannot be built as originally drawn.

## Decision
The engine ships its own minimal loop (`apps/engine/src/agent/loop.ts`): the vendored **document templates** (`spec-template.md`, `plan-template.md`) become the system prompt; the model returns files as ` ```file:<path> ` fenced blocks; the engine writes them into the project workspace and commits. Single-turn, no tool-calling, provider-agnostic — works with any BYO chat model.

## Consequences
- Scope→`specify` and Spec→`plan` are honest re-implementations of Spec Kit's *intent*, not invocations of Spec Kit itself. Coupling risk to Spec Kit's evolution (architecture §5) is now limited to template drift.
- Tasks (gap G2) still have no producer; the Skill stage will own `tasks`-generation when implementation lands.
- Validated end-to-end against a mock provider. **Quality with real BYO models is still unproven** — run the walkthrough with Ollama/OpenRouter before declaring Phase 1 feasible; if weak models can't fill the template, escalate to a multi-turn loop or an external agent-CLI fallback.
