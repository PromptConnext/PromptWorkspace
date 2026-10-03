"""The commit-subject -> task-ref rule (ADR 0023 decision 3).

One rule expressed three times, not three rules. `app/integrations/task_refs.py`
is a hand-written port of `packages/cloud-client/src/taskRefs.ts`, because there is
no sane way to share a TypeScript module with FastAPI; `apps/engine` vendors
that same file byte-for-byte and checks the copy in its own suite.

A port has no compiler holding it to its original, so its tripwire is the
shared case table at `docs/contracts/task-ref-cases.json` (plan 0024 M1), read
below and read identically by `packages/cloud-client/test/taskRefs.test.ts` and
`apps/engine/test/task-refs.test.ts`. If the port ever drifts, all three
suites are looking at the same list of facts and one of them fails. The prose
statement of the rule, including why the server never reads a branch, is
`docs/contracts/task-ref-grammar.md`.

The cases below the contract block are the port's own older, hand-written
ones. They stay: the shared table pins the agreed grammar, and these pin
Python-side details (`tasks_by_ref`, tombstones) that have no counterpart in
the TypeScript module.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.integrations.task_refs import (
    colliding_refs,
    is_revert_subject,
    normalize_task_ref,
    refs_for_commit,
    task_ref_from_branch,
    task_ref_from_feature_tag,
    task_refs_in_subject,
    tasks_by_ref,
)
from app.models.schemas import Task

# --------------------------------------------------------------------------- #
# The shared contract (docs/contracts/task-ref-cases.json)
# --------------------------------------------------------------------------- #

_CASES_PATH = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "task-ref-cases.json"
_CASES = json.loads(_CASES_PATH.read_text(encoding="utf-8"))


def test_the_shared_case_table_is_not_silently_empty():
    """A suite that reads its cases from a file has one new way to pass while
    testing nothing: read a file with no cases in it."""
    assert _CASES["normalize"]
    assert _CASES["commits"]
    assert _CASES["collisions"]


@pytest.mark.parametrize("case", _CASES["normalize"], ids=lambda c: c["name"])
def test_contract_normalisation(case):
    assert task_ref_from_feature_tag(case["tag"]) == case["expect"]
    assert normalize_task_ref(case["tag"]) == case["expect"]


@pytest.mark.parametrize("case", _CASES["commits"], ids=lambda c: c["name"])
def test_contract_refs_for_commit(case):
    # The branch name resolves to the ref the table says it does. The cloud
    # never passes one (see below), but the pattern is part of the ported
    # grammar and a divergence here would be a real port defect.
    assert task_ref_from_branch(case["branch_name"]) == case["branch_ref"]

    # An editor-shaped caller, which resolved a branch ref first.
    assert refs_for_commit(case["subject"], case["branch_ref"]) == case["expect"]

    # This server's own shape. Both call sites in app/api/github.py pass None
    # on purpose: a push to the default branch has no feature branch to read,
    # and inferring one from `ref` would attribute every merge commit to
    # whatever the branch was named for. That is the documented asymmetry,
    # and `expect_server` is what it costs.
    assert refs_for_commit(case["subject"], None) == case["expect_server"]


@pytest.mark.parametrize("case", _CASES["collisions"], ids=lambda c: c["name"])
def test_contract_collisions(case):
    assert colliding_refs(case["feature_tags"]) == set(case["blocked"])


# --------------------------------------------------------------------------- #
# The port's own cases
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "raw,expected",
    [("T001", "T1"), ("T01", "T1"), ("T1", "T1"), ("T012 [P]", "T12"), ("", None), (None, None)],
)
def test_normalisation_is_numeric_not_textual(raw, expected):
    assert normalize_task_ref(raw) == expected


def test_feature_tag_drops_the_parallel_marker():
    assert task_ref_from_feature_tag("T001 [P]") == "T1"


@pytest.mark.parametrize(
    "subject,expected",
    [
        ("feat: add retry T12", ["T12"]),
        ("feat: T001 and T2", ["T1", "T2"]),
        ("feat: T1 and T001 again", ["T1"]),  # de-duplicated after normalisation
        ("chore: bump to v1.2", []),
        ("fix TEST-12 tracker id", []),
        ("T1234567 is too long", []),
    ],
)
def test_subject_refs(subject, expected):
    assert task_refs_in_subject(subject) == expected


def test_a_revert_closes_nothing():
    assert is_revert_subject('Revert "feat: add retry T12"')
    assert task_refs_in_subject('Revert "feat: add retry T12"') == []
    assert refs_for_commit('Revert "feat: T12"', "T12") == []


def test_at_most_ten_refs_per_subject():
    subject = " ".join(f"T{n}" for n in range(1, 20))
    assert len(task_refs_in_subject(subject)) == 10


@pytest.mark.parametrize(
    "branch,expected",
    [
        ("T012-add-retry", "T12"),
        ("feature/t12_retry", "T12"),
        ("T12", "T12"),
        ("SPRINT12", None),
        ("TEST-12", None),
        ("release/v1.2", None),
        ("T12abc", None),
    ],
)
def test_branch_refs_are_whole_segments(branch, expected):
    assert task_ref_from_branch(branch) == expected


def test_the_subject_wins_over_the_branch():
    assert refs_for_commit("feat: T3 and T4", "T12") == ["T3", "T4"]
    assert refs_for_commit("feat: no ref here", "T12") == ["T12"]
    assert refs_for_commit("feat: no ref here", None) == []


def test_a_collision_blocks_attribution_rather_than_guessing():
    tags = ["T012", "T12", "T5"]
    assert colliding_refs(tags) == {"T12"}
    tasks = [
        Task(id="a", project_id="p", title="A", feature_tag="T012"),
        Task(id="b", project_id="p", title="B", feature_tag="T12"),
        Task(id="c", project_id="p", title="C", feature_tag="T5"),
    ]
    # T12 is ambiguous, so nothing may be attributed to it.
    assert tasks_by_ref(tasks) == {"T5": "c"}
