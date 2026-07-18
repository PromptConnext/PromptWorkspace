import type { Locale } from "@/i18n/routing";

export type ArticleCollection = "compare" | "guides" | "use-cases";

export type ArticleSection = { heading: string; body: string[] };
export type ArticleTable = { title?: string; columns: string[]; rows: string[][] };
export type ArticleFaq = { question: string; answer: string };

export type Article = {
  collection: ArticleCollection;
  slug: string;
  eyebrow: string;
  title: string;
  description: string;
  intro: string[];
  sections: ArticleSection[];
  table?: ArticleTable;
  faqs?: ArticleFaq[];
};

export type ArticlesByLocale = Record<Locale, Article[]>;
