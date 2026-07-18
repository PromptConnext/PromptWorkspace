"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/** Toggles between locales while staying on the same page. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className={cn("inline-flex items-center gap-1 text-xs", className)} role="group" aria-label="Language">
      {routing.locales.map((l, i) => (
        <span key={l} className="flex items-center gap-1">
          {i > 0 ? <span className="text-text-tertiary">/</span> : null}
          <button
            type="button"
            onClick={() => router.replace(pathname, { locale: l })}
            aria-current={locale === l ? "true" : undefined}
            className={cn(
              "rounded px-1 py-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring",
              locale === l ? "text-text-primary font-semibold" : "text-text-tertiary hover:text-text-primary",
            )}
          >
            {l === "th" ? "ไทย" : "EN"}
          </button>
        </span>
      ))}
    </div>
  );
}
