import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageHero } from "@/components/sections/PageHero";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { JsonLd } from "@/components/ui/JsonLd";
import { createMetadata, faqJsonLd } from "@/lib/seo";
import { getPricingContent } from "@/content/pages";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const c = getPricingContent(locale);
  return createMetadata({ locale, title: c.eyebrow, description: c.description, path: "/pricing" });
}

export default async function PricingPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = getPricingContent(locale);

  return (
    <>
      <JsonLd data={faqJsonLd(c.faqs)} />
      <PageHero eyebrow={c.eyebrow} title={c.title} description={c.description} />
      <Section>
        <div className="grid gap-6 lg:grid-cols-2">
          {c.tiers.map((tier) => (
            <Card key={tier.name} className="flex flex-col p-8">
              <h2 className="text-lg font-semibold text-text-primary">{tier.name}</h2>
              <p className="mt-1 text-sm text-text-tertiary">{tier.tagline}</p>
              <p className="mt-6 text-4xl font-semibold text-text-primary">{tier.price}</p>
              <ul className="mt-8 flex flex-1 flex-col gap-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-text-secondary">
                    <span aria-hidden className="mt-0.5 text-accent">
                      ✓
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <Button href={tier.ctaHref} variant={tier.ctaVariant} className="w-full">
                  {tier.ctaLabel}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <Section className="border-t border-border-muted">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-semibold text-text-primary">{c.faqTitle}</h2>
          <dl className="mt-8 flex flex-col divide-y divide-border-muted">
            {c.faqs.map((faq) => (
              <div key={faq.question} className="py-5">
                <dt className="text-base font-semibold text-text-primary">{faq.question}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-text-secondary">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
    </>
  );
}
