import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Container } from "@/components/ui/Container";
import { Link } from "@/i18n/navigation";
import { Section, SectionHeading } from "@/components/ui/Section";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JsonLd } from "@/components/ui/JsonLd";
import { FeatureGrid } from "@/components/sections/FeatureGrid";
import { CTASection } from "@/components/sections/CTASection";
import { createMetadata, softwareApplicationJsonLd } from "@/lib/seo";
import type { Locale } from "@/i18n/routing";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return createMetadata({ locale, path: "/" });
}

export default async function HomePage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");

  const byoFeatures = [
    { title: t("byo.f1Title"), description: t("byo.f1Desc"), icon: "🔌" },
    { title: t("byo.f2Title"), description: t("byo.f2Desc"), icon: "🖥️" },
    { title: t("byo.f3Title"), description: t("byo.f3Desc"), icon: "🤖" },
  ];

  const threeS = [
    { title: t("threeS.scopeTitle"), description: t("threeS.scopeDesc") },
    { title: t("threeS.specTitle"), description: t("threeS.specDesc") },
    { title: t("threeS.skillTitle"), description: t("threeS.skillDesc") },
  ];

  return (
    <>
      <JsonLd data={softwareApplicationJsonLd()} />

      <section className="hero-glow relative overflow-hidden border-b border-border-muted">
        <Container className="flex flex-col items-center py-20 text-center sm:py-28">
          <Badge className="mb-6">{t("hero.badge")}</Badge>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
            {t("hero.title")}
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-text-secondary">{t("hero.subtitle")}</p>
          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <Button href="/download" size="lg">
              {t("hero.download")}
            </Button>
            <Button href="/product/3s-workflow" variant="secondary" size="lg">
              {t("hero.how")}
            </Button>
          </div>
          <p className="mt-4 text-xs text-text-tertiary">{t("hero.note")}</p>
        </Container>
      </section>

      <Section>
        <SectionHeading eyebrow={t("threeS.eyebrow")} title={t("threeS.title")} description={t("threeS.description")} />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {threeS.map((stage, i) => (
            <Card key={stage.title}>
              <span className="text-xs font-semibold text-accent">
                {t("threeS.step")} {i + 1}
              </span>
              <CardTitle className="mt-2 text-lg">{stage.title}</CardTitle>
              <CardDescription>{stage.description}</CardDescription>
            </Card>
          ))}
        </div>
      </Section>

      <Section className="border-y border-border-muted bg-surface-muted/30">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <SectionHeading align="left" eyebrow={t("dual.eyebrow")} title={t("dual.title")} description={t("dual.description")} />
            <div className="mt-8 flex flex-wrap gap-3">
              <Button href="/product/collaboration">{t("dual.explore")}</Button>
              <Button href="/product/task-graph" variant="ghost">
                {t("dual.seeGraph")}
              </Button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardTitle>{t("dual.businessTitle")}</CardTitle>
              <CardDescription>{t("dual.businessDesc")}</CardDescription>
            </Card>
            <Card>
              <CardTitle>{t("dual.devTitle")}</CardTitle>
              <CardDescription>{t("dual.devDesc")}</CardDescription>
            </Card>
          </div>
        </div>
      </Section>

      <Section>
        <SectionHeading eyebrow={t("byo.eyebrow")} title={t("byo.title")} description={t("byo.description")} />
        <div className="mt-12">
          <FeatureGrid features={byoFeatures} />
        </div>
        <p className="mx-auto mt-8 max-w-2xl rounded-lg border border-border-default bg-surface-muted px-5 py-4 text-center text-sm text-text-tertiary">
          {t("byo.honesty")}
        </p>
      </Section>

      <Section className="border-t border-border-muted">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div className="order-2 lg:order-1">
            <div className="rounded-xl border border-border-default bg-surface-muted p-6 font-mono text-xs leading-relaxed text-text-secondary">
              <div className="text-text-tertiary">requirement</div>
              <div className="pl-3">└─ spec ✓ approved</div>
              <div className="pl-6">└─ task: build login form · implemented</div>
              <div className="pl-9">└─ agent-run: claude-code · succeeded</div>
              <div className="pl-9">└─ artifact: PR #128 · merged</div>
            </div>
          </div>
          <div className="order-1 lg:order-2">
            <SectionHeading align="left" eyebrow={t("transparency.eyebrow")} title={t("transparency.title")} description={t("transparency.description")} />
            <div className="mt-8">
              <Button href="/product/task-graph">{t("transparency.cta")}</Button>
            </div>
          </div>
        </div>
      </Section>

      <Section className="border-t border-border-muted">
        <SectionHeading title={t("integrations.title")} description={t("integrations.description")} />
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {["Claude Code", "Gemini CLI", "Codex CLI", "Ollama", "OpenRouter", "MCP", "Jira", "ClickUp"].map((name) => (
            <Badge key={name}>{name}</Badge>
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-text-tertiary">
          <Link href="/product/integrations" className="text-accent hover:underline">
            {t("integrations.viewAll")}
          </Link>
        </p>
      </Section>

      <CTASection />
    </>
  );
}
