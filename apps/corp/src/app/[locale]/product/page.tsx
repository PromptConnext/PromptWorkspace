import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PageHero } from "@/components/sections/PageHero";
import { CTASection } from "@/components/sections/CTASection";
import { Section } from "@/components/ui/Section";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JsonLd } from "@/components/ui/JsonLd";
import { createMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { getProductPages } from "@/content/product";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "productHub" });
  return createMetadata({ locale, title: t("eyebrow"), description: t("description"), path: "/product" });
}

export default async function ProductHubPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("productHub");
  const pages = getProductPages(locale);

  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Product", path: "/product" },
        ])}
      />
      <PageHero eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />
      <Section>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((page) => (
            <Link key={page.slug} href={`/product/${page.slug}`} className="group">
              <Card className="h-full">
                <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                  {page.eyebrow}
                </span>
                <CardTitle className="mt-2 group-hover:text-accent">{page.title}</CardTitle>
                <CardDescription>{page.description}</CardDescription>
              </Card>
            </Link>
          ))}
        </div>
      </Section>
      <CTASection />
    </>
  );
}
