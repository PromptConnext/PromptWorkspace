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

describe("apiFetch error detail", () => {
  function failWith(status: number, body: unknown) {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a string detail as the message", async () => {
    failWith(403, { detail: "admin_required" });
    await expect(apiFetch("/x", {})).rejects.toMatchObject({
      status: 403,
      message: "admin_required",
    });
  });

  it("turns a pydantic 422 detail array into the first item's msg", async () => {
    failWith(422, {
      detail: [{ type: "string_too_short", loc: ["body", "name"], msg: "String should have at least 1 character" }],
    });
    await expect(apiFetch("/x", {})).rejects.toMatchObject({
      status: 422,
      message: "String should have at least 1 character",
    });
  });

  it("falls back to invalid_request for an array with no usable msg", async () => {
    failWith(422, { detail: [{ loc: ["body"] }] });
    await expect(apiFetch("/x", {})).rejects.toMatchObject({ message: "invalid_request" });
    failWith(422, { detail: [] });
    await expect(apiFetch("/x", {})).rejects.toMatchObject({ message: "invalid_request" });
  });
});

describe("apiFetch transient failures", () => {
  const ok = { ok: true, status: 200, json: async () => ({ n: 1 }) };
  const fail = (status: number) => ({ ok: false, status, json: async () => ({ detail: "x" }) });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockFetch(...responses: Array<object | Error>) {
    const fn = vi.fn(async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it("a failed GET is retried once, 400 ms later, on a network error", async () => {
    const fetchMock = mockFetch(new TypeError("Failed to fetch"), ok);
    const result = apiFetch<{ n: number }>("/projects/p1/decisions", {});

    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ n: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])("a GET answered %i is retried once", async (status) => {
    const fetchMock = mockFetch(fail(status), ok);
    const result = apiFetch<{ n: number }>("/projects/p1/decisions", {});
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toEqual({ n: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry and reports the second failure", async () => {
    const fetchMock = mockFetch(fail(503), fail(503), ok);
    const result = apiFetch("/projects/p1/decisions", {});
    const assertion = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry an ordinary refusal", async () => {
    const fetchMock = mockFetch(fail(404), ok);
    const result = apiFetch("/projects/p1/decisions", {});
    const assertion = expect(result).rejects.toMatchObject({ status: 404 });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("a %s is never retried", async (method) => {
    const fetchMock = mockFetch(fail(503), ok);
    const result = apiFetch("/projects/p1/decisions", {}, { method });
    const assertion = expect(result).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a write that fails on the network is not retried either", async () => {
    const fetchMock = mockFetch(new TypeError("Failed to fetch"), ok);
    const result = apiFetch("/projects/p1/decisions", {}, { method: "POST" });
    const assertion = expect(result).rejects.toThrow("Failed to fetch");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
