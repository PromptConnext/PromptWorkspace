import { describe, expect, it } from "vitest";
import { safeNext } from "./next-path";

describe("safeNext", () => {
  it.each([
    "/",
    "/w/x",
    "/oauth/consent?request=1",
    "/oauth/consent?request=a%3Ab",
    "/w/x/p/y:z",
    "/w/x?q=a:b",
  ])("accepts the in-app path %s", (raw) => {
    expect(safeNext(raw)).toBe(raw);
  });

  it.each([
    null,
    "",
    "w/x",
    "//evil.example",
    "/\\evil.example",
    "/\\\\evil.example",
    "/w\\x",
    "javascript:alert(1)",
    "https://evil.example",
    "/javascript:alert(1)",
    "/foo:bar",
    "/\t/evil.example",
    "/\n/evil.example",
  ])("rejects %j", (raw) => {
    expect(safeNext(raw)).toBe("/");
  });
});
