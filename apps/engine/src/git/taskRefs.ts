// VENDORED — DO NOT EDIT.
//
// Source: packages/cloud-client/src/taskRefs.ts
// Copied: 2026-09-22 (plan 0024 M1)
//
// Everything below this header is a byte-for-byte copy of that file, and
// apps/engine/test/task-refs.test.ts asserts it stays one. Vendored rather
// than depended on because pnpm-workspace.yaml puts the engine outside the
// packages/* dependency graph, and because the repository already solves this
// exact shape of problem this exact way (apps/vscode/src/git/git.d.ts).
//
// To re-vendor: re-copy the source verbatim below this header and re-run
// `node --test apps/engine/test/task-refs.test.ts`. That test is the tripwire.
//
// The rule these functions implement is stated in prose at
// docs/contracts/task-ref-grammar.md and as data at
// docs/contracts/task-ref-cases.json, which three separate test suites read.

// Commit subject -> task reference.
//
// The engine's version (apps/engine/src/routes/projects.ts::syncTasksFromGit)
// matches /\bT\d{3}\b/ against the subject and compares the text to the task's
// feature_tag. ADR 0019 names its two edges; both are fixed here.
//
// Widening the regex alone is NOT enough. The cloud stores feature_tag as
// "T001" or "T001 [P]" (app/generation/parsing.py::parse_task_lines), so a
// textual comparison still fails "T12" against "T012". Both sides are
// normalised numerically instead, which is the only way the two forms meet.

const TASK_REF_RE = /\bT(\d{1,6})\b/g;

// A branch name is not a sentence, so `\b` is the wrong boundary here: it
// would match the "T1" inside "SPRINT12". Branch segments are delimited by
// `/`, `-` and `_`, and the ref has to be a whole segment — "T12-add-retry",
// "feature/T12_retry" and "T12" match; "TEST-12", "release/v1.2" and "T12abc"
// do not.
//
// Case-insensitive, unlike the subject pattern. `startTask` writes the branch
// in the canonical uppercase form, but a developer typing one by hand (or a
// tool lowercasing it) should not silently lose attribution over the shift
// key. This is a spelling of the same ref, not a second vocabulary.
const BRANCH_REF_RE = /(?:^|[/_-])[Tt](\d{1,6})(?=$|[/_-])/;

// One subject closing eleven tasks is a pathological subject, not a workflow.
const MAX_REFS_PER_COMMIT = 10;

// Long enough to recognise the task, short enough to keep the branch name
// usable in a terminal prompt.
const SLUG_MAX = 40;

/** True when the subject is a revert. Undoing work must never close a task,
 *  and must not fall through to branch attribution either — a revert made on
 *  a task's own branch is the clearest possible case of "not done". */
export function isRevertSubject(subject: string): boolean {
  return /^\s*Revert\s+"/.test(subject);
}

/** "T001" | "T01" | "T1" -> "T1". Null when the input holds no task ref. */
export function normalizeTaskRef(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /^\s*T(\d{1,6})\b/.exec(raw);
  if (!match) return null;
  return `T${String(Number(match[1]))}`;
}

/** "T001 [P]" -> "T1". The cloud's feature_tag carries a parallel marker. */
export function taskRefFromFeatureTag(tag: string | null | undefined): string | null {
  return normalizeTaskRef(tag ?? null);
}

/**
 * Task refs mentioned in a commit subject, normalised and de-duplicated.
 *
 * Subject only, like the engine: scanning the body would match issue
 * references and quoted revert text. A `Revert "…"` subject yields nothing at
 * all — undoing the work must not re-close the task.
 */
export function taskRefsInSubject(subject: string): string[] {
  if (!subject || isRevertSubject(subject)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of subject.matchAll(TASK_REF_RE)) {
    const ref = `T${String(Number(match[1]))}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
    if (out.length >= MAX_REFS_PER_COMMIT) break;
  }
  return out;
}

/**
 * Refs that two distinct tasks both normalise to — e.g. a project holding both
 * "T012" and "T12". Numeric normalisation collides them, so nothing may be
 * auto-closed for those refs; the caller logs and skips rather than guessing.
 */
export function collidingRefs(featureTags: (string | null | undefined)[]): Set<string> {
  const counts = new Map<string, number>();
  for (const tag of featureTags) {
    const ref = taskRefFromFeatureTag(tag);
    if (!ref) continue;
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([ref]) => ref));
}

/**
 * The task a branch is for. "T012-add-retry" | "feature/t12_retry" -> "T12".
 *
 * At most one: a branch is for one task. A branch carrying two refs is not a
 * convention this extension recognises, so the first whole segment wins.
 */
export function taskRefFromBranch(name: string | null | undefined): string | null {
  if (!name) return null;
  const match = BRANCH_REF_RE.exec(name);
  if (!match) return null;
  return `T${String(Number(match[1]))}`;
}

/**
 * The refs one commit closes — ADR 0022's two attribution rules, in order.
 *
 * A ref in the subject wins, and may name several tasks. Failing that the
 * branch's own ref applies, naming exactly one. A revert yields nothing from
 * either rule.
 *
 * `branchRef` is null when there is no branch ref, when HEAD is detached, or
 * when the branch is the project's default — the caller decides that, because
 * only the caller knows what the default is (`ProjectRow.defaultBranch`).
 */
export function refsForCommit(subject: string, branchRef: string | null): string[] {
  if (isRevertSubject(subject)) return [];
  const fromSubject = taskRefsInSubject(subject);
  if (fromSubject.length > 0) return fromSubject;
  return branchRef ? [branchRef] : [];
}

/**
 * The branch `startTask` offers for a task: "T12-add-a-retry-to-the-uploader".
 *
 * Restricted to `[a-z0-9-]` after the ref, which sidesteps every git ref-name
 * rule at once (no `..`, no leading/trailing dot, no control characters, no
 * `@{`, no lock suffix) rather than enumerating them.
 */
export function branchNameForTask(ref: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug ? `${ref}-${slug}` : ref;
}
