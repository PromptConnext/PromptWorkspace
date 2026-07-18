import type { Metadata } from "next";
import { siteConfig } from "@/lib/site";
import { routing, type Locale } from "@/i18n/routing";

type SeoInput = {
  title?: string;
  description?: string;
  /** Active locale, used for canonical + hreflang alternates. */
  locale?: Locale;
  /** Locale-agnostic path, e.g. "/pricing". Locale prefix is added for you. */
  path?: string;
  /** Absolute or root-relative OG image; defaults to the site OG image. */
  image?: string;
  type?: "website" | "article";
  publishedTime?: string;
  noIndex?: boolean;
};

const OG_LOCALE: Record<Locale, string> = { en: "en_US", th: "th_TH" };

/** Build a locale-prefixed absolute URL from a locale-agnostic path. */
function localizedUrl(locale: string, path: string): string {
  const clean = path === "/" ? "" : path;
  return new URL(`/${locale}${clean}`, siteConfig.url).toString();
}

/**
 * Build a complete Next.js Metadata object with canonical URL, hreflang
 * alternates (en/th + x-default), Open Graph, and Twitter cards.
 */
export function createMetadata({
  title,
  description = siteConfig.description,
  locale = routing.defaultLocale,
  path = "/",
  image = "/opengraph-image",
  type = "website",
  publishedTime,
  noIndex = false,
}: SeoInput = {}): Metadata {
  const fullTitle = title
    ? `${title} — ${siteConfig.name}`
    : `${siteConfig.name} — ${siteConfig.tagline}`;
  const canonical = localizedUrl(locale, path);

  const languages: Record<string, string> = {};
  for (const l of routing.locales) languages[l] = localizedUrl(l, path);
  languages["x-default"] = localizedUrl(routing.defaultLocale, path);

  return {
    metadataBase: new URL(siteConfig.url),
    title: title ?? undefined,
    description,
    alternates: { canonical, languages },
    robots: noIndex ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: {
      type,
      url: canonical,
      siteName: siteConfig.name,
      title: fullTitle,
      description,
      locale: OG_LOCALE[locale],
      images: [{ url: image, width: 1200, height: 630, alt: fullTitle }],
      ...(publishedTime ? { publishedTime } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      site: siteConfig.twitter,
      images: [image],
    },
  };
}

/** JSON-LD for the organization + software application (used on the home page). */
export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    sameAs: [siteConfig.githubUrl],
  };
}

export function softwareApplicationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteConfig.name,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Windows",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    description: siteConfig.description,
    url: siteConfig.url,
  };
}

export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: siteConfig.url,
  };
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: new URL(item.path, siteConfig.url).toString(),
    })),
  };
}

export function faqJsonLd(faqs: { question: string; answer: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}
