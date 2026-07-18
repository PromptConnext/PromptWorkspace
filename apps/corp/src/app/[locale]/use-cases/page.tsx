import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { ArticleHub } from "@/components/sections/ArticleHub";
import { createMetadata } from "@/lib/seo";
import { getArticles } from "@/content/articles";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "collections.use-cases" });
  return createMetadata({ locale, title: t("title"), description: t("description"), path: "/use-cases" });
}

export default async function UseCasesPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("collections.use-cases");
  return (
    <ArticleHub
      eyebrow={t("eyebrow")}
      title={t("title")}
      description={t("description")}
      basePath="/use-cases"
      articles={getArticles(locale, "use-cases")}
    />
  );
}
