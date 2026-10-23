// Run:  node --test apps/vscode/test/unit/copyContext.test.ts
//
// Finding #38: an agent working from copied context committed `T014:` on
// another task's branch, because the context never said which branch to use.

import test from "node:test";
import assert from "node:assert/strict";

import { CloudHttpError } from "@promptworkspace/cloud-client";
import { buildTaskContext } from "../../src/tasks/copyContext.ts";

const silentLog = { info() {}, warn() {}, error() {} };
const client = {
  getProjectGraph: async () => ({ spec_documents: [] }),
  getStageDocument: async () => ({ id: null, stage: "specify", content: "", updated_at: null }),
} as never;
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
  const { text } = await buildTaskContext(entry("T014 [P]"), client, docs, silentLog);
  const lines = text.split("\n");
  assert.match(lines[0], /^# Task T14 \(T014 \[P\]\): Add a retry to the uploader$/);
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
  const { text } = await buildTaskContext(entry(null), client, docs, silentLog);
  assert.doesNotMatch(text, /Work on branch/);
});

function clientWith(spec: string | Error, plan = "PLAN BODY") {
  return {
    getProjectGraph: async () => ({ spec_documents: [{ id: "s1", content: plan }] }),
    getStageDocument: async (_p: string, stage: string) => {
      assert.equal(stage, "specify");
      if (spec instanceof Error) throw spec;
      return { id: "d", stage, content: spec, updated_at: null };
    },
  } as never;
}

function withPlan() {
  const e = entry("T001") as { task: { spec_id: string | null } };
  e.task.spec_id = "s1";
  return e as never;
}

test("labels the plan excerpt as the implementation plan", async () => {
  const { text } = await buildTaskContext(withPlan(), clientWith("SPEC BODY"), docs, silentLog);
  assert.match(text, /## Implementation plan \(excerpt\)\n\nPLAN BODY/);
  assert.doesNotMatch(text, /^## Specification$/m);
});

test("includes the specification from the specify stage document, before the plan", async () => {
  const { text } = await buildTaskContext(withPlan(), clientWith("SPEC BODY"), docs, silentLog);
  assert.match(text, /## Specification \(excerpt\)\n\nSPEC BODY/);
  assert.ok(text.indexOf("## Specification (excerpt)") < text.indexOf("## Implementation plan"));
  assert.ok(text.indexOf("## Acceptance criteria") < text.indexOf("## Specification (excerpt)"));
  assert.ok(text.indexOf("## Implementation plan") < text.indexOf("## What to do"));
});

test("caps the specification excerpt at 4000 characters", async () => {
  const { text } = await buildTaskContext(withPlan(), clientWith("x".repeat(5000)), docs, silentLog);
  assert.match(text, /x{4000}\n\n…\(truncated\)/);
  assert.doesNotMatch(text, /x{4001}/);
});

test("a missing or failing specify document omits the section without failing the copy", async () => {
  for (const spec of ["", new Error("503")]) {
    const { text } = await buildTaskContext(withPlan(), clientWith(spec), docs, silentLog);
    assert.doesNotMatch(text, /## Specification/);
    assert.match(text, /## What to do/);
  }
});

test("tells the agent not to search for spec files", async () => {
  const { text } = await buildTaskContext(entry("T014"), client, docs, silentLog);
  assert.ok(
    text.includes(
      "The specification, plan and rules above are the whole context. They are not files in this repository, so do not search the disk for spec.md, plan.md or tasks.md.",
    ),
    text,
  );
});

test("heading and what-to-do use the same reference spelling", async () => {
  const { text } = await buildTaskContext(entry("T014"), client, docs, silentLog);
  assert.match(text, /^# Task T14 \(T014\): /);
  assert.match(text, /commit with `T14: /);
  const { text: plain } = await buildTaskContext(entry("T14"), client, docs, silentLog);
  assert.match(plain, /^# Task T14: /);
});

test("adds branch and web lines to the bullets when known", async () => {
  const { text } = await buildTaskContext(entry("T14"), client, docs, silentLog, {
    branch: "T14-add-a-retry",
    webUrl: "https://web.example/w/w1/p/p1?tab=tasks",
  });
  assert.match(text, /- Branch: T14-add-a-retry\n/);
  assert.match(text, /- Web: https:\/\/web\.example\/w\/w1\/p\/p1\?tab=tasks\n/);
  const { text: bare } = await buildTaskContext(entry("T14"), client, docs, silentLog);
  assert.doesNotMatch(bare, /- Branch:|- Web:/);
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("fetches the specification, plan and rules in parallel", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = async <T>(value: T): Promise<T> => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(50);
    inFlight--;
    return value;
  };
  const slowClient = {
    getProjectGraph: () => slow({ spec_documents: [{ id: "s1", content: "PLAN BODY" }] }),
    getStageDocument: () => slow({ id: "d", stage: "specify", content: "SPEC BODY", updated_at: null }),
  } as never;
  const slowDocs = { read: () => slow("RULES") } as never;
  const started = Date.now();
  const result = await buildTaskContext(withPlan(), slowClient, slowDocs, silentLog);
  assert.ok(Date.now() - started < 120, `took ${Date.now() - started} ms`);
  assert.equal(peak, 3);
  assert.deepEqual(result.missing, []);
  assert.match(result.text, /RULES/);
});

test("a read slower than the timeout is reported missing and the rest is copied", async () => {
  const hung = {
    getProjectGraph: () => new Promise(() => {}),
    getStageDocument: async (_p: string, stage: string) => ({ id: "d", stage, content: "SPEC BODY", updated_at: null }),
  } as never;
  const result = await buildTaskContext(withPlan(), hung, docs, silentLog, { timeoutMs: 20 });
  assert.deepEqual(result.missing, ["plan"]);
  assert.match(result.text, /## Specification \(excerpt\)/);
  assert.doesNotMatch(result.text, /## Implementation plan/);
});

test("a read that throws is reported missing", async () => {
  const result = await buildTaskContext(withPlan(), clientWith(new Error("503")), docs, silentLog);
  assert.deepEqual(result.missing, ["specification"]);
  const failingDocs = { read: async () => { throw new Error("503"); } } as never;
  const rules = await buildTaskContext(withPlan(), clientWith("S"), failingDocs, silentLog);
  assert.deepEqual(rules.missing, ["rules"]);
});

test("an absent document is not missing", async () => {
  const result = await buildTaskContext(
    withPlan(),
    clientWith(new CloudHttpError(404, "not found")),
    docs,
    silentLog,
  );
  assert.deepEqual(result.missing, []);
  assert.doesNotMatch(result.text, /## Specification/);
});
