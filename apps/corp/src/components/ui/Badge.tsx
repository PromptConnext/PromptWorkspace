import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BadgeProps = {
  children: ReactNode;
  className?: string;
};

/** Small pill used for labels and status hints. */
export function Badge({ children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border-default bg-surface-muted px-3 py-1 text-xs font-medium text-text-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}
