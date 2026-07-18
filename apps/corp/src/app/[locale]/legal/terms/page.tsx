import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageHero } from "@/components/sections/PageHero";
import { Section } from "@/components/ui/Section";
import { createMetadata } from "@/lib/seo";
import { getStaticPages } from "@/content/static-pages";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const c = getStaticPages(locale).terms;
  return createMetadata({ locale, title: c.title, description: c.intro, path: "/legal/terms" });
}

export default async function TermsPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = getStaticPages(locale).terms;

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} description={c.updated} />
      <Section>
        <div className="mx-auto max-w-3xl">
          <p className="text-base leading-relaxed text-text-secondary">{c.intro}</p>
          {c.sections.map((section) => (
            <div key={section.heading} className="mt-10">
              <h2 className="text-xl font-semibold text-text-primary sm:text-2xl">{section.heading}</h2>
              {section.body.map((p, i) => (
                <p key={i} className="mt-3 text-base leading-relaxed text-text-secondary">
                  {p}
                </p>
              ))}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
