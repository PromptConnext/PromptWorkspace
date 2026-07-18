import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { PageHero } from "@/components/sections/PageHero";
import { ContactForm } from "@/components/sections/ContactForm";
import { Section } from "@/components/ui/Section";
import { createMetadata } from "@/lib/seo";
import { getStaticPages } from "@/content/static-pages";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const c = getStaticPages(locale).contact;
  return createMetadata({ locale, title: c.eyebrow, description: c.description, path: "/contact" });
}

export default async function ContactPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = getStaticPages(locale).contact;

  return (
    <>
      <PageHero eyebrow={c.eyebrow} title={c.title} description={c.description} />
      <Section>
        <div className="mx-auto max-w-2xl">
          <ContactForm />
        </div>
      </Section>
    </>
  );
}
