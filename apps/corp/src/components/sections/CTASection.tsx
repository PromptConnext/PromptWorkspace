import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";

type CTASectionProps = {
  title?: string;
  description?: string;
};

/** Shared bottom-of-page call to action — download-first, signup second. */
export async function CTASection({ title, description }: CTASectionProps) {
  const t = await getTranslations("cta");
  return (
    <Section>
      <div className="hero-glow rounded-xl border border-border-default bg-surface-muted px-6 py-14 text-center sm:px-12">
        <h2 className="mx-auto max-w-2xl text-2xl font-semibold text-text-primary sm:text-3xl">
          {title ?? t("title")}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-text-secondary">
          {description ?? t("description")}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/download" size="lg">
            {t("download")}
          </Button>
          <Button href="/contact/sales" variant="secondary" size="lg">
            {t("sales")}
          </Button>
        </div>
      </div>
    </Section>
  );
}
