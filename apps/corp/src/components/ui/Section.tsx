import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Container } from "./Container";

type SectionProps = {
  id?: string;
  className?: string;
  containerClassName?: string;
  children: ReactNode;
};

/** Vertical rhythm wrapper for page sections. */
export function Section({ id, className, containerClassName, children }: SectionProps) {
  return (
    <section id={id} className={cn("py-16 sm:py-20 lg:py-28", className)}>
      <Container className={containerClassName}>{children}</Container>
    </section>
  );
}

type SectionHeadingProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
  className?: string;
};

/** Consistent eyebrow / title / description block for section headers. */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        align === "center" ? "items-center text-center mx-auto max-w-2xl" : "items-start",
        className,
      )}
    >
      {eyebrow ? (
        <span className="text-xs font-semibold uppercase tracking-widest text-accent">
          {eyebrow}
        </span>
      ) : null}
      <h2 className="text-2xl sm:text-3xl lg:text-4xl font-semibold text-text-primary">
        {title}
      </h2>
      {description ? (
        <p className="text-base text-text-secondary max-w-2xl">{description}</p>
      ) : null}
    </div>
  );
}
