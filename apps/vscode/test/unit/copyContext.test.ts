// Run:  node --test apps/vscode/test/unit/copyContext.test.ts
//
// Finding #38: an agent working from copied context committed `T014:` on
// another task's branch, because the context never said which branch to use.

import test from "node:test";
import assert from "node:assert/strict";

import { buildTaskContext } from "../../src/tasks/copyContext.ts";

const silentLog = { info() {}, warn() {}, error() {} };
const client = { getProjectGraph: async () => ({ spec_documents: [] }) } as never;
const docs = { read: async () => null } as never;

function entry(featureTag: string | null) {
  return {
    task: {
      id: "t14",
      spec_id: null,
      title: "Add a retry to the uploader",
      status: "todo",
      feature_tag: featureTag,
      acceptance_criteria: [{ text: "Retries three times" }],
    },
    project_id: "p1",
    project_name: "Uploader",
    workspace_id: "w1",
    workspace_name: "Acme",
    repo_url: "https://github.com/acme/uploader",
  } as never;
}

test("copyContext names the branch and the commit prefix", async () => {
  const text = await buildTaskContext(entry("T014 [P]"), client, docs, silentLog);
  const lines = text.split("\n");
  assert.match(lines[0], /^# Task T014 \[P\]: Add a retry to the uploader$/);
  assert.ok(
    lines.includes(
      "Work on branch `T14-add-a-retry-to-the-uploader`; start commit subjects with `T14:`.",
    ),
    text,
  );
  // The closing instruction uses the parsed ref, never the raw tag with its
  // parallel marker, which would not parse back.
  assert.match(text, /commit with `T14: <what you did>`/);
  assert.doesNotMatch(text, /`T014 \[P\]: /);
});

test("a task with no number gets no branch line rather than a made-up one", async () => {
  const text = await buildTaskContext(entry(null), client, docs, silentLog);
  assert.doesNotMatch(text, /Work on branch/);
});
