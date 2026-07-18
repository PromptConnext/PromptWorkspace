import type { Locale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";
import type { Article, ArticleCollection, ArticlesByLocale } from "./types";
import { articlesEn } from "./en";
import { articlesTh } from "./th";

export type { Article, ArticleCollection } from "./types";

const byLocale: ArticlesByLocale = {
  en: articlesEn,
  th: articlesTh,
};

export function getArticles(locale: Locale, collection: ArticleCollection): Article[] {
  return byLocale[locale].filter((a) => a.collection === collection);
}

export function getArticle(
  locale: Locale,
  collection: ArticleCollection,
  slug: string,
): Article | undefined {
  return byLocale[locale].find((a) => a.collection === collection && a.slug === slug);
}

/** All (locale, slug) params for a collection — for generateStaticParams. */
export function getArticleParams(collection: ArticleCollection) {
  const params: { locale: string; slug: string }[] = [];
  for (const locale of routing.locales) {
    for (const article of getArticles(locale, collection)) {
      params.push({ locale, slug: article.slug });
    }
  }
  return params;
}

/** Slugs for a collection in the default locale — for sitemap generation. */
export function getCollectionSlugs(collection: ArticleCollection): string[] {
  return getArticles(routing.defaultLocale, collection).map((a) => a.slug);
}
