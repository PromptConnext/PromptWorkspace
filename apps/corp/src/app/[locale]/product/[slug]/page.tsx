import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { PageHero } from "@/components/sections/PageHero";
import { CTASection } from "@/components/sections/CTASection";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { JsonLd } from "@/components/ui/JsonLd";
import { createMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { getProductPage, getProductSlugs } from "@/content/product";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale; slug: string }> };

export function generateStaticParams() {
  return getProductSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const page = getProductPage(locale, slug);
  if (!page) return createMetadata({ locale, title: "Product", path: "/product" });
  return createMetadata({
    locale,
    title: page.title,
    description: page.description,
    path: `/product/${page.slug}`,
  });
}

export default async function ProductFeaturePage({ params }: Params) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const page = getProductPage(locale, slug);
  if (!page) notFound();
  const t = await getTranslations("nav");

  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Product", path: "/product" },
          { name: page.eyebrow, path: `/product/${page.slug}` },
        ])}
      />
      <PageHero eyebrow={page.eyebrow} title={page.title} description={page.description}>
        <div className="flex flex-wrap gap-3">
          <Button href="/download">{t("download")}</Button>
          <Button href="/docs/getting-started" variant="secondary">
            {t("docs")}
          </Button>
        </div>
      </PageHero>

      <Section>
        <div className="mx-auto flex max-w-3xl flex-col gap-10">
          {page.sections.map((section) => (
            <div key={section.heading}>
              <h2 className="text-xl font-semibold text-text-primary sm:text-2xl">
                {section.heading}
              </h2>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">{section.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <CTASection />
    </>
  );
}
