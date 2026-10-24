import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_API_URL } from "./config";
import {
  approveConsent,
  denyConsent,
  getConsent,
  listOauthGrants,
  revokeAllOauthGrants,
  revokeOauthGrant,
} from "./api";

const H = { authorization: "Bearer tok" };

function call(i: number): [string, RequestInit] {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[i] as [string, RequestInit];
}

describe("OAuth API wrappers", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends the bearer only, never a cookie", async () => {
    await getConsent("r/1", H);
    await approveConsent("r1", H);
    await denyConsent("r1", H);
    const urls = [0, 1, 2].map((i) => call(i)[0]);
    expect(urls).toEqual([
      `${CLOUD_API_URL}/oauth/authorize/r%2F1`,
      `${CLOUD_API_URL}/oauth/authorize/r1/approve`,
      `${CLOUD_API_URL}/oauth/authorize/r1/deny`,
    ]);
    expect(call(1)[1].method).toBe("POST");
    expect(call(2)[1].method).toBe("POST");
    for (const i of [0, 1, 2]) {
      expect(call(i)[1].credentials).toBeUndefined();
      expect((call(i)[1].headers as Record<string, string>).authorization).toBe("Bearer tok");
    }
  });

  it("lists and revokes grants", async () => {
    await listOauthGrants(H);
    await revokeOauthGrant("fam1", H);
    await revokeAllOauthGrants(H);
    expect(call(0)[0]).toBe(`${CLOUD_API_URL}/me/oauth-grants`);
    expect(call(1)[0]).toBe(`${CLOUD_API_URL}/me/oauth-grants/fam1`);
    expect(call(1)[1].method).toBe("DELETE");
    expect(call(2)[0]).toBe(`${CLOUD_API_URL}/me/oauth-grants`);
    expect(call(2)[1].method).toBe("DELETE");
  });
});
