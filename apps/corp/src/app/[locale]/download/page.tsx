import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageHero } from "@/components/sections/PageHero";
import { DownloadOptions } from "@/components/sections/DownloadOptions";
import { Section, SectionHeading } from "@/components/ui/Section";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JsonLd } from "@/components/ui/JsonLd";
import { createMetadata, softwareApplicationJsonLd } from "@/lib/seo";
import { getStaticPages } from "@/content/static-pages";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const c = getStaticPages(locale).download;
  return createMetadata({ locale, title: c.eyebrow, description: c.description, path: "/download" });
}

export default async function DownloadPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = getStaticPages(locale).download;

  return (
    <>
      <JsonLd data={softwareApplicationJsonLd()} />
      <PageHero eyebrow={c.eyebrow} title={c.title} description={c.description} />
      <Section>
        <DownloadOptions />
      </Section>
      <Section className="border-t border-border-muted">
        <SectionHeading title={c.stepsTitle} />
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {c.steps.map((step) => (
            <Card key={step.title}>
              <CardTitle>{step.title}</CardTitle>
              <CardDescription>{step.description}</CardDescription>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}
