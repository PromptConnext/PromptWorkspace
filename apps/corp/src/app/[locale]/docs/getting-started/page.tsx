import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageHero } from "@/components/sections/PageHero";
import { CTASection } from "@/components/sections/CTASection";
import { Section } from "@/components/ui/Section";
import { JsonLd } from "@/components/ui/JsonLd";
import { createMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { getStaticPages } from "@/content/static-pages";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const c = getStaticPages(locale).gettingStarted;
  return createMetadata({ locale, title: c.title, description: c.description, path: "/docs/getting-started" });
}

export default async function GettingStartedPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = getStaticPages(locale).gettingStarted;

  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Docs", path: "/docs" },
          { name: "Getting Started", path: "/docs/getting-started" },
        ])}
      />
      <PageHero eyebrow={c.eyebrow} title={c.title} description={c.description} />
      <Section>
        <div className="mx-auto max-w-3xl">
          {c.sections.map((section) => (
            <div key={section.heading} className="mt-10 first:mt-0">
              <h2 className="text-xl font-semibold text-text-primary sm:text-2xl">{section.heading}</h2>
              {section.body.map((p, i) => (
                <p key={i} className="mt-3 text-base leading-relaxed text-text-secondary">
                  {p}
                </p>
              ))}
            </div>
          ))}
          <blockquote className="mt-8 border-l-2 border-accent pl-4 text-sm italic text-text-secondary">
            {c.note}
          </blockquote>
        </div>
      </Section>
      <CTASection />
    </>
  );
}
