// The three AI coding-rules files the cloud seeds into a project repository,
// and the one comparison that decides whether the clone has drifted from the
// cloud's constitution stage document.
//
// The cloud writes these once, at tech-review exit
// (apps/cloud/app/integrations/repo_seed.py), under a preamble that says "edit
// freely — never overwritten". So the file and the stage document drift by
// design, git is the distribution channel, and the file on disk is the
// authority. The stage document is provenance, never a source of truth.
//
// Shared because two readers exist and neither may invent a fourth path or a
// second notion of "changed": apps/vscode reads them through
// `vscode.workspace.fs` and apps/mcp over `node:fs` (plan 0025 §2 — "the server
// reimplements the reader over node:fs and shares only the path list and the
// drift comparison"). The reading itself is deliberately NOT here: this package
// does not touch a filesystem.

export const SEEDED_DOCS = [
  { key: "agents", label: "AGENTS.md", path: "AGENTS.md" },
  { key: "conventions", label: "Conventions", path: "docs/conventions.md" },
  {
    key: "constitution",
    label: "Constitution",
    path: ".specify/memory/constitution.md",
  },
] as const;

export type SeededDocKey = (typeof SEEDED_DOCS)[number]["key"];

export function seededDocFor(key: SeededDocKey): (typeof SEEDED_DOCS)[number] {
  // `key` is the union of the three literals, so this cannot miss.
  return SEEDED_DOCS.find((doc) => doc.key === key)!;
}

/** True when two versions of a seeded document say the same thing.
 *
 *  Whitespace-normalised, because a reflow is not a change of rules and
 *  reporting one as drift trains the developer to ignore the notice. */
export function sameDocText(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
