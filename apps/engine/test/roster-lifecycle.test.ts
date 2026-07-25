import assert from "node:assert/strict";
import { test } from "node:test";
import { storeRoster, loadRosterProjects, type RosterProject } from "../src/cloudClient.ts";

test("RosterProject round-trips lifecycle_status/repo_url/repo_default_branch through storeRoster/loadRosterProjects", () => {
  const project: RosterProject = {
    id: "p1",
    name: "P",
    workspace_id: "w1",
    lifecycle_status: "repo_created",
    repo_url: "https://github.com/acme/p1",
    repo_default_branch: "main",
  };
  storeRoster([], [project]);
  const loaded = loadRosterProjects();
  assert.deepEqual(loaded, [project]);
});
