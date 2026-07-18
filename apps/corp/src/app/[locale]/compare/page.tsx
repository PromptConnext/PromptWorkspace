import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { ArticleHub } from "@/components/sections/ArticleHub";
import { createMetadata } from "@/lib/seo";
import { getArticles } from "@/content/articles";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "collections.compare" });
  return createMetadata({ locale, title: t("title"), description: t("description"), path: "/compare" });
}

export default async function ComparePage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("collections.compare");
  return (
    <ArticleHub
      eyebrow={t("eyebrow")}
      title={t("title")}
      description={t("description")}
      basePath="/compare"
      articles={getArticles(locale, "compare")}
    />
  );
}
