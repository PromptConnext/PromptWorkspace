import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageHero } from "@/components/sections/PageHero";
import { CTASection } from "@/components/sections/CTASection";
import { Section } from "@/components/ui/Section";
import { JsonLd } from "@/components/ui/JsonLd";
import { createMetadata, faqJsonLd } from "@/lib/seo";
import { getFaqContent } from "@/content/pages";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const c = getFaqContent(locale);
  return createMetadata({ locale, title: c.eyebrow, description: c.description, path: "/faq" });
}

export default async function FAQPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = getFaqContent(locale);

  return (
    <>
      <JsonLd data={faqJsonLd(c.faqs)} />
      <PageHero eyebrow={c.eyebrow} title={c.title} description={c.description} />
      <Section>
        <dl className="mx-auto flex max-w-3xl flex-col divide-y divide-border-muted">
          {c.faqs.map((faq) => (
            <div key={faq.question} className="py-6">
              <dt className="text-base font-semibold text-text-primary">{faq.question}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-text-secondary">{faq.answer}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <CTASection />
    </>
  );
}
