// Run:  node --test apps/vscode/test/unit/taskRow.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { taskDescription } from "../../src/tasks/taskRow.ts";
import { environmentLabel } from "../../src/util/environment.ts";
import type { AssignedTask } from "@promptworkspace/cloud-client";

const task = (feature_tag: string, status: string) =>
  ({ feature_tag, status }) as unknown as AssignedTask["task"];

test("the task on this branch is prefixed", () => {
  assert.equal(
    taskDescription(task("T001", "in_progress"), { pending: false, onBranch: true }),
    "on this branch · T001 · In progress",
  );
});

test("other tasks carry no prefix", () => {
  assert.equal(
    taskDescription(task("T001", "todo"), { pending: false, onBranch: false }),
    "T001 · To do",
  );
});

test("pending commit is appended", () => {
  assert.equal(
    taskDescription(task("T001", "todo"), { pending: true, onBranch: false }),
    "T001 · To do · commit not pushed",
  );
});

const PROD = "https://workspace-api.promptconnext.com";

test("environmentLabel is empty for the production host", () => {
  assert.equal(environmentLabel(PROD, PROD), undefined);
  assert.equal(environmentLabel(`${PROD}/`, PROD), undefined);
});

test("environmentLabel names another host", () => {
  assert.equal(
    environmentLabel("https://promptworkspace-trust-api.truthledgers.com", PROD),
    "promptworkspace-trust-api.truthledgers.com",
  );
});

test("environmentLabel never throws on a malformed URL", () => {
  assert.equal(environmentLabel("not a url", PROD), undefined);
  assert.equal(environmentLabel("", PROD), undefined);
});
