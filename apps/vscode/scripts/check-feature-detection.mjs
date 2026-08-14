// Fails the test command if anyone feature-detects a VS Code API by `typeof`.
//
// ADR 0019 records the observed failure: in Cursor and Windsurf `vscode.lm` and
// `vscode.chat` are PRESENT BUT INERT, so `typeof vscode.lm !== "undefined"` is
// a false positive and the real error arrives later as
// `LanguageModelTextPart is not a constructor`. The rule for this extension is
// to invoke the smallest real operation and inspect the result, inside
// try/catch, with a copy-context fallback.
//
// The repo has no linter outside apps/corp, so this is a grep rather than an
// ESLint rule. It runs as `pretest`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const OFFENDER = /typeof\s+vscode\./;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (OFFENDER.test(line) && !line.trimStart().startsWith("//")) {
      hits.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (hits.length > 0) {
  console.error(
    "Feature-detecting a VS Code API by `typeof` is a false positive in the forks.\n" +
      "Invoke the smallest real operation and check the result instead (ADR 0019).\n",
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
