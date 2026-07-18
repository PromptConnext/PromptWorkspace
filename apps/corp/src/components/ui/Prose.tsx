import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Long-form text wrapper with sensible typographic defaults for docs, legal,
 * and blog content. Styles nested headings, paragraphs, lists, links, and code.
 */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "max-w-none text-text-secondary",
        "[&>h2]:mt-10 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:text-text-primary sm:[&>h2]:text-2xl",
        "[&>h3]:mt-8 [&>h3]:text-lg [&>h3]:font-semibold [&>h3]:text-text-primary",
        "[&>p]:mt-4 [&>p]:leading-relaxed",
        "[&>ul]:mt-4 [&>ul]:list-disc [&>ul]:pl-6 [&>ul>li]:mt-2",
        "[&>ol]:mt-4 [&>ol]:list-decimal [&>ol]:pl-6 [&>ol>li]:mt-2",
        "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-accent-hover",
        "[&_code]:rounded [&_code]:bg-surface-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em]",
        "[&>pre]:mt-4 [&>pre]:overflow-x-auto [&>pre]:rounded-lg [&>pre]:border [&>pre]:border-border-default [&>pre]:bg-surface-muted [&>pre]:p-4 [&>pre]:text-sm",
        "[&>blockquote]:mt-4 [&>blockquote]:border-l-2 [&>blockquote]:border-accent [&>blockquote]:pl-4 [&>blockquote]:italic",
        className,
      )}
    >
      {children}
    </div>
  );
}
