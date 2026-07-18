import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { Locale } from "@/i18n/routing";
import { routing } from "@/i18n/routing";

const BLOG_ROOT = path.join(process.cwd(), "content", "blog");

function localeDir(locale: Locale): string {
  return path.join(BLOG_ROOT, locale);
}

export type PostMeta = {
  slug: string;
  title: string;
  description: string;
  date: string;
  author?: string;
  tags?: string[];
  category?: "blog" | "release";
};

export type Post = PostMeta & { content: string };

function readPostFile(dir: string, fileName: string): Post {
  const slug = fileName.replace(/\.mdx?$/, "");
  const raw = fs.readFileSync(path.join(dir, fileName), "utf8");
  const { data, content } = matter(raw);
  return {
    slug,
    title: String(data.title ?? slug),
    description: String(data.description ?? ""),
    date: String(data.date ?? ""),
    author: data.author ? String(data.author) : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    category: data.category === "release" ? "release" : "blog",
    content,
  };
}

/** All posts for a locale, newest first. Falls back to nothing if empty. */
export function getAllPosts(locale: Locale): Post[] {
  const dir = localeDir(locale);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => readPostFile(dir, f))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function getPostBySlug(locale: Locale, slug: string): Post | undefined {
  return getAllPosts(locale).find((p) => p.slug === slug);
}

/** Unique slugs across all locales — for generateStaticParams. */
export function getAllPostSlugs(): string[] {
  const slugs = new Set<string>();
  for (const locale of routing.locales) {
    for (const post of getAllPosts(locale)) slugs.add(post.slug);
  }
  return [...slugs];
}

export function formatDate(date: string, locale: Locale): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString(locale === "th" ? "th-TH" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
