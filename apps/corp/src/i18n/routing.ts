import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["en", "th"],
  defaultLocale: "en",
  // Explicit prefixes for both locales (/en, /th) keep hreflang unambiguous.
  localePrefix: "always",
});

export type Locale = (typeof routing.locales)[number];
