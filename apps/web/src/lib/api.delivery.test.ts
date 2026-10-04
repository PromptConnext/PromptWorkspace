import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDecision, resolveDecision, setProjectRole } from "./api";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function respond(body: unknown) {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

afterEach(() => fetchMock.mockReset());

describe("delivery api", () => {
  it("requests a decision with its kind", async () => {
    respond({ id: "d1" });
    await requestDecision("p1", "plan_approval", { Authorization: "Bearer t" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/projects\/p1\/decisions$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ kind: "plan_approval" });
  });

  it("resolves with outcome and rationale", async () => {
    respond({ id: "d1" });
    await resolveDecision("p1", "d1", "rejected", "Add cancellations.", {});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/projects\/p1\/decisions\/d1\/resolve$/);
    expect(JSON.parse(init.body)).toEqual({ outcome: "rejected", rationale: "Add cancellations." });
  });

  it("sets a project role, null clears", async () => {
    respond([]);
    await setProjectRole("p1", "tech_steward", null, {});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/projects\/p1\/roles\/tech_steward$/);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ user_id: null });
  });
});
