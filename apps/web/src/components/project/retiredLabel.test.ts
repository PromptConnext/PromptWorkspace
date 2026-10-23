import { describe, expect, it } from "vitest";
import { retiredLabel } from "./retiredLabel";

describe("retiredLabel", () => {
  it("names the retired tasks", () => {
    expect(retiredLabel(2, ["T003", "T004"])).toBe("2 retired (T003, T004)");
  });

  it("names five, then counts the rest", () => {
    const refs = ["T001", "T002", "T003", "T004", "T005", "T006", "T007"];
    expect(retiredLabel(7, refs)).toBe("7 retired (T001, T002, T003, T004, T005, and 2 more)");
  });

  it("falls back to the count when no refs came back", () => {
    expect(retiredLabel(3)).toBe("3 retired");
    expect(retiredLabel(3, [])).toBe("3 retired");
  });
});
