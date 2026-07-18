import type { ReactNode } from "react";
import { Container } from "@/components/ui/Container";

type PageHeroProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
};

/** Standard interior-page hero used by non-home pages. */
export function PageHero({ eyebrow, title, description, children }: PageHeroProps) {
  return (
    <section className="border-b border-border-muted">
      <Container className="py-16 sm:py-20">
        {eyebrow ? (
          <span className="text-xs font-semibold uppercase tracking-widest text-accent">
            {eyebrow}
          </span>
        ) : null}
        <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl lg:text-5xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-5 max-w-2xl text-lg text-text-secondary">{description}</p>
        ) : null}
        {children ? <div className="mt-8">{children}</div> : null}
      </Container>
    </section>
  );
}
