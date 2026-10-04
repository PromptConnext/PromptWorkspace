"""Delivery Changes (plan 0029 M1): one PR-sized slice per `## Phase N:`
section of tasks.md.

`plan_changes` is pure: given the parsed phases and every existing row
(retired ones included) it returns the rows to write and the task-ref ->
change-key map. Matching is by `key`, so a regeneration keeps ids and refs
stable, retires a phase that disappeared, and revives one that comes back
with its original ref. Dependencies come from rank waves: a change depends on
every live change in the nearest lower rank present.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.generation.parsing import TaskPhase
from app.integrations.task_refs import task_ref_from_feature_tag
from app.models.schemas import DeliveryChange, utcnow

logger = logging.getLogger(__name__)

# Setup runs first; foundational blocks every story; stories (and phases we
# can't classify) run in parallel; polish runs last. Unphased tasks are a
# single change with nothing to wait for.
RANK: dict[str, int] = {
    "setup": 0,
    "unphased": 0,
    "foundational": 1,
    "story": 2,
    "other": 2,
    "polish": 3,
}


@dataclass(frozen=True)
class ChangePlan:
    changes: list[DeliveryChange]
    change_key_of_ref: dict[str, str]


def _ref_number(ref: str) -> int:
    digits = ref[1:]
    return int(digits) if digits.isdigit() else 0


def plan_changes(
    project_id: str,
    workspace_id: str,
    phases: list[TaskPhase],
    existing: list[DeliveryChange],
) -> ChangePlan:
    by_key = {change.key: change for change in existing}
    next_number = 1 + max((_ref_number(c.ref) for c in existing), default=0)
    now = utcnow()

    live: list[DeliveryChange] = []
    change_key_of_ref: dict[str, str] = {}
    for position, phase in enumerate(phases):
        fields = {
            "title": phase.title,
            "kind": phase.kind,
            "story": phase.story,
            "priority": phase.priority,
            "position": position,
            "updated_at": now,
            "deleted_at": None,
        }
        previous = by_key.get(phase.key)
        if previous is not None:
            live.append(previous.model_copy(update=fields))
        else:
            live.append(
                DeliveryChange(
                    project_id=project_id,
                    workspace_id=workspace_id,
                    ref=f"C{next_number}",
                    key=phase.key,
                    **fields,
                )
            )
            next_number += 1
        for raw in phase.refs:
            ref = task_ref_from_feature_tag(raw)
            if ref is not None and ref not in change_key_of_ref:
                change_key_of_ref[ref] = phase.key

    ranks = sorted({RANK[c.kind] for c in live})
    with_deps: list[DeliveryChange] = []
    for change in live:
        rank = RANK[change.kind]
        lower = [r for r in ranks if r < rank]
        depends_on = (
            [c.key for c in live if RANK[c.kind] == lower[-1]] if lower else []
        )
        with_deps.append(change.model_copy(update={"depends_on": depends_on}))

    seen = {c.key for c in with_deps}
    retired = [
        change.model_copy(update={"deleted_at": now, "updated_at": now})
        for change in existing
        if change.key not in seen and change.deleted_at is None
    ]
    return ChangePlan(changes=with_deps + retired, change_key_of_ref=change_key_of_ref)


def wave_of(changes: list[DeliveryChange]) -> dict[str, int]:
    """0-based wave per live change key: the index of its rank among the
    ranks present. Changes in one wave can run in parallel."""
    live = [c for c in changes if c.deleted_at is None]
    ranks = sorted({RANK[c.kind] for c in live})
    return {c.key: ranks.index(RANK[c.kind]) for c in live}
