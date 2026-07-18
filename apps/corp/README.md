# PromptConnext — Marketing Website (`corp-app`)

The public marketing site for **PromptConnext**, built with **Next.js 16 (App Router)**,
React 19, TypeScript, and Tailwind CSS v4.

## Stack

- **Next.js 16** App Router, React Server Components, static optimization
- **Tailwind CSS v4** with design tokens sourced from the cloud-app design system
- **MDX blog** via `next-mdx-remote` + `gray-matter` (content in `content/blog/`)
- SEO built in: Metadata API, `robots.ts`, `sitemap.ts`, dynamic Open Graph images, JSON-LD

## Getting started

```bash
cp .env.example .env.local   # set NEXT_PUBLIC_SITE_URL etc.
npm install
npm run dev                  # http://localhost:3000
```

Build and run production:

```bash
npm run build
npm start
```

## Project structure

```
corp-app/
├─ content/
│  └─ blog/                 # MDX posts + release notes (frontmatter-driven)
├─ src/
│  ├─ app/                  # App Router routes
│  │  ├─ layout.tsx         # root layout, metadata, header/footer
│  │  ├─ page.tsx           # home
│  │  ├─ product/           # hub + [slug] feature pages (data-driven)
│  │  ├─ download/          # primary conversion page (OS-aware)
│  │  ├─ pricing/ faq/ about/ contact/ docs/ guides/ use-cases/ compare/
│  │  ├─ blog/              # blog hub + [slug] MDX renderer
│  │  ├─ legal/             # privacy, terms
│  │  ├─ robots.ts sitemap.ts manifest.ts
│  │  ├─ opengraph-image.tsx icon.tsx
│  │  └─ globals.css        # design tokens (@theme) + base styles
│  ├─ components/
│  │  ├─ ui/                # Button, Card, Badge, Container, Section, Prose, JsonLd
│  │  ├─ layout/            # Header, Footer
│  │  └─ sections/          # Hero, CTASection, FeatureGrid, forms, etc.
│  ├─ content/              # typed content modules (product pages)
│  └─ lib/                  # site config, SEO helpers, blog reader, utils
```

## Adding content

- **A product feature page:** add an entry to `src/content/product.ts`. Route, metadata, and
  sitemap update automatically.
- **A blog post / release note:** drop an `.mdx` file in `content/blog/` with frontmatter
  (`title`, `description`, `date`, `category: blog | release`).
- **A nav link:** edit `src/lib/site.ts`.

## Design tokens

Tokens live in `src/app/globals.css` under `@theme`, mirroring the cloud-app design system
(dark-first, Anthropic Sans, WCAG 2.2 AA). Use semantic classes (`bg-surface-muted`,
`text-text-secondary`, `outline-focus-ring`) — never raw hex.

## Internationalization (EN + TH)

The site is bilingual via `next-intl` with a `[locale]` route segment and explicit
prefixes for both locales (`/en`, `/th`, `x-default → /en`).

- **Config:** `src/i18n/{routing,request,navigation}.ts`, `src/middleware.ts`.
- **UI strings:** `messages/en.json` and `messages/th.json`. Always use the locale-aware
  `Link` and hooks from `@/i18n/navigation` (not `next/link`) for internal links.
- **hreflang:** `createMetadata({ locale, path })` emits canonical + `alternates.languages`
  for every page; `sitemap.ts` emits both locales with alternates.
- **Add a locale:** extend `routing.locales`, add a `messages/<locale>.json`, and translate
  the content modules.

### Content translation status

**The whole site is transcreated to EN + TH.** Content lives in a few places:

- **UI chrome & short page strings** — `messages/{en,th}.json` (nav, footer, CTAs, home,
  blog labels, contact form, download states, hub headings).
- **Article clusters** (Compare / Guides / Use-cases) — `src/content/articles/{en,th}.ts`.
- **Product feature pages** — `src/content/product.ts` (locale-keyed).
- **Pricing & FAQ** — `src/content/pages.ts` (locale-keyed).
- **Prose pages** (Download body, Docs, Getting Started, About, Contact, Legal) —
  `src/content/static-pages.ts` (locale-keyed).
- **Blog posts** — `content/blog/{en,th}/*.mdx` (one file per locale, matched by slug).

Every page emits per-locale canonicals + `hreflang` alternates, and the sitemap lists both
locales. To add a language: extend `routing.locales`, add `messages/<locale>.json`, and add
a branch to each locale-keyed content record.

## Adding article content

Compare / Guides / Use-cases articles are typed data in `src/content/articles/en.ts` and
`th.ts` (matched by `slug`). Add an entry to both locale files and the hub, `[slug]` route,
sitemap, and JSON-LD update automatically. Blog posts are MDX in `content/blog/{en,th}/`.

## Notes

- Contact forms (`src/components/sections/ContactForm.tsx`) render a success state without
  submitting — wire them to your form/CRM endpoint before launch.
- Download URLs point at `NEXT_PUBLIC_DOWNLOAD_BASE_URL`; set it to your release host.
- Legal pages are templates — have counsel review before launch.
- `src/components/sections/TopicGrid.tsx` and the `*Nav` exports in `src/lib/site.ts` are
  legacy from the pre-i18n scaffold and can be removed.
