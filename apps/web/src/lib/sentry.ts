// Shared Sentry options for every runtime this app has (browser, Node server,
// edge). Plan 0021 M2.
//
// This app talks to exactly one backend, and every call to it carries the
// caller's credential: a Supabase bearer JWT in `Authorization`, or the
// `X-User-Id` header under AUTH_MODE=stub (apps/web/src/lib/auth.ts). Those
// headers are dropped three ways — `dataCollection.httpHeaders: false` stops
// the SDK collecting them at all, `beforeSend` scrubs anything that reaches an
// event anyway, and request bodies are never collected.
//
// A key-name denylist is not enough on its own, and on *this* app that is the
// dangerous half. A security review found two live leaks with no key to match
// on, because the credential was inside a URL:
//
//   1. `httpContextIntegration` sets `event.request.url` to
//      `document.location.href`, **fragment included**. Supabase's
//      password-recovery email lands the user on
//      `/reset-password#access_token=<JWT>&refresh_token=<...>&type=recovery`
//      (src/app/(auth)/reset-password/page.tsx), so any JS error thrown while
//      that page is open shipped a live access *and* refresh token.
//   2. `/invite/<token>` (src/app/invite/[token]/page.tsx) puts a
//      bearer-equivalent invitation token in the path — presenting it is what
//      grants workspace membership.
//
// So `sanitizeUrl` strips the query and fragment from every URL-shaped value
// and redacts path segments under a `SECRET_PATH_PARENTS` prefix, and
// `beforeBreadcrumb` normalises navigation breadcrumbs (`data.from`/`data.to`
// are the same href, by another name) on the way in. Path segments that are
// our own ids — workspace, project, task — are deliberately left alone: they
// are what makes a report actionable.
//
// Errors only this milestone. No `tracesSampleRate` is set, so tracing (and
// with it any outbound-request span carrying a URL or header) stays off —
// plan 0021 M3 is where that is revisited.
//
// With NEXT_PUBLIC_SENTRY_DSN unset — the default in dev and in CI — `dsn` is
// undefined and `Sentry.init` is a no-op: nothing is captured and nothing is
// sent. No build-time env var is required for `next build` to succeed.

import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

export const SENTRY_ENVIRONMENT =
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV;

const REDACTED = "[redacted]";
const MAX_DEPTH = 8;

// Matched as a substring of a normalised key name (`_`, `.` and `-` all count
// as the same separator). Deny-by-default by key *name*, because the values
// are exactly what we don't have in hand at scrub time.
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "x-user-id",
  "x-api-key",
  "token",
  "secret",
  "password",
  "api-key",
  "apikey",
  "access-key",
  "credential",
  "signature",
  "session",
];

// Keys whose value is a query string or fragment — a URL's secret-bearing half
// with none of its useful half. Matched on key *shape*, not on a
// credential-sounding name, because `http.query` contains neither "token" nor
// "secret" and is exactly where the SDK puts one.
const QUERY_KEY_PARTS = ["query", "querystring", "query-string", "fragment", "search"];

// Keys whose value is a URL. Redacting these by name would throw away the
// route, which is most of a report's value, so they get sanitised instead.
const URL_KEY_PARTS = ["url", "uri", "location", "href", "referer", "referrer"];

// A path segment immediately following one of these is a credential, not an
// identifier of ours. Keep this narrow — over-redacting turns the workspace
// and project ids that make a report actionable into noise.
const SECRET_PATH_PARENTS = new Set([
  "invite",
  "invitations",
  "reset-password",
  "verify",
  "confirm",
]);

function normaliseKey(key: string): string {
  return key.replace(/[_.]/g, "-").toLowerCase();
}

/** Whole-name or separator-suffix match — not a substring match, which would
 * make `query` swallow `queryCount`. */
function matchesKey(key: string, parts: string[]): boolean {
  const normalised = normaliseKey(key);
  return parts.some((part) => normalised === part || normalised.endsWith(`-${part}`));
}

function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return (
    SENSITIVE_KEY_PARTS.some((part) => normalised.includes(part)) ||
    matchesKey(key, QUERY_KEY_PARTS)
  );
}

/**
 * Keep origin + path, drop the query string and the fragment, redact secret
 * path segments.
 *
 * Deliberately hand-rolled rather than `new URL()`: breadcrumbs record
 * path-only values (`/invite/abc`), which `new URL()` rejects without a base,
 * and a throw inside `beforeSend` would lose the scrub entirely.
 */
export function sanitizeUrl(raw: string): string {
  if (!raw) return raw;
  let origin = "";
  let rest = raw;
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd !== -1) {
    const pathStart = raw.indexOf("/", schemeEnd + 3);
    if (pathStart === -1) return raw.split(/[?#]/)[0];
    origin = raw.slice(0, pathStart);
    rest = raw.slice(pathStart);
  }
  const segments = rest.split(/[?#]/)[0].split("/");
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i] && SECRET_PATH_PARENTS.has(segments[i - 1].toLowerCase())) {
      segments[i] = REDACTED;
    }
  }
  return origin + segments.join("/");
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else if (matchesKey(key, URL_KEY_PARTS) && typeof item === "string") {
        out[key] = sanitizeUrl(item);
      } else {
        out[key] = scrub(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Last gate before an event leaves the process. Everything here is defence in
 * depth behind the `dataCollection` settings below — if a future SDK version
 * changes a default, or an integration builds an event itself, this still
 * drops the credential.
 */
export function beforeSend(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (typeof event.request.url === "string") {
      // The Supabase recovery tokens live in this URL's fragment and the
      // invitation token in its path. This line is what removes both.
      event.request.url = sanitizeUrl(event.request.url);
    }
    if (event.request.headers) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(event.request.headers)) {
        headers[name] = isSensitiveKey(name) ? REDACTED : value;
      }
      event.request.headers = headers;
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = scrub(event.breadcrumbs) as ErrorEvent["breadcrumbs"];
  }
  if (event.extra) event.extra = scrub(event.extra) as ErrorEvent["extra"];
  if (event.contexts) event.contexts = scrub(event.contexts) as ErrorEvent["contexts"];
  return event;
}

/**
 * Breadcrumbs are their own capture path — `dataCollection` does not govern
 * them — so they get their own gate.
 *
 * Console breadcrumbs are dropped wholesale. The browser SDK records every
 * `console.*` argument, and this codebase logs whole objects (the root
 * error boundary in src/app/global-error.tsx, for one). Auditing every
 * present and future `console.log` for whether its arguments are safe to send
 * to a third party is not a thing anyone will keep doing, so the category is
 * off. Errors themselves still arrive as exceptions, which is the signal.
 */
export function beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") return null;
  const data = breadcrumb.data;
  if (data) {
    // `navigation` breadcrumbs carry the same href as request.url under two
    // other names, fragment included.
    for (const key of ["from", "to", "url", "href"]) {
      if (typeof data[key] === "string") data[key] = sanitizeUrl(data[key] as string);
    }
    for (const key of Object.keys(data)) {
      if (isSensitiveKey(key)) data[key] = REDACTED;
    }
  }
  return breadcrumb;
}

export const sentryOptions = {
  dsn: SENTRY_DSN,
  environment: SENTRY_ENVIRONMENT,
  sendDefaultPii: false,
  // v10's explicit data-collection contract. Every one of these defaults to
  // collecting; each is turned off on purpose:
  //   httpHeaders        — Authorization / X-User-Id (see the header note above)
  //   httpBodies         — request payloads: stage documents, PRD text, discussion content
  //   cookies            — the Supabase session cookie
  //   stackFrameVariables— locals holding an access token mid-refresh
  //   userInfo           — no automatic identity capture; nothing sets a user here
  //   urlQueryParams     — belt and braces with sanitizeUrl above
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    stackFrameVariables: false,
    urlQueryParams: false,
  },
  // Legacy Node-only alias for stackFrameVariables; set for the same reason.
  includeLocalVariables: false,
  beforeSend,
  beforeBreadcrumb,
};
