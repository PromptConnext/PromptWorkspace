import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Locale-aware navigation APIs. Use these <Link> / hooks instead of next/link
// so internal hrefs are automatically prefixed with the active locale.
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
