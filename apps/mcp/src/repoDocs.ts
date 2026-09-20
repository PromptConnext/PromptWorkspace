// The seeded coding-rules files, read from the developer's clone over node:fs.
//
// This is apps/vscode/src/context/repoDocs.ts's reader, reimplemented rather
// than reused, and plan 0025 §2 says why: its logic is portable but it reads
// through `vscode.workspace.fs`, which does not exist outside the editor. What
// IS shared, from @promptconnext/pz-cloud, is the part the two surfaces must
// never disagree about — the three paths, and what counts as drift.
//
// Same contract as the original, and the reason is the same: a missing file is
// reported as null, never omitted. "This project has no AGENTS.md" is an answer
// an agent can act on; silence is one it will fill in by guessing.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { SEEDED_DOCS, type SeededDocKey } from "@promptconnext/pz-cloud";

export interface RepoDocContents {
  key: SeededDocKey;
  label: string;
  path: string;
  text: string | null;
}

/** All three files under `root`, in the order the cloud seeds them. */
export async function readSeededDocs(root: string): Promise<RepoDocContents[]> {
  const out: RepoDocContents[] = [];
  for (const doc of SEEDED_DOCS) {
    out.push({
      key: doc.key,
      label: doc.label,
      path: doc.path,
      text: await readDocFile(join(root, doc.path)),
    });
  }
  return out;
}

/** Any read failure is "not there".
 *
 *  ENOENT is the expected one, but a directory where a file should be, a
 *  permission denial, or a path that escapes a container mount are all equally
 *  "we cannot show you this file", and none of them is worth failing the whole
 *  tool over when the other two files are readable. */
async function readDocFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The caller-supplied workspace root, resolved to an absolute path.
 *
 *  An MCP client launches this process with a cwd of its own choosing — often
 *  the editor's install directory rather than the project — so a relative
 *  argument would be resolved against something the developer never sees.
 *  Absolute in, absolute out; relative is resolved against cwd and reported as
 *  such wherever the answer names the folder it read. */
export function resolveWorkspaceRoot(input: string | undefined): string {
  if (!input) return process.cwd();
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}
