# Plan 0022 — Correct the public positioning and the pricing model

**Date:** 2026-09-12 · **Status:** Decision required, then ready for implementation · **ADR:** [0019](../decisions/0019-desktop-as-vscode-extension.md) + [0020](../decisions/0020-cloud-is-the-source-of-truth.md), both still *Proposed*

This plan implements §3.5 and §4 of the [product vision](../product-vision-2026-09-12.md). [Plan 0003](./0003-marketing-website.md) built `apps/corp` against a locked intake decision — "desktop app **free** (BYO-model, no model tax); **enterprise is contact-sales**", with "**Primary conversion: Desktop download**" — and that is the product ADR 0019 proposes to delete. Every string quoted below was read out of the working tree. M1 waits on §2; M3 and M5 are branch-independent.

---

## 1. What the site says today

Pricing and the FAQ live in one typed module, `apps/corp/src/content/pages.ts`, keyed by locale. The headline at `:32` is **"Free for the desktop app. Enterprise when you need it."**, subtitled "No model tax, ever. Start free, and add enterprise collaboration when your team grows." (`:33`).

**Free** is `$0`, taglined **"The full desktop app, forever."** (`:38`), CTA `Download free` → `/download` (`:39`–`:40`). Its five features (`:43`–`:47`) are, verbatim: "Complete 3S workflow (Scope → Spec → Skill)", "Bring your own model — cloud or local, no model tax", "Local-first task graph with full traceability", "Claude Code, Gemini CLI & custom agent orchestration", "Local & personal workspaces".

**Enterprise** is `Custom`, "For teams that collaborate at scale.", CTA `Contact sales` → `/contact/sales` (`:51`–`:56`), five features at `:58`–`:62`: "Everything in Free", "Shared cloud workspaces & role-based access", "SSO and admin controls", "Two-way Jira / ClickUp status sync", "Priority support & onboarding".

The Thai mirror is a structural clone in the same file: "ฟรี" at "฿0" taglined "แอปเดสก์ท็อปครบชุด ตลอดไป" (`:91`–`:93`), five features at `:98`–`:102` (including "กราฟงานแบบ local-first ตรวจสอบย้อนกลับได้เต็มที่"), and "องค์กร" at "กำหนดเอง" (`:106`–`:107`) with the same five Enterprise lines at `:113`–`:117`.

Two FAQs restate it. At `:71`: "Yes. The desktop app is free forever. You bring your own model, and you pay your model provider directly — PromptConnext never marks up tokens." At `:172`, "The desktop app is free forever…"; at `:176`, "macOS and Windows. Download the desktop app to get started."

Against the product:

| Claim | Verdict |
|---|---|
| "Local & personal workspaces" (`:47`, `:102`) | **False today.** ADR 0015 already requires a cloud identity and workspace membership. |
| "SSO and admin controls" (`:60`) | **False today.** Grepping `apps/cloud/app` and `apps/web/src` for SSO returns only policy-template prose and test fixtures. Role-based access is real; SSO is not. |
| "Two-way Jira / ClickUp status sync" (`:61`, `:116`) | **Half false today.** `_outbound_auth` (`apps/cloud/app/api/integrations.py:61`) supplies Jira credentials only and `_webhook_secret` (`:40`) only Jira's signing secret, so every ClickUp call fails and every inbound verification gets an empty secret. |
| "The full desktop app, forever." (`:38`) · "Local-first task graph" (`:45`) · "Claude Code, Gemini CLI & custom agent orchestration" (`:46`) · "macOS and Windows" (`:176`) | **True, about to become false.** Each describes what ADR 0019 retires. |
| "your source code and model keys stay on your machine" (`:167`) | **Half true, degrading.** Source still never syncs — that is Git's job. Keys do: a workspace BYO connection is Fernet-encrypted into the cloud secret store, and the managed tier holds a platform key. |
| "Complete 3S workflow" (`:43`) · "no model tax" (`:44`) | **Survives**, with one correction — the cloud Planner runs unconditionally on managed Typhoon, so BYO is true of the assistant and untrue of stage generation. |

## 2. The decision this needs first

What is free in a cloud-authoritative product? Two coherent answers, not a menu.

**A — the editor extension and a single-person workspace are free; paid starts at collaboration.** The vision's phrasing, and the closest analogue to the tier being replaced. Easy to explain, keeps a zero-friction developer on-ramp (`apps/vscode` already packages as `promptconnext-vscode` v0.2.0), and the second seat is the upgrade trigger. Its weakness: the extension is the cheap half, and a free solo workspace still runs stage generation on the platform's shared Typhoon key, so the boundary does not bound cost.

**B — planning is free; the paid boundary is the seeded repository, deployment and preview.** Scope, Spec and the task graph cost managed tokens and nothing else. Repository creation, the deployment template, observed CI and the live preview are where the platform holds a credential, writes to a customer's git host and mints per-workspace R2 credentials — real, recurring cost. It also matches §4: what is sold is governed delivery, and those artifacts start at `repo_created`.

The token budget decides this. Managed usage is already metered per workspace per day: `DailyTokenBudget` (`apps/cloud/app/rag/budget.py:22`) keeps an in-process counter, `remaining()` (`:28`) and `record()` (`:34`) roll it at UTC midnight, `estimate_tokens()` (`:43`) is a chars/4 heuristic, and the ceiling is `managed_daily_token_budget: int = 200_000` (`apps/cloud/app/config.py:166`), enforced on every Planner stage at `apps/cloud/app/api/generation.py:84`–`:85` (`429 daily_token_budget_exceeded`) and every assistant turn at `apps/cloud/app/api/assistant.py:299`–`:301`. Two properties matter: the counter is **in-process and single-instance**, so it is not a billing meter; and the cap is per *workspace*, so free workspaces are the unit of abuse.

**Recommendation: B, with a metered free tier.** Free covers Scope, Spec and the task graph for any number of people in one workspace, under a *lower* ceiling than 200,000; paid unlocks repository provisioning, deployment templates and the preview, and lifts the ceiling. B prices what costs money rather than what is cheap to give away, it keeps no seat wall in front of the business user the product is trying to reach, and it is enforceable today by changing one comparison at the two call sites above rather than by building billing. A remains the fallback if sales prefers a seat story. **Record the answer as an ADR before M1 starts.**

## 3. M1 — Rewrite the pricing content

One file: `apps/corp/src/content/pages.ts`. `PricingTier` (`:3`–`:11`) fixes each tier to `name`, `price`, `tagline`, `ctaLabel`, `ctaHref`, `ctaVariant` and `features: string[]` (`:10`); `PricingContent` (`:13`–`:20`) fixes the page to `tiers: PricingTier[]` (`:17`) plus `faqTitle` and `faqs`. Tier count is untyped, so a third tier is a content edit — but `ctaVariant` is a two-value union, so exactly one tier carries the primary button.

**Locale parity is a hard constraint.** `const pricing: Record<Locale, PricingContent>` (`:29`) makes TypeScript require both locale keys and every field within each, so a missing locale or field fails `typecheck`. It does **not** constrain array lengths: a three-tier `en` beside a two-tier `th` compiles clean. The same hole exists at `apps/corp/src/content/product.ts:235` and `apps/corp/src/content/static-pages.ts:429`. M5 closes it, and M1 must not merge first.

Rewrite in the same commit, both locales: the pricing FAQ (`:67`–`:83`, `:122`–`:138`), the cost answer (`:170`–`:173`), the platform answer (`:175`–`:177`), and — if the desktop retires — the privacy answer at `:165`–`:168`.

## 4. M2 — Resolve the download page

`/download` is the primary conversion surface and is already switchable without code. `apps/corp/src/lib/site.ts:27`–`:28` derive `baseUrl` and `available` from `NEXT_PUBLIC_DOWNLOAD_BASE_URL`; `DownloadOptions` reads them at `apps/corp/src/components/sections/DownloadOptions.tsx:44` and, when `!available` (`:47`), renders the coming-soon card — "Downloads are coming soon" (`apps/corp/messages/en.json:141`) with a `/contact` CTA — instead of the two version-free installer links at `:21`–`:22`. `docs/DEPLOYMENT.md:244` points that variable at the R2 `installation/` prefix. **The environment variable is the switch.**

**Branch A (retire).** Unset the variable in Vercel *first* — that is the whole kill switch, and it must land before plan 0011's step 4 stops publishing to R2, or the page 404s. Then delete the route and `DownloadOptions.tsx`, drop the `download` entries from `footerNav` (`apps/corp/src/lib/site.ts:86`) and `apps/corp/src/app/sitemap.ts`, and retire the `download` message group and the bundle at `apps/corp/src/content/static-pages.ts:63`–`:65` ("Get PromptConnext free" / "The desktop app is free and runs on macOS and Windows"). **The replacement primary conversion is cloud workspace sign-up** — `siteConfig.appUrl` (`apps/corp/src/lib/site.ts:14`), already in the header at `apps/corp/src/components/layout/Header.tsx:91` and `:144` — pointed at `apps/web`'s `/register`, with every `Download free` CTA becoming "Start free". The second surface is a Marketplace listing for `promptconnext-vscode`, which needs an `/extension` page: `apps/corp` has no route for the product that replaced the download.

**Branch B (fund).** Keep the page and the variable, and add what it omits: `docs/plans/0011-desktop-decision-gate.md` §3 establishes the macOS bundle is unsigned, and the page should describe the Gatekeeper prompt rather than letting the visitor discover it.

## 5. M3 — Say what the product is now

Scoped, not written, here. Measured across both locales:

- **`apps/corp/src/content/product.ts`** — 5 pages per locale. `collaboration` carries the load-bearing falsehood, "The local graph is the source of truth and works fully offline" (`:96`), which ADR 0020 inverts. `task-graph` and `3s-workflow` describe the desktop's stage runner; `integrations` sells ClickUp and an MCP server that does not exist.
- **`apps/corp/src/content/articles/`** — 15 articles per locale, 30 total, across three collections (`apps/corp/src/content/articles/types.ts:3`): 7 `compare`, 4 `guides`, 4 `use-cases` each. The five `promptconnext-vs-*` pieces argue against Cursor, Copilot, Devin, Lovable and Windsurf on editor ground the product has left; `best-local-first-ai-coding-tools` and `run-ai-coding-locally-with-ollama` are wholly about the retired local path. `for-thai-sea-teams` is the one already aligned with §4's market.
- **`apps/corp/src/content/static-pages.ts`** — one `Bundle` per locale (`:50`, `:429`) covering Download, Docs, Getting Started, About, Contact and both legal pages; Getting Started is an install-first narrative.
- **`apps/corp/messages/en.json`** and `th.json` — 189 lines each, identical top-level keys. The home hero still reads "Free for the desktop app · macOS, Windows · No signup required", and `home.dual` sells the two-persona desktop window §4.3 says moved between two applications.
- **`apps/corp/content/blog/en/release-0-1-0.mdx`** and its Thai twin — 2 posts per locale.

Priority: home hero and `product/collaboration` first, then `task-graph` and `3s-workflow`, then the comparisons, then Getting Started. Retire the two local-first guides rather than rewrite them.

## 6. M4 — Billing, or an honest absence of it

There is no payment integration anywhere: no Stripe, no seat model, no subscription record, and the only quota is the in-process `DailyTokenBudget` above. "Enterprise, contact sales" is the only revenue path, and it is manual.

**This plan does not introduce billing.** Self-serve is worth building when three things are true, and none are: the paid boundary is decided *and shipped in the product*, the metering behind it is durable rather than in-process, and inbound volume makes manual invoicing the bottleneck. A checkout in front of an undecided boundary just encodes §2's open question in a payment provider.

That makes the contact route load-bearing. `apps/corp/src/app/api/contact/route.ts` validates, applies a honeypot, then reads `CONTACT_WEBHOOK_URL` at `:51`. **Unset, it does nothing but `console.log("[contact] submission", submission)` (`:65`)** — a serverless log with no retention and nobody watching, which loses the lead. Worse: when the variable *is* set and delivery throws, the catch at `:62` logs only `submission.email`, despite its comment claiming "the submission is still logged below for recovery" — there is no such log, so an outage discards the message body. Two fixes in that file: log the full `submission` in the catch as well as the else branch, and fail loudly in production when the variable is unset.

## 7. M5 — A test framework for the marketing site

`apps/corp/package.json:6`–`:11` defines `dev`, `build`, `start`, `typecheck` and `lint` — no `test`. Every other maintained app has one: pytest in `apps/cloud`, `node --test` in `apps/engine` and `apps/vscode`, `vitest run` in `apps/web` with a working config at `apps/web/vitest.config.ts`. Copy that config minus `happy-dom` and the React plugin — the content modules are plain typed data and need no DOM. Three assertions catch the class of error this plan introduces:

1. **Locale parity.** Across `pages.ts`, `product.ts`, `static-pages.ts` and both article files: same tier count, same feature count per tier, same FAQ count, same slug set, same section count per matched slug. TypeScript sees none of this, and a half-translated pricing rewrite is M1's likeliest defect.
2. **Link integrity.** Every internal `href` in `productNav`, `footerNav`, `DocsHubContent.cards` and every tier's `ctaHref` must resolve to a real route. This is what makes M2's deletion safe: removing `/download` while leaving its footer entry currently ships a dead link with no error.
3. **Sitemap/slug agreement.** `getCollectionSlugs` (`apps/corp/src/content/articles/index.ts:38`–`:39`) and `getProductSlugs` (`apps/corp/src/content/product.ts:246`) read the **default locale only**, and `apps/corp/src/app/sitemap.ts:67` emits a Thai URL for every English slug — so an English-only article publishes a `/th/...` entry that 404s.

Add `"test": "vitest run"` plus the dev dependency, and wire it into whatever CI plan 0021 stands up.

---

## Cross-cutting checklist

- **§2 is answered in an ADR before M1's copy is written.** Pricing copy is the output of a pricing decision, not a substitute for one.
- **Both locales change in the same commit**; M5 lands with or before M1 so parity is machine-checked rather than remembered.
- **Never quote a capability the runtime cannot execute** — SSO and ClickUp are the live examples; re-listing them in a new tier repeats the mistake at a new price.
- **`NEXT_PUBLIC_DOWNLOAD_BASE_URL` is unset before any R2 publishing stops**, not after.
- **`pnpm --dir apps/corp typecheck && lint && test`** passes on every milestone.

## Suggested commit sequence

1. `test(corp): add vitest with locale-parity and link-integrity suites (M5)`.
2. `fix(corp): don't drop a contact submission when the webhook is unset or down (M4)`.
3. `content(corp): rewrite pricing and the pricing/cost FAQs for the cloud product (M1)` — after the §2 ADR lands.
4. `content(corp): resolve the download surface under the chosen branch (M2)`.
5. `content(corp): realign product pages, articles and the home hero (M3)` — largest, splittable per collection.

M4 and M5 should not wait on plan [0011](./0011-desktop-decision-gate.md). M1 waits on §2; M2 waits on 0011.
