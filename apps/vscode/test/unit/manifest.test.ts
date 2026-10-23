// Run:  node --test apps/vscode/test/unit/manifest.test.ts
//
// The package.json icon lives under media/, which the repo-root .gitignore
// ignores by extension (*.png). The file existed on disk only, so a clean
// checkout could not package the extension. Every file path the manifest names
// must be tracked by git, not just present on disk.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// The package is CommonJS for tsc (no "type": "module"), so import.meta is not
// available. node --test runs this file with its own path as argv[1].
const PACKAGE_DIR = path.resolve(path.dirname(process.argv[1]), "../..");
const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));

// Codicon references such as "$(sign-out)" are resolved by VS Code, not files.
function isFilePath(icon: unknown): icon is string {
  return typeof icon === "string" && !icon.startsWith("$(");
}

function manifestIconPaths(): string[] {
  const paths: string[] = [];
  if (isFilePath(manifest.icon)) paths.push(manifest.icon);
  const containers = manifest.contributes?.viewsContainers ?? {};
  for (const location of Object.values(containers) as Array<Array<{ icon?: unknown }>>) {
    for (const container of location) {
      if (isFilePath(container.icon)) paths.push(container.icon);
    }
  }
  return paths;
}

test("the manifest names at least one file icon", () => {
  assert.ok(manifestIconPaths().length > 0);
});

for (const iconPath of manifestIconPaths()) {
  test(`${iconPath} exists on disk and is tracked by git`, () => {
    assert.ok(existsSync(path.join(PACKAGE_DIR, iconPath)), `${iconPath} is missing on disk`);
    execFileSync("git", ["ls-files", "--error-unmatch", iconPath], { cwd: PACKAGE_DIR, stdio: "pipe" });
  });
}
