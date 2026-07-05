# PromptZone — Design System & Component Library: Build Plan

**Date:** 2026-06-29
**Reference:** the uploaded `design-system` skill (`.claude/skills/design-system/SKILL.md`), derived from the Claude artifact `PromptZone_Platform.jsx`. It provides tokens + system rules, not screens.
**Scope (agreed):** design system + components first — the reusable foundation the PromptZone client is built on.
**Companion:** [`promptzone-platform-architecture.md`](./promptzone-platform-architecture.md) · [`promptzone-diagrams.md`](./promptzone-diagrams.md)

---

## 1. Intent (one sentence)

Turn the reference tokens and rules into a **tokenized, accessible, implementation-ready React component library** that both the business and developer surfaces of PromptZone consume, so every screen is consistent by construction rather than by convention.

---

## 2. What the reference gives us (and its gaps)

**Given tokens** (dark theme): `Anthropic Sans`, base 14px / weight 500; type steps 12/14/16; colors — text `#f8f8f6 / #c3c2b7 / #2c2c2a / inverse #fff`, surfaces `#000 / #1f1f1e`, borders `#e2e1da / rgba(255,255,255,.1)`, focus ring `#5599e7`; spacing `8 / 10 / 16`; radius `6px`; motion `100 / 150ms`. Rules: WCAG 2.2 AA, keyboard-first, focus-visible mandatory, every component defines default/hover/focus-visible/active/disabled/loading/error, no one-off exceptions.

**Gaps to resolve during Phase 0** (the reference is partial/auto-extracted — flag, don't guess silently):
- **Contrast risk:** `text.tertiary #2c2c2a` on `surface.base #000` is ~1.1:1 — unreadable. It's likely a *disabled-on-light* or *inverse* token, not body text on black. Must validate every text/surface pair against AA before locking.
- **Sparse scales:** only 3 spacing steps, 1 radius, 3 type sizes. We must **extend to a full scale** (e.g. spacing 2/4/8/12/16/24/32; radius sm/md/lg) using the given values as anchors, without inventing a new visual language.
- **No semantic status colors** (success/warning/danger/info) — required for task/agent-run states. Must be added and AA-checked.
- **Light theme unspecified.** Reference is dark-only. Decide whether to ship dark-first now and defer light (recommended) or define both.

---

## 3. Recommended technical approach

| Choice | Recommendation | Why | Trade-off |
|---|---|---|---|
| **Framework** | React + TypeScript | Reference is `.jsx`; matches a TS desktop client | — |
| **Accessible primitives** | Radix UI (headless) | The mandated states (focus-visible, keyboard, disabled, dialog focus-trap) are exactly what Radix solves; don't hand-roll a11y | Extra dep; must style from scratch (fine — we own the tokens) |
| **Styling** | CSS variables for tokens + Tailwind mapped to those vars | Tokens become the single source of truth; Tailwind gives ergonomics without hardcoded values | Tailwind config must be token-locked (lint against raw hex) |
| **Workshop / docs** | Storybook + `@storybook/addon-a11y` (axe) | Every component's 7 states become visible, testable stories; a11y checked in CI | Setup cost |
| **Location** | `packages/ui/` in the PromptZone repo (consumed by the desktop client app) | Shared library, versionable, not tied to one app | Introduces a light monorepo layout |

Net: **tokens → CSS vars → Tailwind + Radix components → Storybook (with axe) → consumed by the client.** No raw hex in components (enforced by lint), per the reference's "semantic tokens only" rule.

---

## 4. Token layer (Phase 0 output)

1. `tokens.json` — the canonical semantic tokens (extended per §2), the one source of truth.
2. Generated `tokens.css` — `:root` (and `[data-theme]`) CSS custom properties.
3. Generated `tokens.ts` — typed constants + a Tailwind preset consuming the CSS vars.
4. A **contrast report** — every text/surface and border pair validated at AA; failures reassigned before lock.

Naming stays semantic (`--color-text-primary`, `--space-3`, `--radius-md`), never raw values in components.

---

## 5. Component inventory

**Primitives (build first — everything depends on them):**
Button (variants: primary/secondary/ghost/danger), Input, Textarea, Select, Checkbox, Radio, Switch, Card, Badge/StatusPill, Tabs, Dialog/Modal, Toast, Tooltip, ProgressBar, Spinner/Loader, Skeleton, Table, EmptyState, Banner/Callout.

**Domain components (compose primitives into PromptZone's surfaces):**
- **3S flow:** `StageStepper` (Scope→Spec→Skill with gate/approval states), `GateBanner` (blocked/approve).
- **Onboarding:** `ModelConnectionCard` (provider + connection mode), `ConnectionHealthState` (untested/verifying/valid/failed), `ZeroCostPathCallout`.
- **Task graph:** `RequirementRow`, `SpecReviewPanel`, `TaskCard` (with `{text}[]` acceptance criteria — reuse the Ideva Kit shape), `AgentRunEvidence`, `ProgressTimeline`.
- **Shell:** `AppSidebar`, `PersonaSurfaceToggle` (business ↔ developer), `ProjectListItem`.

Primitives are theme/domain-agnostic; domain components encode PromptZone semantics and map 1:1 to the architecture's task graph.

---

## 6. Per-component spec (the contract each must meet)

Every component ships with: **anatomy**, **variants**, **all 7 states** (default/hover/focus-visible/active/disabled/loading/error), **keyboard + pointer + touch** behavior, **token-only** spacing/typography, **overflow/long-content/empty-state** handling, and **testable a11y acceptance criteria** (e.g. "focus ring uses `--color-focus-ring`, visible at 3:1 against adjacent colors; operable via Tab/Shift-Tab/Enter/Esc"). Authored per the skill's required output structure, ending in a QA checklist.

---

## 7. Accessibility & testing strategy

- **Static:** lint rule banning raw hex / one-off spacing in components (enforces "no exceptions").
- **Component:** Storybook stories per state + `addon-a11y` (axe) failing CI on violations.
- **Interaction:** Playwright/Testing-Library for keyboard flows (tab order, Esc-closes-dialog, focus return).
- **Contrast:** automated AA check over the token pairs (§4) in CI.
- **Manual gate:** screen-reader smoke pass on the domain components before release.

---

## 8. Phased build plan

**Phase 0 — Foundations (unblocks everything).** Resolve token gaps + contrast report; ship `tokens.json/css/ts` + Tailwind preset; scaffold `packages/ui` with Radix + Storybook + axe + the no-raw-hex lint. *Exit: a Button rendered purely from tokens, passing axe, in Storybook.*

**Phase 1 — Primitives.** Build the primitive set (§5) with all states, stories, and a11y criteria. *Exit: full primitive library green in CI.*

**Phase 2 — Domain components.** 3S, onboarding, and task-graph components composed from primitives, wired to the architecture's data shapes. *Exit: the onboarding + 3S surfaces assemblable from the library.*

**Phase 3 — Client integration.** Consume `packages/ui` in the desktop client; assemble first real screens; feed learnings back into tokens/components. *Exit: a themed, accessible first screen running against the cloud sync API.*

---

## 9. Deliverables & structure

```
PromptZone/
  packages/
    ui/
      tokens/           tokens.json · tokens.css · tokens.ts · tailwind-preset.ts
      src/
        primitives/     Button, Input, Card, Tabs, Dialog, …
        domain/         StageStepper, ModelConnectionCard, TaskCard, …
        index.ts
      .storybook/
      tests/            a11y + interaction
      README.md
  docs/
    promptzone-design-system-plan.md   ← this file
    design-system-guidelines.md        ← per-component rules (authored alongside build)
```

---

## 10. Open decisions (before Phase 0)

1. **Dark-first only, or dark + light now?** (Recommend dark-first; the reference is dark-only.)
2. **Styling engine:** Tailwind-mapped-to-vars (recommended) vs. CSS Modules vs. a CSS-in-JS lib.
3. **Monorepo tooling:** plain workspaces (pnpm/bun) vs. Turborepo/Nx for `packages/ui` + client + cloud.
4. **Desktop shell (still open from the architecture doc):** Tauri vs. Electron — affects nothing in Phase 0/1 but shapes Phase 3.
5. **Fonts:** is `Anthropic Sans` licensed for use here, or do we substitute a near-equivalent (e.g. Inter) in the stack?

---

## Bottom line

Build **tokens first, primitives second, domain components third, integration last** — with accessibility and "no raw values" enforced in CI from day one. The reference gives a strong dark-theme foundation; the main upfront work is closing its token gaps (contrast, scale extension, status colors) so everything built on top is AA-safe and consistent. Recommended first step: **Phase 0** — I can produce the extended `tokens.json`, the contrast report, and the `packages/ui` scaffold whenever you're ready.

> Note: the uploaded `design-system` skill is the right home for the per-component rules — keep it updated as components are built so it stays the living source of truth (and remind me to reconcile it after each phase).
