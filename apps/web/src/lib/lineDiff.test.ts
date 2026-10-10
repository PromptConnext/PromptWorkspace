import { describe, expect, it } from "vitest";
import { lineDiff } from "./lineDiff";

const kinds = (d: ReturnType<typeof lineDiff>) => d.map((l) => `${l.kind}:${l.text}`);

describe("lineDiff", () => {
  it("marks every line of identical documents as same", () => {
    expect(kinds(lineDiff("a\nb\nc", "a\nb\nc"))).toEqual(["same:a", "same:b", "same:c"]);
  });

  it("marks a pure addition", () => {
    expect(kinds(lineDiff("a\nc", "a\nb\nc"))).toEqual(["same:a", "add:b", "same:c"]);
    expect(kinds(lineDiff("", "x\ny"))).toEqual(["add:x", "add:y"]);
  });

  it("marks a pure deletion", () => {
    expect(kinds(lineDiff("a\nb\nc", "a\nc"))).toEqual(["same:a", "del:b", "same:c"]);
    expect(kinds(lineDiff("x\ny", ""))).toEqual(["del:x", "del:y"]);
  });

  it("shows a changed line as a deletion then an addition", () => {
    expect(kinds(lineDiff("a\nold\nc", "a\nnew\nc"))).toEqual([
      "same:a",
      "del:old",
      "add:new",
      "same:c",
    ]);
  });

  it("treats a reorder as the minimal delete plus add, losing no line", () => {
    const d = lineDiff("a\nb\nc", "c\na\nb");
    expect(d.filter((l) => l.kind === "same").map((l) => l.text)).toEqual(["a", "b"]);
    // Replaying the diff reproduces both documents exactly.
    expect(d.filter((l) => l.kind !== "add").map((l) => l.text)).toEqual(["a", "b", "c"]);
    expect(d.filter((l) => l.kind !== "del").map((l) => l.text)).toEqual(["c", "a", "b"]);
    expect(d).toHaveLength(4);
  });

  it("diffs a 500-line document with scattered edits in under 50 ms", () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i % 7 === 0 ? `${l} edited` : l)).reverse();
    const start = performance.now();
    const d = lineDiff(before.join("\n"), after.join("\n"));
    expect(performance.now() - start).toBeLessThan(50);
    expect(d.filter((l) => l.kind !== "add").map((l) => l.text)).toEqual(before);
    expect(d.filter((l) => l.kind !== "del").map((l) => l.text)).toEqual(after);
  });

  it("skips the quadratic table for a huge changed region: all deletions, then all additions", () => {
    // 2100 x 2100 changed lines is 4.41M cells, over the guard.
    const before = Array.from({ length: 2100 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 2100 }, (_, i) => `new ${i}`);
    const start = performance.now();
    const d = lineDiff(["keep", ...before, "tail"].join("\n"), ["keep", ...after, "tail"].join("\n"));
    expect(performance.now() - start).toBeLessThan(50);

    expect(d[0]).toEqual({ kind: "same", text: "keep" });
    expect(d.slice(1, 2101).every((l) => l.kind === "del")).toBe(true);
    expect(d.slice(2101, 4201).every((l) => l.kind === "add")).toBe(true);
    expect(d[4201]).toEqual({ kind: "same", text: "tail" });
    expect(d.filter((l) => l.kind !== "add").map((l) => l.text)).toEqual(["keep", ...before, "tail"]);
    expect(d.filter((l) => l.kind !== "del").map((l) => l.text)).toEqual(["keep", ...after, "tail"]);
  });

  it("still diffs line by line just under the guard", () => {
    const before = Array.from({ length: 1900 }, (_, i) => `line ${i}`);
    const after = [...before.slice(0, 1000), "inserted", ...before.slice(1000)];
    const d = lineDiff(before.join("\n"), after.join("\n"));
    expect(d.filter((l) => l.kind !== "same")).toEqual([{ kind: "add", text: "inserted" }]);
  });

  it("past the guard even documents that mostly match diff as removed-then-added", () => {
    // Two documents sharing 2100 lines but offset by one, so trimming the
    // common ends removes nothing and the changed region is 2101 x 2101 cells.
    const shared = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
    const before = ["first", ...shared];
    const after = [...shared, "last"];
    const d = lineDiff(before.join("\n"), after.join("\n"));

    expect(d.some((l) => l.kind === "same")).toBe(false);
    expect(d.slice(0, 2101).every((l) => l.kind === "del")).toBe(true);
    expect(d.slice(2101).every((l) => l.kind === "add")).toBe(true);
    expect(d.filter((l) => l.kind !== "add").map((l) => l.text)).toEqual(before);
    expect(d.filter((l) => l.kind !== "del").map((l) => l.text)).toEqual(after);
  });
});
