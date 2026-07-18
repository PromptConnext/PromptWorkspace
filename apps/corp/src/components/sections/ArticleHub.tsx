import { PageHero } from "@/components/sections/PageHero";
import { CTASection } from "@/components/sections/CTASection";
import { Section } from "@/components/ui/Section";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Link } from "@/i18n/navigation";
import type { Article } from "@/content/articles";

export function ArticleHub({
  eyebrow,
  title,
  description,
  basePath,
  articles,
}: {
  eyebrow: string;
  title: string;
  description: string;
  basePath: string;
  articles: Article[];
}) {
  return (
    <>
      <PageHero eyebrow={eyebrow} title={title} description={description} />
      <Section>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {articles.map((article) => (
            <Link key={article.slug} href={`${basePath}/${article.slug}`} className="group">
              <Card className="h-full">
                <CardTitle className="group-hover:text-accent">{article.title}</CardTitle>
                <CardDescription>{article.description}</CardDescription>
              </Card>
            </Link>
          ))}
        </div>
      </Section>
      <CTASection />
    </>
  );
}
