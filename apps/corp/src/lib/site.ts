/**
 * Central site configuration: brand, URLs, navigation, and CTAs.
 * Everything the marketing site needs to stay consistent lives here, so adding
 * a page or changing a URL is a one-file edit.
 */

export const siteConfig = {
  name: "PromptConnext",
  shortName: "PromptConnext",
  tagline: "The AI-native development workspace for the whole team",
  description:
    "PromptConnext is an AI-native development workspace — VS Code for the whole team — that orchestrates the AI models you already pay for. Take a project from business requirement to running code, transparently, with no model tax.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://promptconnext.dev",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "https://app.promptconnext.dev",
  locale: "en",
  twitter: "@promptconnext",
  githubUrl: "https://github.com/promptconnext",
  download: {
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0",
    // Empty when unset — the download page then shows a "coming soon" state
    // instead of linking to a release host that doesn't exist yet.
    baseUrl: process.env.NEXT_PUBLIC_DOWNLOAD_BASE_URL ?? "",
    available: Boolean(process.env.NEXT_PUBLIC_DOWNLOAD_BASE_URL),
  },
} as const;

export type NavItem = {
  title: string;
  href: string;
  description?: string;
};

/** Primary product mega-menu — also an internal-linking hub for SEO. */
export const productNav: NavItem[] = [
  {
    title: "3S Workflow",
    href: "/product/3s-workflow",
    description: "Scope → Spec → Skill, from business requirement to running code.",
  },
  {
    title: "Bring Your Own Model",
    href: "/product/bring-your-own-model",
    description: "Connect the AI you already pay for — cloud or local. No model tax.",
  },
  {
    title: "Task Graph",
    href: "/product/task-graph",
    description: "Every requirement, spec, task, and agent run in one traceable graph.",
  },
  {
    title: "Collaboration",
    href: "/product/collaboration",
    description: "Business and engineering in one workspace, seeing the same truth.",
  },
  {
    title: "Integrations",
    href: "/product/integrations",
    description: "Claude Code, Gemini CLI, Ollama, Jira/ClickUp, and MCP.",
  },
];

/** Top-level header navigation. */
export const mainNav: NavItem[] = [
  { title: "Product", href: "/product" },
  { title: "Docs", href: "/docs" },
  { title: "Guides", href: "/guides" },
  { title: "Pricing", href: "/pricing" },
  { title: "Blog", href: "/blog" },
];

/** Footer link groups. */
export const footerNav: { title: string; items: NavItem[] }[] = [
  {
    title: "Product",
    items: [
      { title: "Overview", href: "/product" },
      { title: "3S Workflow", href: "/product/3s-workflow" },
      { title: "Bring Your Own Model", href: "/product/bring-your-own-model" },
      { title: "Task Graph", href: "/product/task-graph" },
      { title: "Integrations", href: "/product/integrations" },
      { title: "Download", href: "/download" },
    ],
  },
  {
    title: "Resources",
    items: [
      { title: "Documentation", href: "/docs" },
      { title: "Getting Started", href: "/docs/getting-started" },
      { title: "Guides", href: "/guides" },
      { title: "Use Cases", href: "/use-cases" },
      { title: "Compare", href: "/compare" },
      { title: "FAQ", href: "/faq" },
    ],
  },
  {
    title: "Company",
    items: [
      { title: "About", href: "/about" },
      { title: "Blog", href: "/blog" },
      { title: "Contact", href: "/contact" },
      { title: "Contact Sales", href: "/contact/sales" },
    ],
  },
  {
    title: "Legal",
    items: [
      { title: "Privacy Policy", href: "/legal/privacy" },
      { title: "Terms of Service", href: "/legal/terms" },
    ],
  },
];
