import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-text-inverse hover:bg-accent-hover focus-visible:outline-focus-ring",
  secondary:
    "bg-surface-muted text-text-primary border border-border-default hover:border-border-strong focus-visible:outline-focus-ring",
  ghost:
    "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-muted focus-visible:outline-focus-ring",
  danger: "bg-danger text-text-inverse hover:opacity-90 focus-visible:outline-focus-ring",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

type StyleProps = { variant?: Variant; size?: Size; className?: string; children?: ReactNode };

type LinkButtonProps = StyleProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & { href: string };

type NativeButtonProps = StyleProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & { href?: undefined };

/**
 * Polymorphic button. Renders a locale-aware <Link> for internal hrefs, a plain
 * <a> for external hrefs, or a native <button> when no href is given.
 */
export function Button(props: LinkButtonProps | NativeButtonProps) {
  const { variant = "primary", size = "md", className, ...rest } = props;
  const classes = cn(base, variants[variant], sizes[size], className);

  if (typeof props.href === "string") {
    const { href, ...linkRest } = rest as LinkButtonProps;
    if (href.startsWith("http")) {
      return (
        <a href={href} className={classes} target="_blank" rel="noopener noreferrer" {...linkRest}>
          {props.children}
        </a>
      );
    }
    return (
      <Link href={href} className={classes} {...linkRest}>
        {props.children}
      </Link>
    );
  }

  return <button className={classes} {...(rest as NativeButtonProps)} />;
}
