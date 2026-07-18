import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { MDXRemote } from "next-mdx-remote/rsc";
import { Link } from "@/i18n/navigation";
import { PageHero } from "@/components/sections/PageHero";
import { CTASection } from "@/components/sections/CTASection";
import { Section } from "@/components/ui/Section";
import { Prose } from "@/components/ui/Prose";
import { Badge } from "@/components/ui/Badge";
import { JsonLd } from "@/components/ui/JsonLd";
import { createMetadata, breadcrumbJsonLd } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import { getPostBySlug, getAllPostSlugs, formatDate } from "@/lib/blog";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale; slug: string }> };

export function generateStaticParams() {
  return getAllPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = getPostBySlug(locale, slug);
  if (!post) return createMetadata({ locale, title: "Blog", path: "/blog" });
  return createMetadata({
    locale,
    title: post.title,
    description: post.description,
    path: `/blog/${post.slug}`,
    type: "article",
    publishedTime: post.date || undefined,
  });
}

export default async function BlogPostPage({ params }: Params) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const post = getPostBySlug(locale, slug);
  if (!post) notFound();
  const t = await getTranslations("blog");

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": post.category === "release" ? "TechArticle" : "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    author: { "@type": "Organization", name: post.author ?? siteConfig.name },
    url: new URL(`/${locale}/blog/${post.slug}`, siteConfig.url).toString(),
  };

  return (
    <>
      <JsonLd data={articleJsonLd} />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: post.title, path: `/blog/${post.slug}` },
        ])}
      />
      <PageHero eyebrow={t("eyebrow")} title={post.title} description={post.description}>
        <div className="flex items-center gap-3 text-sm text-text-tertiary">
          {post.category === "release" ? <Badge>{t("release")}</Badge> : null}
          <span>{formatDate(post.date, locale)}</span>
          {post.author ? <span>· {post.author}</span> : null}
        </div>
      </PageHero>
      <Section>
        <article className="mx-auto max-w-3xl">
          <Prose>
            <MDXRemote source={post.content} />
          </Prose>
          <div className="mt-12 border-t border-border-muted pt-6">
            <Link href="/blog" className="text-sm text-accent hover:underline">
              ← {t("back")}
            </Link>
          </div>
        </article>
      </Section>
      <CTASection />
    </>
  );
}

export const dynamicParams = false;
