import { describe, expect, it } from "vitest";
import { avatarColor, displayName, initial } from "./identity";

describe("identity", () => {
  it("prefers display_name over email", () => {
    expect(displayName({ display_name: "Somchai", email: "s@x.com", user_id: "u" })).toBe(
      "Somchai",
    );
  });

  it("falls back to the email when display_name is null or absent", () => {
    expect(displayName({ display_name: null, email: "s@x.com", user_id: "u" })).toBe("s@x.com");
    expect(displayName({ email: "s@x.com", user_id: "u" })).toBe("s@x.com");
  });

  it("falls back to the user id when there is neither", () => {
    expect(displayName({ email: null, user_id: "u1" })).toBe("u1");
  });

  it("takes the initial from the same source", () => {
    expect(initial({ display_name: "somchai", email: "a@x.com", user_id: "u" })).toBe("S");
    expect(initial({ display_name: null, email: "a@x.com", user_id: "u" })).toBe("A");
  });

  it("colours by the displayed name", () => {
    const a = avatarColor({ display_name: "Somchai", email: "a@x.com", user_id: "u" });
    expect(a).toBe(avatarColor({ display_name: "Somchai", email: "b@x.com", user_id: "v" }));
  });
});
