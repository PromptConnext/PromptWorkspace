import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PageHero } from "@/components/sections/PageHero";
import { Section } from "@/components/ui/Section";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { createMetadata } from "@/lib/seo";
import { getStaticPages } from "@/content/static-pages";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const c = getStaticPages(locale).docs;
  return createMetadata({ locale, title: c.title, description: c.description, path: "/docs" });
}

export default async function DocsPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = getStaticPages(locale).docs;

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} description={c.description} />
      <Section>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {c.cards.map((card) => (
            <Link key={card.title} href={card.href} className="group">
              <Card className="h-full">
                <CardTitle className="group-hover:text-accent">{card.title}</CardTitle>
                <CardDescription>{card.description}</CardDescription>
              </Card>
            </Link>
          ))}
        </div>
      </Section>
    </>
  );
}
