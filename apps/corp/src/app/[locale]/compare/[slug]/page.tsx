import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { ArticleTemplate } from "@/components/sections/ArticleTemplate";
import { createMetadata } from "@/lib/seo";
import { getArticle, getCollectionSlugs } from "@/content/articles";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale; slug: string }> };

export function generateStaticParams() {
  return getCollectionSlugs("compare").map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const article = getArticle(locale, "compare", slug);
  if (!article) return createMetadata({ locale, path: "/compare" });
  return createMetadata({
    locale,
    title: article.title,
    description: article.description,
    path: `/compare/${slug}`,
    type: "article",
  });
}

export default async function CompareArticlePage({ params }: Params) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const article = getArticle(locale, "compare", slug);
  if (!article) notFound();
  const t = await getTranslations("article");
  return (
    <ArticleTemplate
      article={article}
      hubLabel={t("hub")}
      backLabel={t("back")}
      downloadLabel={t("download")}
    />
  );
}
