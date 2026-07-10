# Overnight Loop Spec — PromptZone

> An autonomous overnight loop that ships mechanically-safe changes and queues
> everything else for a 5-minute morning review. Never does anything irreversible.
>
> **First target:** all of `apps/*` (desktop + cloud), treated as one platform.
> **Stage:** pre-production — no live data, no deploy-on-merge.

---

## The governing principle

> **Auto-ship only changes whose correctness is mechanically verifiable by tooling
> and whose failure mode is developer-visible (CI / build / lint). Queue anything
> that depends on semantic understanding of the application's behavior — even if it
> seems low risk.**

A linter can prove it → ship. A human has to understand what the code *means* → queue.

---

## The four phases

### PHASE 1 · TRIAGE
Scan `apps/*`. Find candidate work. Classify each candidate against the governing
principle into **auto-ship** or **queue**. Rank by value-high / risk-low so the best
work (and the best queued suggestions) come first. Output the plan before doing work.

**Auto-ship categories** (mechanically verifiable, failure is CI/build/lint-visible):
- Lint / format — `ruff`, `black`, `prettier`, `eslint --fix` (pure formatting, no logic rewrite)
- Unused-import removal — tool-flagged only (`ruff F401`, `eslint no-unused-vars`)
- Import sorting / ordering
- Type annotations — **only where the type-checker infers and verifies them**

**Queue categories** (semantic judgment required, even if trivial-looking):
- "Dead" code not tool-proven dead (reachable-but-unused)
- Doc / README / comment / typo fixes
- Test *additions* (encodes an assumption about intended behavior)
- Dependency bumps — even patch-level (transitive change isn't lint-visible)
- TODO / comment cleanup
- Anything touching migrations, DB layer, auth, or the API contract that isn't a pure formatter pass

### PHASE 2 · MAKER
Do the auto-ship work, **one change at a time**. Each change stays within a single
category and does not mix concerns.

### PHASE 3 · CHECKER
A change ships **only if every gate is green**. Any failure → it queues instead.

**Preconditions (both must hold):**
1. **Baseline-green** — the relevant gate is already green *before* the loop touches
   anything. If `pytest` (or any gate) is red on the branch base, categories that
   depend on it cannot auto-ship — you can't prove the loop didn't break it.
2. **Diff-scope check** — the change touched only files consistent with its claimed
   category. A "lint" change that edits a `.sql` or `.env` file auto-queues + flags.

**Gates — `apps/cloud` (Python / FastAPI):**
- `ruff check .` — clean
- `black --check .` — clean
- `mypy` / `pyright` — clean (where a type gate is run)
- `pytest` — full suite green

**Gates — `apps/desktop` (Tauri — TS + Rust):**
- `eslint` / `prettier --check` — clean
- `pnpm build` / `tsc --noEmit` — clean
- `cargo check` / `cargo clippy` / `cargo test` (in `src-tauri`) — clean

**Rule:** baseline-green → apply → all gates green → diff-scope clean → **ship**;
any failure → **queue**.

### PHASE 4 · GUARD
Commit shipped work to a **dedicated loop branch**. Leave `main` untouched.
Never push. Never deploy. Never touch `.env` / secrets. Hand over the morning queue.

---

## Hard stops (non-negotiable)

**Universal:**
- Never push
- Never deploy
- Never force-push
- Never touch a sibling repo
- Never rewrite git history (no branch deletes, no tag changes, no rebases of shared history)
- When uncertain → **queue, don't act**

**PromptZone-specific (this stage):**
- **Never modify `.env` / secrets / keys / tokens** — the one file-level fence.

*Note:* At this pre-production stage, no other file-level fences are set. Migrations,
DB layer, auth, and the API contract are **eligible** files — but per the governing
principle they only auto-ship if a *formatter/linter* produced the change. Anything
requiring semantic understanding (e.g. authoring `0002_soft_delete.sql`) still queues.
Loose on files, strict on semantics. Revisit these fences the moment there is
production data.

---

## Aggression per app

| App | Dial | What auto-ships | What queues |
|-----|------|-----------------|-------------|
| `apps/cloud` (Python) | **Loose** | Full auto-ship list: format, lint, tool-flagged unused imports, import sort, inferred type annotations | Everything Q2 marks semantic |
| `apps/desktop` (Tauri TS+Rust) | **Loose** | Full auto-ship list (incl. `cargo fmt`, `eslint --fix`, `prettier`) | Everything Q2 marks semantic |

The semantic line (Phase 1) is the only brake. No per-app fences beyond `.env`.

---

## Morning review — the queue

**Location:** one markdown file per night, committed to the loop branch:
`docs/overnight/QUEUE-<date>.md`.

**Top summary line (one sentence):**
> `N shipped · M queued · baseline was green · 0 hard-stops hit`

**SHIPPED section** (already committed — you're just auditing; collapsed by default):
- One line each: `category · files touched · gates passed · commit SHA`

**QUEUED section** (where your 5 minutes goes — ranked highest-value / lowest-risk first):
Per-item card:
- **What** — one-line description
- **Why queued** — which rule sent it (semantic / hard-stop-adjacent / gate-failed)
- **Proposed diff** — the actual patch, ready to apply
- **Blast radius** — files + what it touches
- **Verdict** — apply / skip / defer

Ranked so if you only clear 3 items, you cleared the best 3.

---

## Morning-review checklist (5 minutes, over coffee)

1. **Read the summary line.** Baseline green? Zero hard-stops hit? If either is off — stop and read why before anything else.
2. **Glance the SHIPPED count.** Expand only if a number looks wrong (e.g. more files than a formatter should touch).
3. **Spot-check one shipped diff** at random — confirm it's genuinely mechanical.
4. **Work the QUEUE top-down.** For each card: apply / skip / defer. Trust the ranking — stop when your coffee's done; the rest stays queued.
5. **Confirm `main` is untouched** and nothing was pushed (`git log main`, `git status`).
6. **If anything smells off** — the loop tightens, not loosens. Move the offending category to queue-only for the next night.
