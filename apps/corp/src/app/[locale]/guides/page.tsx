import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { ArticleHub } from "@/components/sections/ArticleHub";
import { createMetadata } from "@/lib/seo";
import { getArticles } from "@/content/articles";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "collections.guides" });
  return createMetadata({ locale, title: t("title"), description: t("description"), path: "/guides" });
}

export default async function GuidesPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("collections.guides");
  return (
    <ArticleHub
      eyebrow={t("eyebrow")}
      title={t("title")}
      description={t("description")}
      basePath="/guides"
      articles={getArticles(locale, "guides")}
    />
  );
}
