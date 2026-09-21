// Shared Sentry options for every runtime this app has (browser, Node server,
// edge). Plan 0021 M2.
//
// This is the public, unauthenticated marketing site: it reaches no engine and
// no cloud API, so there is no bearer token or workspace credential here to
// leak. It is not therefore a free pass. The site has one server route,
// `/api/contact`, and an exception in it sits directly on top of two things
// that must not be reported: the visitor's submitted name, email and message,
// and `CONTACT_WEBHOOK_URL`, the private forwarding endpoint it POSTs to. So
// `apps/corp` runs the same deny-by-default shape as `apps/web` rather than a
// lighter one — the two files are deliberately parallel, so a reader comparing
// them sees one policy, not two.
//
// Three things here are not key-name scrubbing, because three of the leaks a
// security review found had no key to match on:
//
//   1. `sanitizeUrl` strips the query string and fragment from URL-shaped
//      values. `NEXT_PUBLIC_*` values are public by definition, but a visitor
//      can put anything in a URL and the fragment is captured verbatim.
//   2. `redactKnownSecrets` redacts `CONTACT_WEBHOOK_URL` **by value**. Its
//      secret is the whole URL — a Slack/Zapier hook's authority is its path,
//      not a named field — so no key-name rule can catch it, and it appears in
//      exception messages rather than in a tidy `webhook:` property. This is
//      the one place in either app where a value-based redaction is worth it:
//      there is exactly one such secret and we hold it.
//   3. `beforeBreadcrumb` drops `console` breadcrumbs. `/api/contact` logs the
//      full submission (`console.log("[contact] submission", submission)`) when
//      no webhook is configured, and the SDK records every console argument.
//
// Errors only this milestone; no `tracesSampleRate` is set, so tracing stays
// off (plan 0021 M3). With NEXT_PUBLIC_SENTRY_DSN unset — the default in dev
// and in CI — `Sentry.init` is a no-op and `next build` needs nothing extra.

import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

export const SENTRY_ENVIRONMENT =
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV;

const REDACTED = "[redacted]";
const MAX_DEPTH = 8;

// Matched as a substring of a normalised key name (`_`, `.` and `-` all count
// as the same separator).
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "x-api-key",
  "token",
  "secret",
  "password",
  "api-key",
  "apikey",
  "credential",
  "signature",
  "session",
  // Catches a key *named* for the webhook. The URL's own value is handled by
  // redactKnownSecrets below, which is the part that actually matters.
  "webhook",
];

// Keys whose value is a query string or fragment — matched on key shape, not
// on a credential-sounding name, because `http.query` contains neither.
const QUERY_KEY_PARTS = ["query", "querystring", "query-string", "fragment", "search"];

// Keys whose value is a URL: sanitised rather than redacted, so the report
// still says which page or call it was.
const URL_KEY_PARTS = ["url", "uri", "location", "href", "referer", "referrer"];

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
 * Keep origin + path, drop the query string and the fragment.
 *
 * Hand-rolled rather than `new URL()`: breadcrumbs record path-only values,
 * which `new URL()` rejects without a base, and a throw inside `beforeSend`
 * would lose the scrub entirely.
 */
export function sanitizeUrl(raw: string): string {
  if (!raw) return raw;
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd !== -1) {
    const pathStart = raw.indexOf("/", schemeEnd + 3);
    if (pathStart === -1) return raw.split(/[?#]/)[0];
    return raw.slice(0, pathStart) + raw.slice(pathStart).split(/[?#]/)[0];
  }
  return raw.split(/[?#]/)[0];
}

/**
 * Redact this app's one server-side secret wherever it appears in a string.
 *
 * `CONTACT_WEBHOOK_URL` is a bearer URL: whoever has it can post to the
 * customer's CRM. Node's fetch puts the target URL in the message of the error
 * it throws when a request fails, which is precisely the exception
 * `/api/contact` catches and could later rethrow — a free-text string, under
 * no key at all. Reading the env var at call time (not at module load) keeps
 * this correct in tests and under a runtime config change; it is `undefined` in
 * the browser bundle, where the secret does not exist.
 */
export function redactKnownSecrets(text: string): string {
  const webhook = process.env.CONTACT_WEBHOOK_URL;
  if (!webhook || webhook.length < 8) return text;
  return text.split(webhook).join(REDACTED);
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else if (matchesKey(key, URL_KEY_PARTS) && typeof item === "string") {
        out[key] = redactKnownSecrets(sanitizeUrl(item));
      } else {
        out[key] = scrub(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Last gate before an event leaves the process — defence in depth behind the
 * `dataCollection` settings below. */
export function beforeSend(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    // A /api/contact submission: name, email, company, message.
    delete event.request.data;
    delete event.request.query_string;
    if (typeof event.request.url === "string") {
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
  // The webhook URL arrives in free text, so the exception message and the
  // event message are scrubbed too, not just the structured containers.
  if (typeof event.message === "string") event.message = redactKnownSecrets(event.message);
  for (const entry of event.exception?.values ?? []) {
    if (typeof entry.value === "string") entry.value = redactKnownSecrets(entry.value);
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
 * Console breadcrumbs are dropped wholesale, and on this app that is the
 * load-bearing one: `/api/contact` runs
 * `console.log("[contact] submission", submission)` on every submission when
 * `CONTACT_WEBHOOK_URL` is unset, and `console.error("[contact] webhook
 * delivery failed", submission.email)` when delivery fails. The SDK records
 * every console argument, so without this a single later exception in that
 * route would carry a visitor's name, email, company and message.
 */
export function beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") return null;
  const data = breadcrumb.data;
  if (data) {
    for (const key of ["from", "to", "url", "href"]) {
      if (typeof data[key] === "string") {
        data[key] = redactKnownSecrets(sanitizeUrl(data[key] as string));
      }
    }
    for (const key of Object.keys(data)) {
      if (isSensitiveKey(key)) data[key] = REDACTED;
    }
  }
  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = redactKnownSecrets(breadcrumb.message);
  }
  return breadcrumb;
}

export const sentryOptions = {
  dsn: SENTRY_DSN,
  environment: SENTRY_ENVIRONMENT,
  sendDefaultPii: false,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    // The /api/contact body is a visitor's personal details.
    httpBodies: [],
    // `webhook` and `submission` are locals in the /api/contact handler.
    stackFrameVariables: false,
    urlQueryParams: false,
  },
  // Legacy Node-only alias for stackFrameVariables; set for the same reason.
  includeLocalVariables: false,
  beforeSend,
  beforeBreadcrumb,
};
