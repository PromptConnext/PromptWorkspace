import { describe, expect, it } from "vitest";
import { commitUrl } from "./VerifyConfirmDialog";

describe("commitUrl", () => {
  it("links a hex commit to the repository's commit page", () => {
    expect(commitUrl("https://github.com/acme/app.git/", "abc1234")).toBe(
      "https://github.com/acme/app/commit/abc1234",
    );
  });

  it("does not link a sha that could leave the repository path", () => {
    expect(commitUrl("https://github.com/acme/app", "../../x/y")).toBeNull();
    expect(commitUrl("https://github.com/acme/app", "abc/../def")).toBeNull();
    expect(commitUrl("https://github.com/acme/app", "abc12")).toBeNull();
  });
});
