import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type ContainerProps = {
  as?: ElementType;
  className?: string;
  children: ReactNode;
};

/** Centered max-width wrapper with responsive horizontal padding. */
export function Container({ as: Tag = "div", className, children }: ContainerProps) {
  return (
    <Tag className={cn("mx-auto w-full max-w-6xl px-5 sm:px-6 lg:px-8", className)}>
      {children}
    </Tag>
  );
}
