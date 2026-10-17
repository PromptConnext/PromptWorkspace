// Run:  node --test apps/vscode/test/unit/docView.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { CLOUD_CAPTION, resolveDocView } from "../../src/context/docView.ts";

const doc = (text: string | null) => ({
  key: "constitution" as const,
  label: "Constitution",
  path: ".specify/memory/constitution.md",
  text,
});

test("a file on disk is shown as is and can be opened, even when the cloud has text", () => {
  assert.deepEqual(resolveDocView(doc("on disk"), "from cloud"), {
    kind: "disk",
    text: "on disk",
    canOpen: true,
  });
});

test("an empty file on disk is still the file", () => {
  assert.equal(resolveDocView(doc(""), "from cloud").kind, "disk");
});

test("missing on disk with cloud text shows the cloud text with the caption and no Open button", () => {
  assert.deepEqual(resolveDocView(doc(null), "from cloud"), {
    kind: "cloud",
    text: "from cloud",
    caption: CLOUD_CAPTION,
    canOpen: false,
  });
  assert.equal(CLOUD_CAPTION, "From PromptWorkspace. Not in this repository yet.");
});

test("missing on disk and in the cloud is missing, with no Open button", () => {
  assert.deepEqual(resolveDocView(doc(null), null), { kind: "missing", canOpen: false });
  assert.equal(resolveDocView(doc(null), "").kind, "missing");
});
