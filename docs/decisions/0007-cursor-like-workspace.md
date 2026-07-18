# ADR 0007 — PromptConnext is a Cursor-like workspace; first step: integrated terminal + Git truth-keeping

**Date:** 2026-07-04 · **Status:** Direction accepted; delivered incrementally. Revises the "orchestrator-only" default from the original plan and resolves roadmap open decision (b).

## The vision (user decision)
PromptConnext is a desktop app in the shape of **Cursor**: a VS Code-like workspace where the whole lifecycle happens in one place.
- **Business users** live in the **Agents surface** — the 3S workflow (requirements, spec review, approvals, live progress) — and never see code machinery.
- **Developers** live in an **integrated editor surface** in the same app, implementing however they like (their own agent CLIs — Claude Code, Codex — in the integrated terminal, or editor-side AI), with the same project context and task graph.
- Nobody leaves the app between planning and implementation. Model-capability limits (e.g. a local model that can't tool-call) stop being PromptConnext's problem for implementation: the developer's own tools bring their own models and auth.

## Delivered in this increment
1. **Integrated terminal** — real PTY (`node-pty`) in the project directory over WebSocket (`/engine/projects/:id/terminal`), xterm.js pane as a project tab. This is where developers run their own agents today.
2. **Git truth-keeping** — commits whose subject mentions a task ref (`T003: …`) automatically mark that task `done` and attach the commit as an artifact (scan on graph read). The business persona's live-progress view stays honest with zero tracker upkeep.
3. **Copy context** — per-task paste-ready prompt (task + spec file pointers + the commit-ref convention) for any agent.

## Staged path to the full editor experience (not yet built)
1. **Monaco editor + file tree** inside the existing Tauri shell — Cursor-like layout (files / editor / Agents panel), real code editing, no fork. Recommended next editor step.
2. **VS Code fork or embedded openvscode-server** — full extension ecosystem parity (the actual Cursor approach). Enormous build/maintenance cost; only if Monaco proves insufficient. Note: VS Code is MIT but the Marketplace and branding are not — a fork cannot use Microsoft's extension marketplace terms freely (OpenVSX is the alternative).

## Consequences
- Agent mode (ADR 0006) is demoted to an optional convenience ("run this task for me"); the primary developer path is the integrated terminal/editor with their own tools.
- Roadmap risk #3 ("don't rebuild an editor") is consciously revisited: the terminal is cheap, Monaco is moderate, a fork is the expensive cliff — each step is a separate go/no-go.
- Known gap: node-pty's `spawn-helper` loses its exec bit under pnpm; the engine self-heals it at startup.
