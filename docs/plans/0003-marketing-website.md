# Plan — PromptConnext Marketing Website (IA · Content · SEO · Conversion)

**Date:** 2026-07-06 · **Status:** Moved. Built as `apps/corp`, which moved to `PromptConnext/promptconnext-corp-web` on 2026-10-01; nothing remains in this repo · **Scope:** new `apps/website` (or separate repo)
**Grounded in:** `docs/promptconnext-product-roadmap.md`, `docs/promptconnext-platform-architecture.md`, `docs/promptconnext-design-system-plan.md`, root `README.md`

**Brand:** product is **PromptConnext** (renamed from PromptConnext). All site copy, brand keywords, comparison slugs, and the domain use *PromptConnext*. Internal repo/doc filenames (e.g. `docs/promptconnext-*.md`) are left as-is here and are covered by a separate repo-wide rename if the team wants one.

**Locked decisions (from intake):**
- **Pricing:** desktop app **free** (BYO-model, no model tax); **enterprise is contact-sales** (SSO, Jira/ClickUp sync, workspaces, support).
- **Primary conversion:** **Desktop download**; cloud/workspace signup is the secondary (collaboration) upsell.
- **Market/language:** **bilingual EN + Thai** with hreflang; leans into the SEA/Thai-model angle (Typhoon role on the roadmap).
- **Stack:** **Next.js (App Router)**, matching the team's existing React/Next familiarity.

---

## 1. Goals & success metrics

Primary goal: **maximize qualified organic traffic and convert it to desktop downloads**, with a secondary path to cloud signup and an enterprise contact-sales lane.

| Metric | 6-month target | 12-month target |
|---|---|---|
| Organic sessions / mo | 8k | 30k |
| Indexed content pages (EN+TH) | 60 | 150 |
| Download conversion (organic → download) | 3% | 5% |
| Enterprise contact-sales leads / mo | 5 | 20 |
| Core Web Vitals (all pages, p75) | all "Good" | all "Good" |
| Ranking keywords (top 10) | 40 | 150 |

Positioning to carry on every page (from roadmap §1–2): **"An AI-native development workspace — VS Code for the whole team — that orchestrates the AI models you already pay for."** Two honesty guardrails from roadmap §4.2/§8: never claim "reuse your ChatGPT subscription as an API," and never over-promise local quality — say **"connect your own models and keys, cloud or local — no PromptConnext model tax."**

---

## 2. Audience & positioning

Two personas share one site; the IA must serve both without forking (roadmap §5):

- **Business / product persona** — wants requirement→spec→delivery transparency, dual-persona collaboration, no CLI. Entry stage: **Scope**. Primary CTA path: **request a demo / cloud signup**.
- **Developer / tech-lead persona** — wants BYO-model orchestration, local/Ollama, Claude Code/Gemini CLI integration, the task graph, own IDE. Entry stage: **Skill**. Primary CTA path: **download the desktop app**.

Because download is the primary goal, developer-intent pages get the strongest CTA weighting, but business-intent pages route to demo/signup and are the top-of-funnel for enterprise leads.

---

## 3. Information architecture & sitemap

### URL & i18n structure
Locale-prefixed routing under Next.js App Router. English is default and un-prefixed *or* prefixed — **use explicit prefixes for both** (`/en`, `/th`) to keep hreflang clean and avoid a rootless default-locale ambiguity. `x-default` → `/en`.

```
promptconnext.dev/
  /en   (default)                         /th  (Thai mirror)
  ├─ /                     Home / Landing
  ├─ /product             Product overview (hub)
  │   ├─ /product/3s-workflow          Scope → Spec → Skill
  │   ├─ /product/bring-your-own-model BYO orchestration + connection modes
  │   ├─ /product/task-graph           Traceability / transparency graph
  │   ├─ /product/collaboration        Dual-persona + cloud workspaces
  │   └─ /product/integrations         Claude Code, Gemini CLI, Ollama, Jira/ClickUp, MCP
  ├─ /download            Desktop download (PRIMARY conversion page)
  ├─ /pricing             Free vs Enterprise (contact-sales)
  ├─ /docs                Documentation home  ── (may proxy to a docs subsystem)
  │   ├─ /docs/getting-started
  │   ├─ /docs/onboarding-connect-a-model
  │   └─ /docs/…
  ├─ /guides             SEO pillar hub (guides / how-tos)
  │   └─ /guides/<slug>
  ├─ /use-cases          Use-case pillar hub
  │   └─ /use-cases/<slug>
  ├─ /compare            Comparison pillar hub
  │   └─ /compare/<slug>            e.g. /compare/promptconnext-vs-cursor
  ├─ /blog               Blog + release notes hub
  │   ├─ /blog/<slug>
  │   └─ /blog/releases/<version>
  ├─ /faq
  ├─ /about
  ├─ /contact            (+ /contact/sales for enterprise)
  ├─ /legal/privacy
  └─ /legal/terms
```

### Global navigation
- **Primary nav:** Product ▾ (mega-menu: 3S Workflow, BYO Model, Task Graph, Collaboration, Integrations) · Docs · Guides · Pricing · Blog
- **Persistent header CTA:** **Download** (primary button) + **Sign in** (text link).
- **Footer:** Product links · Resources (Docs, Guides, Use cases, Compare, FAQ) · Company (About, Contact, Blog) · Legal (Privacy, Terms) · language switcher (EN/TH) · social/GitHub.
- **Mega-menu** doubles as an internal-linking hub feeding SEO equity to `/product/*` and pillar hubs.

### Page-type inventory
Landing/marketing (Home, Product/*, Pricing, Download, About, Contact) · Content/SEO (Guides, Use-cases, Compare, Blog, FAQ) · Utility/Docs (Docs, Getting Started) · Legal.

---

## 4. Per-page specification

Each page lists: **purpose · primary keyword/intent · primary CTA · key sections · schema**.

**Home `/`** — purpose: communicate value in 5 seconds, split the two personas, drive download. Intent: brand + "AI-native development workspace." CTA: **Download** (hero) + "See how it works." Sections: hero (one-line positioning + download), 3S explainer, dual-persona split, BYO-model with honesty framing, task-graph transparency, social proof/logos, integrations strip, final CTA. Schema: `Organization`, `SoftwareApplication`, `WebSite` (+ Sitelinks searchbox).

**Product hub `/product`** — overview linking to the five sub-pages; intent "PromptConnext features." CTA: Download. Schema: `SoftwareApplication` with `featureList`.

**`/product/3s-workflow`** — the Scope→Spec→Skill story (roadmap §3). Intent: "spec-driven AI development," "requirements to code." CTA: Download / Docs. Schema: `HowTo` (the three stages) + `BreadcrumbList`.

**`/product/bring-your-own-model`** — connection modes table (API-key vs subscription/agentic), no-model-tax, local Ollama, provider list. Intent: "bring your own model AI coding," "AI coding without API markup." CTA: Download. **Honesty box** per roadmap §4.2. Schema: `FAQPage` (the subscription-vs-API question).

**`/product/task-graph`** — requirement→spec→task→artifact→agent-run transparency. Intent: "AI coding traceability," "AI agent audit trail." CTA: Download / demo.

**`/product/collaboration`** — dual-persona + cloud workspaces (the multi-user story from ADR 0010 + workspace plan). Intent: "AI dev tool for teams," business+dev in one workspace. CTA: **cloud signup / demo** (business-leaning).

**`/product/integrations`** — Claude Code, Gemini/Codex CLI, custom agent, Ollama, Jira/ClickUp sync, MCP. Intent: "Claude Code workspace," "Ollama coding tool," "AI dev tool Jira integration." Each integration gets an anchor and, where volume justifies, its own child page later. Schema: `ItemList`.

**`/download`** — **the primary conversion page.** OS auto-detect (macOS first — Tauri), version, checksums, system requirements, "what happens next" (onboarding gate → connect a model → first project), zero-cost Ollama path, link to Getting Started. Intent: "download PromptConnext." CTA: platform-specific download button. Schema: `SoftwareApplication` + `softwareVersion`. Track download events as the north-star conversion.

**`/pricing`** — two columns: **Free** (full desktop app, BYO-model, local + cloud connections, single-user/local workspaces) vs **Enterprise** (cloud workspaces at scale, SSO, Jira/ClickUp sync, admin/RLS, priority support) → **Contact sales**. Intent: "PromptConnext pricing." Clear "free forever for the desktop app" line. CTA: Download (Free) / Contact sales (Enterprise). Schema: `FAQPage` (pricing FAQs), `Offer`.

**`/docs` + `/docs/getting-started`** — install → onboarding (connect + health-check a model, incl. Ollama) → create project → Scope→Spec→Skill → pick a coding agent. Intent: "PromptConnext getting started," "how to set up PromptConnext." CTA: Download. Schema: `TechArticle`/`HowTo`. (Docs may live in a dedicated docs system; keep it on the same domain as a subpath for SEO equity — not a subdomain.)

**Pillar hubs `/guides`, `/use-cases`, `/compare`** — see §5. Each hub is a pillar page linking to its cluster; each hub targets a head term and passes equity down.

**`/blog` (+ `/blog/releases/*`)** — thought leadership + release notes. Release notes double as fresh-content signal and changelog. Intent: long-tail + brand. Schema: `Article`/`BlogPosting`, releases as `TechArticle`.

**`/faq`** — consolidated Q&A (BYO honesty, pricing, privacy/local-first, OS support, model requirements). Also seed page-level `FAQPage` blocks on relevant pages. Intent: question keywords.

**`/about`** — mission (requirement-to-code transparency thesis), team, the Ideva Kit lineage, SEA/Thai angle. Schema: `AboutPage`, `Organization`.

**`/contact` + `/contact/sales`** — general contact + enterprise lead form (routes to sales). Schema: `ContactPage`.

**`/legal/privacy`, `/legal/terms`** — emphasize the privacy posture that is a genuine product selling point (keys in OS keychain, code never leaves the machine, cloud stores only the task graph — ADR 0010 §5). Link from footer + download flow.

---

## 5. Content strategy & SEO content clusters

**Pillar → cluster model.** Three pillar hubs, each an authoritative page targeting a head term, surrounded by cluster articles that internally link up to the pillar. This concentrates topical authority and is the core of the organic-traffic engine.

### Pillar 1 — Guides (`/guides`) — "AI-native / spec-driven development"
Cluster articles (informational, top-of-funnel):
- "What is spec-driven development?" · "Requirements-to-code with AI: a practical workflow" · "Bring-your-own-model AI coding, explained" · "How to run AI coding locally with Ollama (zero-cost setup)" · "API key vs subscription: which AI connection should you use?" · "Keeping AI-generated code auditable: the task-graph approach" · "Setting up Claude Code with your own model" · "Dual-persona teams: getting business and engineering into one workflow."

### Pillar 2 — Use cases (`/use-cases`) — audience/JTBD intent
- "AI dev workspace for startups / greenfield teams" · "For product managers who want delivery transparency" · "For enterprises needing on-prem/local models" · "For agencies delivering client software" · "For Thai/SEA teams (local-language + local-model)." Each maps a persona/segment to the 3S value and ends with the matching CTA (download vs demo).

### Pillar 3 — Comparisons (`/compare`) — high-intent, bottom-of-funnel
- `promptconnext-vs-cursor` · `promptconnext-vs-github-copilot` · `promptconnext-vs-devin` · `promptconnext-vs-lovable` · `promptconnext-vs-windsurf` · "Best AI coding tools that let you bring your own model" (listicle) · "Best local-first / private AI coding tools." Comparisons convert best; give them honest, sourced, table-driven content (differentiator: BYO + no model tax + business↔dev transparency + local-first privacy). Keep claims factual and dated; avoid disparagement.

**Editorial calendar (first 12 weeks):** 2 pieces/week alternating pillar clusters, EN first, TH localization following at ~1-week lag. Front-load the 5 comparison pages (highest commercial intent) and the Ollama/BYO guides (highest developer-download intent). Release notes published on every app version.

**Voice:** technical-credible for developer content, plain-language for business content; both honest about BYO limits (roadmap §8). Consider the `humanize-content` and `article-writer` skills for drafting, and `technical-writer` for docs.

**Localization (TH):** not machine-translation dumps — transcreate the top 20 commercial pages (Home, Product/*, Download, Pricing, Compare, top guides) with Thai keyword research; lower-priority long-tail can follow. Thai content is a differentiator few competitors invest in and aligns with the Typhoon/Thai-model roadmap thread.

---

## 6. SEO plan

### 6.1 Keyword strategy by intent
- **Navigational/brand:** "PromptConnext," "PromptConnext download," "PromptConnext pricing" — own these completely.
- **Commercial (bottom-funnel, prioritize):** "bring your own model AI coding tool," "AI coding tool no API markup," "local AI coding assistant," "Claude Code alternative / setup," "spec-driven development tool," "PromptConnext vs *," "private AI coding tool." These drive downloads.
- **Informational (top-funnel, volume):** "what is spec-driven development," "requirements to code AI," "run AI coding locally," "AI agent traceability," "bring your own LLM." These feed the funnel and earn links.
- **Thai:** research TH equivalents for the commercial + top informational set (e.g. AI เขียนโค้ด, เครื่องมือ AI สำหรับนักพัฒนา, โมเดล AI ภาษาไทย). Build the TH keyword map before transcreation.

Map every target keyword to exactly one canonical page (avoid cannibalization); comparisons and guides absorb long-tail.

### 6.2 Technical SEO
- **Rendering:** SSG/ISR via App Router for all marketing + content pages (fast, crawlable HTML). No client-only rendering of primary content.
- **Core Web Vitals:** next/image, font subsetting (Anthropic Sans from the design system), route-level code splitting, no layout shift in hero; target all-Good p75.
- **Crawlability:** auto-generated `sitemap.xml` (per-locale, with `<xhtml:link>` alternates), `robots.txt`, clean canonical tags, breadcrumb structure.
- **Structured data:** `Organization`, `SoftwareApplication`, `WebSite`, `BreadcrumbList` sitewide; `FAQPage`, `HowTo`, `Article`, `BlogPosting`, `TechArticle`, `Offer` per page type (§4).
- **Docs on subpath, not subdomain** — keep `docs.` equity on the main domain via `/docs`.

### 6.3 Internationalization (EN/TH)
- `hreflang` on every page: `en`, `th`, and `x-default → /en`. Reciprocal and self-referencing tags.
- Locale-prefixed routes (`/en/*`, `/th/*`); Next.js `middleware` for locale detection with a manual switcher that persists choice (cookie), never auto-redirects a crawler.
- Per-locale sitemaps and per-locale metadata (title/description/OG) — not translated-in-place English.

### 6.4 On-page
Unique title + meta description per page/locale; one H1; semantic heading outline; descriptive slugs; OG/Twitter cards (auto-generated per page); internal links from mega-menu + pillar hubs + in-body contextual links; image alt text; content freshness dates on guides/compare.

### 6.5 Off-page / authority
- Launch on Product Hunt, Hacker News (Show HN), dev.to, and relevant subreddits — link back to Home/Download.
- Guest/dev-community posts reusing the `article-writer` skill, syndicated with canonical back to the pillar.
- Open-source/GitHub presence (the repo) as a credibility + backlink source.
- Comparison pages naturally earn links from "best AI coding tools" roundups — pitch to those authors.
- Thai tech communities/blogs for TH authority.

### 6.6 Measurement
Google Search Console (per-locale properties), GA4 (or privacy-friendly Plausible/Umami given the product's privacy stance — **recommend Plausible** to match brand values), download-event tracking as the primary conversion, Core Web Vitals monitoring (CrUX + `web-vitals` RUM), rank tracking for the §6.1 target set. Weekly WoW review — the existing `seo-diagnostic` skill fits this cadence.

---

## 7. Conversion strategy (download-first)

**Funnel:** organic landing → value comprehension → **Download** (primary) or **Demo/Signup** (business) or **Contact sales** (enterprise).

- **Primary CTA everywhere = Download**, OS-aware, above the fold on Home/Product/Docs. The `/download` page is the conversion hub with the least friction (no signup wall — the app is free and local-first).
- **Dual-persona routing:** developer-intent pages (BYO, integrations, guides, compare) → Download; business-intent pages (collaboration, use-cases for PM/enterprise) → **Book a demo / Sign up** and feed contact-sales.
- **Enterprise lane:** Pricing "Enterprise" + `/contact/sales` lead form (SSO, Jira sync, workspaces, support) → CRM. This is the monetization path since the app is free.
- **Trust accelerators:** privacy posture (local-first, keys in keychain, no code in cloud), zero-cost Ollama path (removes "which AI can I afford" objection), honest BYO framing (builds credibility competitors lack), open-source engine.
- **Post-download activation:** `/download` → Getting Started deep-link so the onboarding gate (connect + health-check a model) is one click away — reduces install-to-first-value drop-off.
- **Experimentation:** A/B hero copy and CTA label (e.g. "Download free" vs "Get PromptConnext"); measure download-CTR by persona-path.

---

## 8. Tech implementation (Next.js App Router)

- **Framework:** Next.js App Router, SSG/ISR; TypeScript; Tailwind mapped to the **design-system tokens** so the site matches the product. **Token source of truth = the cloud-app design system in `.claude/skills/design-system/SKILL.md`** (not the older `docs/promptconnext-design-system-plan.md`, which is superseded for the website). Reuse `packages/ui` where sensible. Concrete tokens to mirror (dark-first, Anthropic Sans):
  - **Type:** `font.family = Anthropic Sans, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif`; base 14px / weight 500 / line-height 19.6px; scale xs 12 / sm 14 / md 16.
  - **Color:** text `#f8f8f6` / `#c3c2b7` / `#2c2c2a` / inverse `#ffffff`; surface base `#000000` / muted `#1f1f1e`; border `#e2e1da` / muted `rgba(255,255,255,.1)`; focus ring `#5599e7`.
  - **Space:** 8 / 10 / 16 (extend to a full marketing scale using these as anchors). **Radius:** 6px. **Motion:** 100ms / 150ms.
  - **A11y (must):** WCAG 2.2 AA, keyboard-first, visible focus, semantic tokens only (no raw hex in components). ⚠️ Validate `text.tertiary #2c2c2a` on `surface.base #000` before use — that pair is ~1.1:1 and unreadable as body text; treat it as a disabled/inverse token and pick an AA-passing tertiary for the site.
- **i18n:** `next-intl` (or App Router built-in i18n) with `/en` `/th` segments, message catalogs, locale middleware, hreflang helper.
- **Content:** MDX for guides/use-cases/compare (version-controlled, developer-friendly, great for technical content with code blocks) **or** a headless CMS (Sanity/Contentful) if non-technical marketers must publish. **Recommend MDX + Contentlayer for launch** (fast, free, git-reviewed), with a CMS migration path if the content team grows. Blog/release notes as MDX collections.
- **Analytics:** Plausible (privacy-first, matches brand) + GSC; `web-vitals` RUM.
- **Hosting:** Vercel (native App Router/ISR, edge, preview deploys) or Cloud Run to match the platform's existing deploy tooling — **recommend Vercel** for a marketing site's ISR/CWV needs.
- **Location:** `apps/website` in the monorepo (pnpm workspace) or a separate repo. Recommend **`apps/website`** to share tokens/`packages/ui` and keep brand consistency.
- **Perf budget:** LCP < 2.0s, CLS < 0.05, JS < 120KB on content pages; enforce in CI (Lighthouse).

---

## 9. Phased rollout

**Phase A — Foundation & conversion core (weeks 1–3).** Next.js + i18n scaffold, design-system tokens, Home, Product hub + 3S + BYO pages, **Download**, Pricing, Contact/Sales, Legal, FAQ, About. Analytics + GSC + sitemap/hreflang + core schema. *Goal: a complete, crawlable, converting site in EN.*

**Phase B — SEO content engine (weeks 3–10).** Stand up the three pillar hubs; publish the 5 comparison pages + top BYO/Ollama guides first (highest download intent); Docs/Getting Started; blog + release notes pipeline. 2 pieces/week. *Goal: rank for commercial-intent terms, start the traffic flywheel.*

**Phase C — Thai localization (weeks 6–12, overlapping).** TH keyword research → transcreate the top ~20 commercial pages → per-locale sitemaps/metadata. *Goal: own SEA/Thai search where competitors are absent.*

**Phase D — Scale & optimize (ongoing).** Expand clusters on winning topics, per-integration landing pages, CWV/CRO tuning, weekly `seo-diagnostic` reviews, link outreach, A/B tests. *Goal: compounding organic growth to the 12-month targets.*

---

## 10. Open decisions to confirm
- **Domain:** `promptconnext.dev` assumed above — confirm the real domain (affects hreflang, GSC, canonical setup).
- **Docs system:** custom `/docs` in the same Next app vs. a docs framework (Nextra/Docusaurus) on the same domain subpath — recommend same-app MDX for launch, revisit if docs volume explodes.
- **Content ops owner:** who writes/reviews EN and who transcreates TH — sets the realistic cadence (plan assumes 2/week).
- **Analytics:** confirm Plausible (privacy-brand-aligned) vs GA4.
- **Enterprise CRM/lead routing:** where `/contact/sales` submissions land.
- **App store presence:** if the Tauri app will also be on the Mac App Store, the download page needs a store link + strategy.

---

## Note on repeatability
This "IA + content-cluster + SEO + i18n rollout" is a recurring pattern (the sibling ideva-kit repo has a `specs/022-marketing-website`). Worth capturing as a Claude Skill so the next product site starts from this scaffold instead of a blank page. Also consider updating your Skills/preferences to auto-apply the `seo-diagnostic` weekly cadence once the site is live.
