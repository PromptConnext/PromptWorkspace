import { afterEach, describe, expect, it } from "vitest";

import {
  beforeBreadcrumb,
  beforeSend,
  redactKnownSecrets,
  sanitizeUrl,
  sentryOptions,
} from "./sentry";

// Plan 0021 M2. This app is public and unauthenticated, which makes it the
// easiest one to under-protect and the one where a leak is most visible: the
// data at risk is a visitor's name, email and message, plus
// CONTACT_WEBHOOK_URL — a bearer URL whose authority is its own path.
//
// Ported from apps/web/src/lib/sentry.test.ts. The two scrubs are deliberately
// parallel, and these tests exist so a divergence between them is a failing
// test rather than something a reader has to notice.

const WEBHOOK = "https://hooks.example.com/services/T000/B111/CANARY-WEBHOOK-SECRET";

afterEach(() => {
  delete process.env.CONTACT_WEBHOOK_URL;
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    message: "boom",
    request: {
      url: "https://promptconnext.dev/en/contact",
      method: "POST",
      headers: { "content-type": "application/json", cookie: "sid=abc" },
      cookies: { sid: "abc" },
      data: {
        name: "Dana Visitor",
        email: "dana@acme.example",
        message: "CONFIDENTIAL-ENQUIRY-CANARY",
      },
    },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("beforeSend", () => {
  it("drops the contact-form body, cookies and any query string", () => {
    const scrubbed = beforeSend(event());
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    const body = JSON.stringify(scrubbed);
    expect(body).not.toContain("CONFIDENTIAL-ENQUIRY-CANARY");
    expect(body).not.toContain("dana@acme.example");
  });

  it("redacts credential-shaped headers and keeps benign ones", () => {
    const scrubbed = beforeSend(event());
    expect(scrubbed.request?.headers?.cookie).toBe("[redacted]");
    expect(scrubbed.request?.headers?.["content-type"]).toBe("application/json");
  });

  it("redacts http.query, which no credential-sounding key name matches", () => {
    const scrubbed = beforeSend(
      event({
        breadcrumbs: [
          { category: "http", data: { url: "https://x/y", "http.query": "token=CANARY-Q" } },
        ],
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain("CANARY-Q");
  });

  it("survives an event with no request block at all", () => {
    expect(() => beforeSend({ message: "boom" } as never)).not.toThrow();
  });
});

describe("redactKnownSecrets", () => {
  // The leak this exists for: CONTACT_WEBHOOK_URL's secret IS its path, so no
  // key-name rule reaches it, and Node's fetch puts the target URL into the
  // message of the error it throws — free text, under no key at all.
  it("redacts CONTACT_WEBHOOK_URL out of free-text exception messages", () => {
    process.env.CONTACT_WEBHOOK_URL = WEBHOOK;
    const scrubbed = beforeSend(
      event({
        exception: { values: [{ type: "TypeError", value: `fetch failed for ${WEBHOOK}` }] },
      }),
    );
    const body = JSON.stringify(scrubbed);
    expect(body).not.toContain("CANARY-WEBHOOK-SECRET");
    expect(scrubbed.exception?.values?.[0]?.value).toContain("[redacted]");
  });

  it("redacts it out of the event message and nested extra values too", () => {
    process.env.CONTACT_WEBHOOK_URL = WEBHOOK;
    const scrubbed = beforeSend(
      event({
        message: `posting to ${WEBHOOK}`,
        extra: { target: WEBHOOK, nested: { deeper: [`x ${WEBHOOK} y`] } },
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain("CANARY-WEBHOOK-SECRET");
  });

  it("is a no-op when the webhook is not configured", () => {
    expect(redactKnownSecrets("nothing to redact")).toBe("nothing to redact");
  });

  it("ignores an implausibly short value rather than redacting everything", () => {
    process.env.CONTACT_WEBHOOK_URL = "a";
    expect(redactKnownSecrets("a banana")).toBe("a banana");
  });
});

describe("sanitizeUrl", () => {
  it("drops the query string and the fragment", () => {
    expect(sanitizeUrl("https://promptconnext.dev/en/contact?utm=x#CANARY-FRAG")).toBe(
      "https://promptconnext.dev/en/contact",
    );
    expect(sanitizeUrl("/th/download?v=1")).toBe("/th/download");
  });

  it("handles an origin-only URL and an empty string without throwing", () => {
    expect(sanitizeUrl("https://promptconnext.dev")).toBe("https://promptconnext.dev");
    expect(sanitizeUrl("")).toBe("");
  });

  it("is applied to event.request.url by beforeSend", () => {
    const scrubbed = beforeSend(
      event({ request: { url: "https://promptconnext.dev/en#CANARY-FRAG" } }),
    );
    expect(scrubbed.request?.url).toBe("https://promptconnext.dev/en");
  });
});

describe("beforeBreadcrumb", () => {
  // The load-bearing one for this app: /api/contact runs
  // console.log("[contact] submission", submission) on every submission when no
  // webhook is configured, and console.error(..., submission.email) when
  // delivery fails. The SDK records every console argument.
  it("drops console breadcrumbs, which capture the whole submission", () => {
    expect(
      beforeBreadcrumb({
        category: "console",
        level: "log",
        message: "[contact] submission",
        data: {
          arguments: [{ name: "Dana", email: "dana@acme.example", message: "CANARY-ENQUIRY" }],
        },
      }),
    ).toBeNull();
  });

  it("normalises navigation from/to", () => {
    const crumb = beforeBreadcrumb({
      category: "navigation",
      data: { from: "/en", to: "/en/contact?utm=x#CANARY-FRAG" },
    });
    expect(crumb?.data?.to).toBe("/en/contact");
  });

  it("keeps a non-console breadcrumb that carries nothing sensitive", () => {
    const crumb = beforeBreadcrumb({ category: "ui.click", message: "a[href='/download']" });
    expect(crumb?.message).toBe("a[href='/download']");
  });
});

describe("sentryOptions", () => {
  it("disables every default that would collect visitor data", () => {
    expect(sentryOptions.sendDefaultPii).toBe(false);
    expect(sentryOptions.dataCollection.httpHeaders).toBe(false);
    expect(sentryOptions.dataCollection.httpBodies).toEqual([]);
    expect(sentryOptions.dataCollection.cookies).toBe(false);
    expect(sentryOptions.dataCollection.stackFrameVariables).toBe(false);
    expect(sentryOptions.dataCollection.userInfo).toBe(false);
    expect(sentryOptions.dataCollection.urlQueryParams).toBe(false);
    expect(sentryOptions.includeLocalVariables).toBe(false);
  });

  it("wires both gates, not just beforeSend", () => {
    expect(sentryOptions.beforeSend).toBe(beforeSend);
    expect(sentryOptions.beforeBreadcrumb).toBe(beforeBreadcrumb);
  });

  it("leaves tracing off — plan 0021 M2 is error capture only", () => {
    expect(sentryOptions).not.toHaveProperty("tracesSampleRate");
  });

  it("has no DSN with NEXT_PUBLIC_SENTRY_DSN unset, so init is a no-op", () => {
    expect(sentryOptions.dsn).toBeUndefined();
  });
});
