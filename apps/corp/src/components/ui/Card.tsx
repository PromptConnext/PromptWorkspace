import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type CardProps = {
  className?: string;
  children: ReactNode;
};

/** Surface container with border + subtle hover for feature/content blocks. */
export function Card({ className, children }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border-default bg-surface-muted p-6 transition-colors duration-150 hover:border-border-strong",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: CardProps) {
  return (
    <h3 className={cn("text-base font-semibold text-text-primary", className)}>
      {children}
    </h3>
  );
}

export function CardDescription({ children, className }: CardProps) {
  return (
    <p className={cn("mt-2 text-sm leading-relaxed text-text-secondary", className)}>
      {children}
    </p>
  );
}
