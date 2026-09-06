"""The commit-subject -> task-ref rule (ADR 0023 decision 3).

One rule expressed twice, not two rules. These cases mirror
apps/vscode/test/unit/taskRefs.test.ts deliberately: if the two files ever
disagree, a project numbering its tasks T12 closes tasks from the editor and
gets no attribution from the server, which is the defect this replaces.
"""

from __future__ import annotations

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
