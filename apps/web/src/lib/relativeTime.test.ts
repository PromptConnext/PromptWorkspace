import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const now = new Date("2026-10-24T12:00:00Z");
describe("relativeTime", () => {
  it("formats minutes, hours, days", () => {
    expect(relativeTime("2026-10-24T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-24T11:59:00Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-10-24T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-10-21T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-08-24T12:00:00Z", now)).toBe("2 months ago");
  });
  it("returns empty for invalid input", () => {
    expect(relativeTime("nope", now)).toBe("");
  });
});
