import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";
import { getProductSlugs } from "@/content/product";
import { getAllPostSlugs } from "@/lib/blog";
import { getCollectionSlugs } from "@/content/articles";
import { routing } from "@/i18n/routing";

const base = siteConfig.url;

function url(locale: string, path: string): string {
  const clean = path === "/" ? "" : path;
  return `${base}/${locale}${clean}`;
}

/** One sitemap entry per locale for a path, with hreflang alternates. */
function entriesFor(
  path: string,
  opts: {
    priority?: number;
    changeFrequency?: MetadataRoute.Sitemap[number]["changeFrequency"];
    lastModified?: Date;
  } = {},
): MetadataRoute.Sitemap {
  const languages: Record<string, string> = {};
  for (const l of routing.locales) languages[l] = url(l, path);

  return routing.locales.map((locale) => ({
    url: url(locale, path),
    lastModified: opts.lastModified ?? new Date(),
    changeFrequency: opts.changeFrequency ?? "monthly",
    priority: opts.priority ?? 0.6,
    alternates: { languages },
  }));
}

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
    { path: "/", priority: 1, changeFrequency: "weekly" },
    { path: "/product", priority: 0.9, changeFrequency: "monthly" },
    { path: "/download", priority: 0.9, changeFrequency: "weekly" },
    { path: "/pricing", priority: 0.8, changeFrequency: "monthly" },
    { path: "/docs", priority: 0.7, changeFrequency: "monthly" },
    { path: "/docs/getting-started", priority: 0.7, changeFrequency: "monthly" },
    { path: "/guides", priority: 0.7, changeFrequency: "weekly" },
    { path: "/use-cases", priority: 0.6, changeFrequency: "monthly" },
    { path: "/compare", priority: 0.8, changeFrequency: "monthly" },
    { path: "/blog", priority: 0.7, changeFrequency: "weekly" },
    { path: "/faq", priority: 0.6, changeFrequency: "monthly" },
    { path: "/about", priority: 0.5, changeFrequency: "yearly" },
    { path: "/contact", priority: 0.5, changeFrequency: "yearly" },
    { path: "/contact/sales", priority: 0.5, changeFrequency: "yearly" },
    { path: "/legal/privacy", priority: 0.3, changeFrequency: "yearly" },
    { path: "/legal/terms", priority: 0.3, changeFrequency: "yearly" },
  ];

  const entries: MetadataRoute.Sitemap = [];

  for (const route of staticRoutes) {
    entries.push(...entriesFor(route.path, { priority: route.priority, changeFrequency: route.changeFrequency }));
  }

  for (const slug of getProductSlugs()) {
    entries.push(...entriesFor(`/product/${slug}`, { priority: 0.7 }));
  }

  for (const collection of ["compare", "guides", "use-cases"] as const) {
    for (const slug of getCollectionSlugs(collection)) {
      entries.push(...entriesFor(`/${collection}/${slug}`, { priority: 0.7 }));
    }
  }

  for (const slug of getAllPostSlugs()) {
    entries.push(...entriesFor(`/blog/${slug}`, { priority: 0.6 }));
  }

  return entries;
}
