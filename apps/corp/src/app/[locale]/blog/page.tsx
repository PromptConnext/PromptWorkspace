import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PageHero } from "@/components/sections/PageHero";
import { Section } from "@/components/ui/Section";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { createMetadata } from "@/lib/seo";
import { getAllPosts, formatDate } from "@/lib/blog";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "blog" });
  return createMetadata({ locale, title: t("eyebrow"), description: t("description"), path: "/blog" });
}

export default async function BlogPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("blog");
  const posts = getAllPosts(locale);

  return (
    <>
      <PageHero eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />
      <Section>
        {posts.length === 0 ? (
          <p className="text-text-tertiary">{t("empty")}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <Link key={post.slug} href={`/blog/${post.slug}`} className="group">
                <Card className="flex h-full flex-col">
                  <div className="flex items-center gap-2">
                    {post.category === "release" ? <Badge>{t("release")}</Badge> : null}
                    <span className="text-xs text-text-tertiary">{formatDate(post.date, locale)}</span>
                  </div>
                  <CardTitle className="mt-3 group-hover:text-accent">{post.title}</CardTitle>
                  <CardDescription>{post.description}</CardDescription>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
