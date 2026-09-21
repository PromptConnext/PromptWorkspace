# ADR 0028 — Keep `apps/desktop`, retarget it to business users; retire only the Theia shell

**Date:** 2026-09-21 · **Status:** **Accepted 2026-09-21** · **Deciders:** product

> **Accepted 2026-09-21.** Partially reverses [ADR 0019](0019-desktop-as-vscode-extension.md) decision 2. `apps/desktop-theia` is still retired — nothing in this ADR touches the unsigned-macOS argument that motivated its deletion. `apps/desktop` (the Tauri shell) is **not** deleted; its target audience changes from developers, now served by `apps/vscode` + the MCP server (plan 0025, M1–M3 shipped), to business users. **The concrete shape of that business-user surface is undecided.** This ADR records the direction, not a spec. Do not resume engineering work on `apps/desktop` against this ADR alone — a follow-up plan must define what the app actually does before code changes land.

**Prompted by:** now that `apps/vscode` fully covers the developer job ADR 0019 narrowed `apps/desktop` down to — task list, status sync, coding-rules display, AI-assistant handoff — deleting the Tauri shell outright throws away a native app shell for a persona `apps/web` currently serves only in-browser. Is there a role for a native desktop surface aimed at business users instead of developers?

**Answer: yes, directionally.** `apps/desktop` survives, but repointed at the persona ADR 0019 explicitly moved *off* the desktop ("the business persona is not on the desktop at all — they are in `apps/web`"). What that surface does, and how it relates to `apps/web`'s existing Planner (PRD upload, stage generation, project creation, the Planner/Graph/Tasks/Progress/Discussion/Preview tabs), is an open question — see below.

---

## What this ADR changes, precisely

**Unchanged from ADR 0019:**
- Decision 1 (developer experience lives in `apps/vscode`, no sidecar) stands.
- Decision 3 (MCP server) stands — plan 0025 M1–M3 are shipped.
- `apps/desktop-theia` retirement stands. Its argument was never about audience — it was the live, unmitigated authenticity gap on its macOS update channel (ADR 0011 §3: no Apple Developer ID, no notarization, only a same-origin sha512 checksum). That risk exists independent of who `apps/desktop` serves, and closes by deletion regardless of this ADR.
- The engine-surface analysis in ADR 0019 (`apps/engine/src` table, "Dead — local planning the cloud now owns," ~2,000 lines) is **not** overturned by this ADR. Those routes (`agent/loop.ts`'s `runStage`/`runImplementation`, the Spec Kit templates, `gateway/index.ts`, `routes/models.ts`, `routes/onboarding.ts`) were dead because the cloud now owns planning, not because `apps/desktop` was being deleted. A business-user surface gets its planning capability from the cloud API — the same way `apps/web` does today — not from local engine machinery. **Whoever scopes the follow-up plan should assume that engine surface stays dead**, and confirm rather than re-litigate it.

**Changed:**
- `apps/desktop` (Tauri shell, React 18 webview) is not deleted. Its current content — the narrowed developer-facing task list, status sync and coding-rules display ADR 0019 described — is not necessarily what it becomes; that content was built for the persona that no longer uses it.
- Plan [0011](../plans/0011-desktop-decision-gate.md)'s Branch A ("retire both shells") is superseded for `apps/desktop` specifically. Branch A's Theia-specific steps (§4 items 1–3, adjusted) still apply. Branch A's item 4 ("delete `apps/desktop`") does not.
- `.github/workflows/desktop-build.yml` (the Tauri CI matrix) stays. `.github/workflows/desktop-theia-build.yml` and `.github/workflows/theia-spike-windows.yml` are retired, per the still-standing Theia decision. Plan [0021](../plans/0021-operational-floor.md) M1 is scoped down accordingly: `ci.yml` lands alongside `desktop-build.yml`, not in place of it.

## What's explicitly open

- **The feature set.** Is this a native wrapper around the existing `apps/web` Planner (a webview pointed at the web app, for users who want a desktop icon over a browser tab — cheapest, least product risk, most likely first cut), or does it carry capabilities `apps/web` doesn't or won't have (offline drafting, local file handling, native OS integration)? Undecided.
- **Overlap with `apps/web`.** If the feature set duplicates the Planner, does `apps/web`'s business-facing surface stay as the primary product with desktop as a thin distribution wrapper, or does capability move between them? Undecided — and this determines whether any of `apps/desktop`'s current React code survives versus starting over.
- **Whether it needs a sidecar at all.** ADR 0019's core argument against a sidecar (`deactivate()` timeouts, orphaned processes, ABI mismatches) was specific to the VS Code extension host. A standalone Tauri app doesn't have that problem, but a thin wrapper around `apps/web` likely needs no local process either — it would talk straight to `apps/cloud`, the same way `apps/vscode` does now. Default assumption for the follow-up plan: no sidecar, no local engine, same as the developer surface's own conclusion, unless a concrete feature requires one.
- **Naming/positioning** on `apps/corp` — its `/download` page and pricing copy currently describe `apps/desktop` in developer-adjacent terms (`docs/decisions/0011...`'s §2 notes `apps/corp/src/content/pages.ts:38` sells "the full desktop app, forever" as a developer offering). That copy needs to change once the business-user shape is decided; not scoped here.

## Consequences

- **Positive:** `apps/desktop`'s CI matrix, code-signing setup and R2 release pipeline are not thrown away only to be rebuilt later if a native business-user app turns out to be wanted; the unsigned-macOS *Theia* channel still closes by deletion.
- **Negative / accepted trade-off:** `apps/desktop` continues carrying its now-stale developer-oriented UI and CI until a follow-up plan replaces it — a live app with no current product direction is itself a cost (the same "frozen shell with no owner" argument ADR 0019/plan 0011 made against keeping it, now re-accepted deliberately rather than by neglect). Whoever picks this up should scope the follow-up plan promptly rather than let `apps/desktop` sit in this ambiguous state indefinitely.
- **Documentation debt, tracked:** ADR 0019's banner, plan 0011, `CLAUDE.md`'s retirement notice, and plan 0021 M1 all described "retire both shells" as settled; this ADR is the correction. Downstream docs are updated in the same change that introduces this ADR — see the commit this file ships in.

## Notes for the implementing agent

- **Do not build UI for `apps/desktop` against this ADR alone.** It records a direction, not a spec. The first real step is a follow-up plan that answers the "what's explicitly open" questions above.
- `apps/desktop-theia` deletion (plan 0011 §4, items 1–3, Theia-specific parts) is unaffected and should proceed on its own schedule — it does not depend on the business-user shape being decided.
- When the follow-up plan lands, revisit plan 0012 (close-the-write-path): if the business-user surface talks straight to `apps/cloud` with no local engine (the default assumption above), plan 0012's M2–M5 remain irrelevant to `apps/desktop` for the same reason they were irrelevant under retirement — there is no local task cache to align, because there is no local engine.
- `apps/corp`'s `/download` page keeps working exactly as today (it already falls back to "coming soon" if `NEXT_PUBLIC_DOWNLOAD_BASE_URL` is unset, per `CLAUDE.md`'s Corp section) — no urgency to touch it before the follow-up plan defines what's being downloaded.
