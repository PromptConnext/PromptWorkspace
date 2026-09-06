"""Commit subject -> task reference (ADR 0023 decision 3).

A port of apps/vscode/src/git/taskRefs.ts, and deliberately a *port* rather
than a second design: the extension and the server must resolve a commit to
the same task or a repository's attribution depends on which one saw the
commit first. Its test file mirrors the extension's for the same reason.

What this module does NOT do is decide task status. ADR 0022 keeps status with
the client that observed the publication, because the server cannot tell
"implemented" from "pushed" and must not guess. This is attribution only.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

# `T` followed by one to six digits, on a word boundary. The engine's original
# \bT\d{3}\b could not see a project numbering its tasks T12.
_SUBJECT_REF_RE = re.compile(r"\bT(\d{1,6})\b")

# A branch name is not a sentence, so `\b` is the wrong boundary: it matches
# the "T1" inside "SPRINT12". Branch segments are delimited by /, - and _, and
# the ref must be a whole segment. Case-insensitive, unlike the subject
# pattern: a hand-typed lowercase branch is a spelling of the same ref.
_BRANCH_REF_RE = re.compile(r"(?:^|[/_-])[Tt](\d{1,6})(?=$|[/_-])")

# One subject closing eleven tasks is a pathological subject, not a workflow.
MAX_REFS_PER_COMMIT = 10

_REVERT_RE = re.compile(r'^\s*Revert\s+"')


def is_revert_subject(subject: str) -> bool:
    """Undoing work must never close a task, and must not fall through to
    branch attribution either — a revert on a task's own branch is the
    clearest possible case of "not done"."""
    return bool(_REVERT_RE.match(subject or ""))


def normalize_task_ref(raw: str | None) -> str | None:
    """"T001" | "T01" | "T1" -> "T1". None when the input holds no ref."""
    if not raw:
        return None
    match = re.match(r"\s*T(\d{1,6})\b", raw)
    if match is None:
        return None
    return f"T{int(match.group(1))}"


def task_ref_from_feature_tag(tag: str | None) -> str | None:
    """"T001 [P]" -> "T1". The cloud stores a parallel marker on the tag
    (app/generation/parsing.py::parse_task_lines), which is exactly why a
    textual comparison could never match "T12" against "T012"."""
    return normalize_task_ref(tag)


def task_refs_in_subject(subject: str) -> list[str]:
    """Refs in a commit subject, normalised, de-duplicated, order preserved."""
    if not subject or is_revert_subject(subject):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for match in _SUBJECT_REF_RE.finditer(subject):
        ref = f"T{int(match.group(1))}"
        if ref in seen:
            continue
        seen.add(ref)
        out.append(ref)
        if len(out) >= MAX_REFS_PER_COMMIT:
            break
    return out


def colliding_refs(feature_tags: Iterable[str | None]) -> set[str]:
    """Refs two distinct tasks both normalise to — a project holding both
    "T012" and "T12". Nothing may be attributed to those; the caller skips
    rather than guessing."""
    counts: dict[str, int] = {}
    for tag in feature_tags:
        ref = task_ref_from_feature_tag(tag)
        if ref is None:
            continue
        counts[ref] = counts.get(ref, 0) + 1
    return {ref for ref, n in counts.items() if n > 1}


def task_ref_from_branch(name: str | None) -> str | None:
    """The task a branch is for. At most one: a branch is for one task."""
    if not name:
        return None
    match = _BRANCH_REF_RE.search(name)
    if match is None:
        return None
    return f"T{int(match.group(1))}"


def refs_for_commit(subject: str, branch_ref: str | None) -> list[str]:
    """ADR 0022's two attribution rules, in order: a subject ref wins and may
    name several tasks; failing that the branch's own ref applies, naming
    exactly one. A revert yields nothing from either."""
    if is_revert_subject(subject):
        return []
    from_subject = task_refs_in_subject(subject)
    if from_subject:
        return from_subject
    return [branch_ref] if branch_ref else []


def tasks_by_ref(tasks: Iterable) -> dict[str, str]:
    """ref -> task id for the tasks a commit may name.

    Colliding refs are omitted entirely rather than resolved to whichever task
    was iterated first — a wrong attribution is worse than a missing one,
    because it is invisible.
    """
    rows = list(tasks)
    blocked = colliding_refs(t.feature_tag for t in rows)
    out: dict[str, str] = {}
    for task in rows:
        ref = task_ref_from_feature_tag(task.feature_tag)
        if ref is None or ref in blocked or getattr(task, "deleted_at", None) is not None:
            continue
        out[ref] = task.id
    return out
