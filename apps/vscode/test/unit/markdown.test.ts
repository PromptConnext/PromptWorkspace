// Run:  node --test apps/vscode/test/unit/markdown.test.ts
//
// escapeMarkdown() is what stands between a cloud-supplied project/workspace
// name, task title or acceptance-criterion text and a live link or a loaded
// image inside a hover tooltip (rosterTree.ts, treeProvider.ts). Pure and
// vscode-free, so it is testable from the host-free `node --test` runner.

import test from "node:test";
import assert from "node:assert/strict";

import { escapeMarkdown } from "../../src/util/markdown.ts";

test("a markdown link is neutralised", () => {
  const escaped = escapeMarkdown("[click](https://evil.example)");
  assert.equal(escaped, "\\[click\\]\\(https://evil\\.example\\)");
});

test("a markdown image is neutralised", () => {
  const escaped = escapeMarkdown("![](https://tracker.example/x.png)");
  assert.ok(!escaped.includes("!["), "the '!' and '[' must both be escaped");
});

test("every documented special character is escaped", () => {
  const specials = "\\`*_{}[]()#+-.!|";
  for (const ch of specials) {
    const escaped = escapeMarkdown(`a${ch}b`);
    assert.equal(escaped, `a\\${ch}b`, `expected ${JSON.stringify(ch)} to be escaped`);
  }
});

test("a leading '>' on any line is escaped so it cannot open a blockquote", () => {
  assert.equal(escapeMarkdown(">quote"), "\\>quote");
  assert.equal(escapeMarkdown("line one\n>line two"), "line one\n\\>line two");
});

test("a '>' that is not at the start of a line is left alone (only escaped chars change)", () => {
  const escaped = escapeMarkdown("a > b");
  assert.equal(escaped, "a > b");
});

test("plain text with no special characters is unchanged", () => {
  assert.equal(escapeMarkdown("Checkout Flow"), "Checkout Flow");
});
