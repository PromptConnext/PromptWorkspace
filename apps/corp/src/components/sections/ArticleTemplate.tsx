import { PageHero } from "@/components/sections/PageHero";
import { CTASection } from "@/components/sections/CTASection";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { JsonLd } from "@/components/ui/JsonLd";
import { Link } from "@/i18n/navigation";
import { breadcrumbJsonLd, faqJsonLd } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import type { Article, ArticleCollection } from "@/content/articles";

const collectionMeta: Record<ArticleCollection, { base: string; nameEn: string }> = {
  compare: { base: "/compare", nameEn: "Compare" },
  guides: { base: "/guides", nameEn: "Guides" },
  "use-cases": { base: "/use-cases", nameEn: "Use Cases" },
};

export function ArticleTemplate({
  article,
  hubLabel,
  backLabel,
  downloadLabel,
}: {
  article: Article;
  hubLabel: string;
  backLabel: string;
  downloadLabel: string;
}) {
  const meta = collectionMeta[article.collection];

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.description,
    author: { "@type": "Organization", name: siteConfig.name },
    publisher: { "@type": "Organization", name: siteConfig.name },
    url: new URL(`${meta.base}/${article.slug}`, siteConfig.url).toString(),
  };

  return (
    <>
      <JsonLd data={articleJsonLd} />
      {article.faqs && article.faqs.length > 0 ? <JsonLd data={faqJsonLd(article.faqs)} /> : null}
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: meta.nameEn, path: meta.base },
          { name: article.title, path: `${meta.base}/${article.slug}` },
        ])}
      />

      <PageHero eyebrow={article.eyebrow} title={article.title} description={article.description}>
        <div className="flex flex-wrap gap-3">
          <Button href="/download">{downloadLabel}</Button>
          <Link href={meta.base} className="inline-flex items-center text-sm text-accent hover:underline">
            ← {hubLabel}
          </Link>
        </div>
      </PageHero>

      <Section>
        <div className="mx-auto max-w-3xl">
          {article.intro.map((p, i) => (
            <p key={i} className="mt-4 text-lg leading-relaxed text-text-secondary first:mt-0">
              {p}
            </p>
          ))}

          {article.sections.map((section) => (
            <div key={section.heading} className="mt-10">
              <h2 className="text-xl font-semibold text-text-primary sm:text-2xl">
                {section.heading}
              </h2>
              {section.body.map((p, i) => (
                <p key={i} className="mt-3 text-base leading-relaxed text-text-secondary">
                  {p}
                </p>
              ))}
            </div>
          ))}

          {article.table ? (
            <div className="mt-12 overflow-x-auto">
              {article.table.title ? (
                <h2 className="mb-4 text-xl font-semibold text-text-primary sm:text-2xl">
                  {article.table.title}
                </h2>
              ) : null}
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border-default text-left">
                    {article.table.columns.map((col, i) => (
                      <th
                        key={i}
                        className={
                          i === 0
                            ? "py-3 pr-4 font-medium text-text-tertiary"
                            : "py-3 pr-4 font-semibold text-text-primary"
                        }
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {article.table.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-border-muted">
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className={
                            ci === 0
                              ? "py-3 pr-4 font-medium text-text-secondary"
                              : "py-3 pr-4 text-text-secondary"
                          }
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {article.faqs && article.faqs.length > 0 ? (
            <div className="mt-12">
              <h2 className="text-xl font-semibold text-text-primary sm:text-2xl">FAQ</h2>
              <dl className="mt-4 flex flex-col divide-y divide-border-muted">
                {article.faqs.map((faq) => (
                  <div key={faq.question} className="py-5">
                    <dt className="text-base font-semibold text-text-primary">{faq.question}</dt>
                    <dd className="mt-2 text-sm leading-relaxed text-text-secondary">{faq.answer}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <div className="mt-12 border-t border-border-muted pt-6">
            <Link href={meta.base} className="text-sm text-accent hover:underline">
              ← {backLabel}
            </Link>
          </div>
        </div>
      </Section>

      <CTASection />
    </>
  );
}
