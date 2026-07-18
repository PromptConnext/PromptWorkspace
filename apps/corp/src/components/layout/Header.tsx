"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";
import { siteConfig } from "@/lib/site";
import { cn } from "@/lib/utils";

const productSlugs = [
  "3s-workflow",
  "bring-your-own-model",
  "task-graph",
  "collaboration",
  "integrations",
] as const;

const topLinks = [
  { key: "product", href: "/product" },
  { key: "docs", href: "/docs" },
  { key: "guides", href: "/guides" },
  { key: "pricing", href: "/pricing" },
  { key: "blog", href: "/blog" },
] as const;

export function Header() {
  const t = useTranslations();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border-muted bg-surface-base/80 backdrop-blur">
      <Container className="flex h-16 items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-accent text-text-inverse">
              P
            </span>
            {siteConfig.name}
          </Link>

          <nav aria-label="Main" className="hidden items-center gap-1 md:flex" onMouseLeave={() => setProductOpen(false)}>
            <div className="relative">
              <button
                type="button"
                aria-expanded={productOpen}
                aria-haspopup="true"
                onClick={() => setProductOpen((v) => !v)}
                onMouseEnter={() => setProductOpen(true)}
                className="rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-focus-ring"
              >
                {t("nav.product")}
              </button>
              {productOpen ? (
                <div className="absolute left-0 top-full w-80 rounded-lg border border-border-default bg-surface-elevated p-2 shadow-xl">
                  {productSlugs.map((slug) => (
                    <Link
                      key={slug}
                      href={`/product/${slug}`}
                      className="block rounded-md px-3 py-2.5 transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring"
                    >
                      <span className="block text-sm font-medium text-text-primary">
                        {t(`productMenu.${slug}.title`)}
                      </span>
                      <span className="mt-0.5 block text-xs text-text-tertiary">
                        {t(`productMenu.${slug}.description`)}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
            {topLinks
              .filter((l) => l.key !== "product")
              .map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-focus-ring"
                >
                  {t(`nav.${link.key}`)}
                </Link>
              ))}
          </nav>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <LanguageSwitcher />
          <Button href={siteConfig.appUrl} variant="ghost" size="sm">
            {t("nav.signIn")}
          </Button>
          <Button href="/download" size="sm">
            {t("nav.download")}
          </Button>
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-secondary md:hidden focus-visible:outline-2 focus-visible:outline-focus-ring"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
            {mobileOpen ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </Container>

      <div className={cn("border-t border-border-muted md:hidden", mobileOpen ? "block" : "hidden")}>
        <Container className="flex flex-col gap-1 py-4">
          {productSlugs.map((slug) => (
            <Link
              key={slug}
              href={`/product/${slug}`}
              onClick={() => setMobileOpen(false)}
              className="rounded-md px-3 py-2.5 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary"
            >
              {t(`productMenu.${slug}.title`)}
            </Link>
          ))}
          {topLinks
            .filter((l) => l.key !== "product")
            .map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="rounded-md px-3 py-2.5 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary"
              >
                {t(`nav.${link.key}`)}
              </Link>
            ))}
          <div className="mt-3 flex flex-col gap-2">
            <Button href="/download" onClick={() => setMobileOpen(false)}>
              {t("nav.download")}
            </Button>
            <Button href={siteConfig.appUrl} variant="secondary">
              {t("nav.signIn")}
            </Button>
            <div className="pt-2">
              <LanguageSwitcher />
            </div>
          </div>
        </Container>
      </div>
    </header>
  );
}
