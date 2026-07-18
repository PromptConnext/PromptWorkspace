import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Container } from "@/components/ui/Container";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { siteConfig } from "@/lib/site";

const groups: { group: string; items: { key: string; href: string }[] }[] = [
  {
    group: "product",
    items: [
      { key: "overview", href: "/product" },
      { key: "3s-workflow", href: "/product/3s-workflow" },
      { key: "bring-your-own-model", href: "/product/bring-your-own-model" },
      { key: "task-graph", href: "/product/task-graph" },
      { key: "integrations", href: "/product/integrations" },
      { key: "download", href: "/download" },
    ],
  },
  {
    group: "resources",
    items: [
      { key: "documentation", href: "/docs" },
      { key: "getting-started", href: "/docs/getting-started" },
      { key: "guides", href: "/guides" },
      { key: "use-cases", href: "/use-cases" },
      { key: "compare", href: "/compare" },
      { key: "faq", href: "/faq" },
    ],
  },
  {
    group: "company",
    items: [
      { key: "about", href: "/about" },
      { key: "blog", href: "/blog" },
      { key: "contact", href: "/contact" },
      { key: "contact-sales", href: "/contact/sales" },
    ],
  },
  {
    group: "legal",
    items: [
      { key: "privacy", href: "/legal/privacy" },
      { key: "terms", href: "/legal/terms" },
    ],
  },
];

export async function Footer() {
  const t = await getTranslations("footer");

  return (
    <footer className="border-t border-border-muted bg-surface-base">
      <Container className="py-14">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-5">
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <Link href="/" className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-accent text-text-inverse">
                P
              </span>
              {siteConfig.name}
            </Link>
            <p className="mt-3 max-w-xs text-sm text-text-tertiary">{t("tagline")}</p>
            <div className="mt-4">
              <LanguageSwitcher />
            </div>
          </div>

          {groups.map((group) => (
            <nav key={group.group} aria-label={t(`groups.${group.group}`)}>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                {t(`groups.${group.group}`)}
              </h2>
              <ul className="mt-4 flex flex-col gap-2.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="text-sm text-text-secondary transition-colors hover:text-text-primary"
                    >
                      {t(`links.${item.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-4 border-t border-border-muted pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-text-tertiary">
            © {new Date().getFullYear()} {siteConfig.name}. {t("rights")}
          </p>
          <div className="flex items-center gap-4 text-xs text-text-tertiary">
            <Link href="/legal/privacy" className="hover:text-text-primary">
              {t("links.privacy")}
            </Link>
            <Link href="/legal/terms" className="hover:text-text-primary">
              {t("links.terms")}
            </Link>
            <a href={siteConfig.githubUrl} className="hover:text-text-primary">
              GitHub
            </a>
          </div>
        </div>
      </Container>
    </footer>
  );
}
