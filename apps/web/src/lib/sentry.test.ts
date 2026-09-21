import { describe, expect, it } from "vitest";

import { beforeBreadcrumb, beforeSend, sanitizeUrl, sentryOptions } from "./sentry";

// Plan 0021 M2. Every cloud call this app makes carries the caller's
// credential — a Supabase bearer JWT, or the X-User-Id header under
// AUTH_MODE=stub (apps/web/src/lib/auth.ts) — and `apiFetch` puts it in a
// request header on every single one. An error reporter that captured request
// headers would ship a live session token to a third party.
//
// Headers were the easy half. The half a key-name denylist cannot see is a
// credential sitting inside a URL, and this app has two of those on real
// routes — see the `describe("sanitizeUrl")` block below.

const BEARER = "eyJhbGciOiJFUzI1NiJ9.CANARY-ACCESS-TOKEN.signature";
const REFRESH = "CANARY-REFRESH-TOKEN";
const INVITE = "CANARY-INVITE-TOKEN";

function event(overrides: Record<string, unknown> = {}) {
  return {
    message: "boom",
    request: {
      url: "https://app.example.com/w/ws-1/p/p1/settings",
      method: "PATCH",
      headers: {
        authorization: `Bearer ${BEARER}`,
        "X-User-Id": "alice",
        "content-type": "application/json",
      },
      cookies: { "sb-access-token": BEARER },
      data: { content: "CONFIDENTIAL-PLAN-CANARY" },
    },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("beforeSend", () => {
  it("redacts the Authorization header whatever its casing", () => {
    const scrubbed = beforeSend(event());
    expect(scrubbed.request?.headers?.authorization).toBe("[redacted]");
    expect(JSON.stringify(scrubbed)).not.toContain("CANARY-ACCESS-TOKEN");
  });

  it("redacts X-User-Id, which is the whole credential in stub auth mode", () => {
    const scrubbed = beforeSend(event());
    expect(scrubbed.request?.headers?.["X-User-Id"]).toBe("[redacted]");
  });

  it("keeps benign headers and our own ids in the path", () => {
    const scrubbed = beforeSend(event());
    expect(scrubbed.request?.headers?.["content-type"]).toBe("application/json");
    // Workspace and project ids are ours, not credentials, and they are what
    // makes a report actionable.
    expect(scrubbed.request?.url).toBe("https://app.example.com/w/ws-1/p/p1/settings");
  });

  it("drops cookies, the request body and any query string", () => {
    const scrubbed = beforeSend(event());
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain("CONFIDENTIAL-PLAN-CANARY");
  });

  it("scrubs credential-shaped keys nested in breadcrumbs, extra and contexts", () => {
    const scrubbed = beforeSend(
      event({
        breadcrumbs: [
          { category: "fetch", data: { url: "https://cloud", access_token: BEARER } },
        ],
        extra: { authHeaders: { Authorization: `Bearer ${BEARER}` }, projectId: "p1" },
        contexts: { session: { id: BEARER } },
      }),
    );
    const body = JSON.stringify(scrubbed);
    expect(body).not.toContain("CANARY-ACCESS-TOKEN");
    expect((scrubbed.extra as Record<string, unknown>).projectId).toBe("p1");
    expect(
      (scrubbed.breadcrumbs as unknown as { data: Record<string, unknown> }[])[0].data.url,
    ).toBe("https://cloud");
  });

  it("redacts http.query, which no credential-sounding key name matches", () => {
    const scrubbed = beforeSend(
      event({
        breadcrumbs: [
          {
            category: "http",
            data: { url: "https://cloud/ws", "http.query": `token=${BEARER}`, "http.fragment": "" },
          },
        ],
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain("CANARY-ACCESS-TOKEN");
  });

  it("survives an event with no request block at all", () => {
    expect(() => beforeSend({ message: "boom" } as never)).not.toThrow();
  });
});

describe("sanitizeUrl", () => {
  // THE reason this function exists. httpContextIntegration sets
  // event.request.url to document.location.href, fragment included, and
  // Supabase's password-recovery email lands the user on exactly this URL
  // (src/app/(auth)/reset-password/page.tsx). Before this, any JS error thrown
  // while that page was open shipped a live access AND refresh token.
  it("strips the Supabase recovery tokens out of the URL fragment", () => {
    const href =
      `https://app.example.com/reset-password#access_token=${BEARER}` +
      `&refresh_token=${REFRESH}&type=recovery`;
    expect(sanitizeUrl(href)).toBe("https://app.example.com/reset-password");
  });

  it("redacts the invitation token, which is a bearer-equivalent in the path", () => {
    // /invite/<token> — presenting it is what grants workspace membership
    // (src/app/invite/[token]/page.tsx).
    expect(sanitizeUrl(`https://app.example.com/invite/${INVITE}`)).toBe(
      "https://app.example.com/invite/[redacted]",
    );
    // Breadcrumbs record path-only values, so that form has to work too.
    expect(sanitizeUrl(`/invite/${INVITE}`)).toBe("/invite/[redacted]");
  });

  it("drops a query string", () => {
    expect(sanitizeUrl(`https://app.example.com/login?next=/w/1&token=${BEARER}`)).toBe(
      "https://app.example.com/login",
    );
  });

  it("leaves our own identifiers alone", () => {
    const url = "https://app.example.com/w/ws-1/p/p1";
    expect(sanitizeUrl(url)).toBe(url);
  });

  it("handles an origin-only URL and an empty string without throwing", () => {
    expect(sanitizeUrl("https://app.example.com")).toBe("https://app.example.com");
    expect(sanitizeUrl("")).toBe("");
  });

  it("is applied to event.request.url by beforeSend", () => {
    const scrubbed = beforeSend(
      event({
        request: { url: `https://app.example.com/reset-password#access_token=${BEARER}` },
      }),
    );
    expect(scrubbed.request?.url).toBe("https://app.example.com/reset-password");
    expect(JSON.stringify(scrubbed)).not.toContain("CANARY-ACCESS-TOKEN");
  });
});

describe("beforeBreadcrumb", () => {
  it("drops console breadcrumbs, which capture every logged argument", () => {
    expect(
      beforeBreadcrumb({ category: "console", message: `token ${BEARER}`, level: "log" }),
    ).toBeNull();
  });

  it("normalises navigation from/to, which are hrefs by another name", () => {
    const crumb = beforeBreadcrumb({
      category: "navigation",
      data: { from: "/login", to: `/reset-password#access_token=${BEARER}` },
    });
    expect(crumb?.data?.to).toBe("/reset-password");
    expect(JSON.stringify(crumb)).not.toContain("CANARY-ACCESS-TOKEN");
  });

  it("keeps a non-console breadcrumb that carries nothing sensitive", () => {
    const crumb = beforeBreadcrumb({
      category: "ui.click",
      message: "button[type=submit]",
    });
    expect(crumb?.message).toBe("button[type=submit]");
  });
});

describe("sentryOptions", () => {
  it("disables every default that would collect customer data", () => {
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
    // vitest.config.ts sets no NEXT_PUBLIC_SENTRY_DSN, matching dev and CI.
    expect(sentryOptions.dsn).toBeUndefined();
  });
});
