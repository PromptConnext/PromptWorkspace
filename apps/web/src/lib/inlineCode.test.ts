import { describe, expect, it } from "vitest";
import { plainInlineCode, splitInlineCode } from "./inlineCode";

describe("splitInlineCode", () => {
  it("splits backtick pairs into code runs", () => {
    expect(splitInlineCode("Create structure: `src/consent/`, `src/auth/`")).toEqual([
      { text: "Create structure: ", code: false },
      { text: "src/consent/", code: true },
      { text: ", ", code: false },
      { text: "src/auth/", code: true },
    ]);
  });

  it("leaves text without backticks as one plain run", () => {
    expect(splitInlineCode("Login form")).toEqual([{ text: "Login form", code: false }]);
    expect(splitInlineCode("")).toEqual([]);
  });

  it("keeps an unpaired backtick literal", () => {
    expect(splitInlineCode("Use `a` and ` alone")).toEqual([
      { text: "Use ", code: false },
      { text: "a", code: true },
      { text: " and ` alone", code: false },
    ]);
    expect(splitInlineCode("it`s")).toEqual([{ text: "it`s", code: false }]);
  });

  it("keeps an empty pair literal", () => {
    expect(splitInlineCode("a `` b")).toEqual([{ text: "a `` b", code: false }]);
  });
});

describe("plainInlineCode", () => {
  it("drops paired backticks and keeps unpaired ones", () => {
    expect(plainInlineCode("Add `src/auth/` module")).toBe("Add src/auth/ module");
    expect(plainInlineCode("it`s")).toBe("it`s");
  });
});
