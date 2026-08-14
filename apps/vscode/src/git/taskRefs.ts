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

// One subject closing eleven tasks is a pathological subject, not a workflow.
const MAX_REFS_PER_COMMIT = 10;

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
  if (!subject || /^\s*Revert\s+"/.test(subject)) return [];
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
