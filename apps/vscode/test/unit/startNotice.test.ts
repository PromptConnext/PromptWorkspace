// Run:  node --test apps/vscode/test/unit/startNotice.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { startNotice } from "../../src/tasks/startNotice.ts";

const TAIL =
  "Next, hand it to your AI agent: copy the task context and paste it into " +
  "Claude Code, Cursor or your agent of choice.";

test("branch choice names the task branch", () => {
  assert.equal(
    startNotice("T2", "branch", "T2-add-login"),
    `Started T2 on branch T2-add-login. ${TAIL}`,
  );
});

test("prefill and neither name the current branch", () => {
  assert.equal(startNotice("T2", "message", "main"), `Started T2 on main. ${TAIL}`);
  assert.equal(startNotice("T2", "neither", "main"), `Started T2 on main. ${TAIL}`);
});

test("an unknown branch reads as this folder", () => {
  assert.equal(startNotice("T2", "neither", undefined), `Started T2 in this folder. ${TAIL}`);
  assert.equal(startNotice("T2", "branch", undefined), `Started T2 in this folder. ${TAIL}`);
});
