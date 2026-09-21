/**
 * `apiFetch` is the single egress point for every cloud call this app makes,
 * which is why plan 0021 M3 puts the request id here and nowhere else: one
 * line covers every route, and a route added later cannot forget it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch, listMembers, setTaskStatus } from "./api";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function headersOf(call: number): Record<string, string> {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return (mock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;
}

describe("apiFetch request id", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an X-Request-Id the cloud can echo and log", async () => {
    await apiFetch("/projects/p1", { "X-User-Id": "alice" });

    const headers = headersOf(0);
    expect(headers["X-Request-Id"]).toMatch(UUID_V4);
    // The header the cloud reads is case-insensitive on the wire, but the
    // value has to be there under exactly one name.
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === "x-request-id")).toHaveLength(1);
  });

  it("mints a fresh id per call, so two failures are two greps", async () => {
    await apiFetch("/projects/p1", {});
    await apiFetch("/projects/p1", {});

    expect(headersOf(0)["X-Request-Id"]).not.toEqual(headersOf(1)["X-Request-Id"]);
  });

  it("carries the id on every wrapper, GET and PATCH alike", async () => {
    await listMembers("w1", { "X-User-Id": "alice" });
    await setTaskStatus("p1", "t1", "in_progress", { "X-User-Id": "alice" });

    expect(headersOf(0)["X-Request-Id"]).toMatch(UUID_V4);
    expect(headersOf(1)["X-Request-Id"]).toMatch(UUID_V4);
    // And the call itself is unchanged by the addition.
    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1][1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ status: "in_progress" }));
  });

  it("leaves the auth headers and content type alone", async () => {
    await apiFetch("/projects/p1", { Authorization: "Bearer token-abc" });

    const headers = headersOf(0);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer token-abc");
  });

  it("still sends an id where crypto.randomUUID is unavailable", async () => {
    /**
     * `crypto.randomUUID` needs a secure context. A plain-http internal host
     * is not one, and there the property is simply undefined — without the
     * fallback every cloud call in the app would throw rather than lose an id.
     */
    // `stubGlobal`, not assignment: `crypto` is a getter-only global.
    vi.stubGlobal("crypto", {});
    try {
      await apiFetch("/projects/p1", {});
    } finally {
      vi.unstubAllGlobals();
    }

    const id = headersOf(0)["X-Request-Id"];
    expect(id).toMatch(/^web-[a-z0-9]+-[a-z0-9]+$/);
  });
});
