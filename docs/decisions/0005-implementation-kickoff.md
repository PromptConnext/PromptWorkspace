# ADR 0005 — Implementation kick-off: single-shot codegen per task

**Date:** 2026-07-04 · **Status:** Superseded as the primary path by ADR 0009 — now the **fallback only** (used when no agent CLI is available). Not invested in further. The "multi-turn tool loop" upgrade path noted below is **cancelled**: external coding agents (ADR 0009) provide that loop.

## Decision
`POST /engine/tasks/{id}/run` (architecture §3.2) implements one task at a time:
- **Strict `code`-role routing** — no fallback to the planning model. If no verified coding model exists, the run is refused with a pointer to the Skill stage's connect prompt. This is the connect-two rule enforced where it matters.
- **Context = repo snapshot**: full `git ls-files` listing plus contents of small files (≤8 KB each, ~40 KB budget). The model returns complete files as ` ```file: ` blocks; the engine writes them, commits, and records an `Artifact` per file with the commit SHA plus an `AgentRun` whose evidence names the commit. Task status: `todo → running → done|failed`.

## Consequences
- The 3S loop is now end-to-end real: requirement → spec → tasks → code, every step traceable in the graph with Git evidence.
- Single-shot codegen cannot read files interactively or run tests; it degrades on large repos (listing-only beyond the budget) and trusts the model to write complete files. The known upgrade path is a multi-turn tool loop (read/write/run) — the same G1 evolution flagged in ADR 0002. Build it when real-model dogfooding shows single-shot quality is the binding constraint.
- Failed runs leave the task `failed` and the workspace uncommitted changes untouched for inspection; re-running overwrites.
