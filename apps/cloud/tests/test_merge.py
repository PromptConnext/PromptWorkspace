"""Unit tests for the pure field-level merge engine (M3)."""

from __future__ import annotations

from datetime import timedelta

from app.db.merge import merge_entity
from app.models.schemas import (
    FIELD_AUTHORITY,
    FIELD_DEFAULTS,
    GraphUpsertRequest,
    Task,
    utcnow,
)

TASK_AUTH = FIELD_AUTHORITY["tasks"]


def _row(**kw) -> dict:
    base = {"id": "t1", "project_id": "p1", "title": "T", "status": "todo"}
    base.update(kw)
    return base


def test_first_write_stamps_field_versions():
    now = utcnow()
    merged, dropped = merge_entity(None, _row(status="in_progress"), TASK_AUTH, "pz", now)
    assert merged["status"] == "in_progress"
    assert merged["field_versions"]["status"]["source"] == "pz"
    assert merged["updated_at"] == now.isoformat()
    assert dropped == []


def test_pmo_cannot_clobber_pz_field():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="in_progress"), TASK_AUTH, "pz", t0)

    # A pmo writer tries to change status (a pz field) — rejected.
    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(status="verified"), TASK_AUTH, "pmo", t1)
    assert merged["status"] == "in_progress"  # untouched
    assert merged["field_versions"]["status"]["source"] == "pz"
    assert dropped == ["status"]


def test_pz_cannot_clobber_pmo_field():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(assignee="alice"), TASK_AUTH, "pmo", t0)

    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(assignee="bob"), TASK_AUTH, "pz", t1)
    assert merged["assignee"] == "alice"  # pz may not own assignee
    assert dropped == ["assignee"]


def test_concurrent_edits_to_different_fields_both_survive():
    # This is the case row-level LWW silently dropped.
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(), TASK_AUTH, "pz", t0)

    # pz sets status; pmo sets assignee — neither should erase the other.
    t1 = t0 + timedelta(seconds=1)
    stored, _ = merge_entity(stored, _row(status="in_progress"), TASK_AUTH, "pz", t1)
    t2 = t0 + timedelta(seconds=2)
    merged, dropped = merge_entity(stored, _row(assignee="alice"), TASK_AUTH, "pmo", t2)

    assert merged["status"] == "in_progress"
    assert merged["assignee"] == "alice"


def test_same_field_within_domain_newer_wins():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="todo"), TASK_AUTH, "pz", t0)
    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(status="verified"), TASK_AUTH, "pz", t1)
    assert merged["status"] == "verified"
    assert dropped == []


def test_stale_same_domain_write_is_ignored():
    # A write whose field version is older than the stored one loses.
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="verified"), TASK_AUTH, "pz", t0)
    # Simulate an older field clock on the stored row so the incoming (at t_old)
    # is not newer.
    older = t0 - timedelta(seconds=10)
    merged, dropped = merge_entity(stored, _row(status="todo"), TASK_AUTH, "pz", older)
    assert merged["status"] == "verified"  # stale write rejected
    assert "status" in dropped


def test_shared_field_falls_back_to_lww_for_either_source():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(title="Original"), TASK_AUTH, "pz", t0)
    # title is "shared": a pmo writer may update it (LWW).
    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(title="From Jira"), TASK_AUTH, "pmo", t1)
    assert merged["title"] == "From Jira"
    assert "title" not in dropped


def test_backfilled_row_without_field_versions_behaves_as_lww():
    # A legacy row (no field_versions) accepts the first field-scoped write.
    t0 = utcnow()
    legacy = _row(status="todo")  # no field_versions key
    merged, dropped = merge_entity(legacy, _row(status="in_progress"), TASK_AUTH, "pz", t0)
    assert merged["status"] == "in_progress"
    assert merged["field_versions"]["status"]["source"] == "pz"
    assert dropped == []


def test_deleted_at_is_row_level_not_gated():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(), TASK_AUTH, "pz", t0)
    # Either side can tombstone; deleted_at is a row-level signal.
    t1 = t0 + timedelta(seconds=1)
    tombstone_ts = t1.isoformat()
    merged, dropped = merge_entity(
        stored, _row(deleted_at=tombstone_ts), TASK_AUTH, "pmo", t1
    )
    assert merged["deleted_at"] == tombstone_ts
    assert "deleted_at" not in dropped  # tombstone is never gated/dropped


# --------------------------------------------------------------------------- #
# WP2 — dropped-field reporting (conflict visibility)
# --------------------------------------------------------------------------- #
def test_dropped_lists_ownership_gate_rejections():
    t0 = utcnow()
    stored, _ = merge_entity(
        None, _row(status="in_progress", acceptance_criteria=[]), TASK_AUTH, "pz", t0
    )
    t1 = t0 + timedelta(seconds=5)
    # pmo writer tries to touch two pz fields at once; both are gated. Use a
    # bare incoming dict (not the _row helper) so only the fields under test
    # are present — _row's baked-in "title"/"status" defaults would otherwise
    # leak unrelated (non-)conflicts into the assertion.
    _, dropped = merge_entity(
        stored,
        {"id": "t1", "status": "verified", "acceptance_criteria": [{"text": "new"}]},
        TASK_AUTH,
        "pmo",
        t1,
    )
    assert sorted(dropped) == ["acceptance_criteria", "status"]


def test_dropped_lists_stale_lww_rejections():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="verified"), TASK_AUTH, "pz", t0)
    older = t0 - timedelta(seconds=10)
    # Bare incoming dict with only "status" so the always-present "title"
    # default in _row doesn't also show up as a (correctly) dropped field.
    _, dropped = merge_entity(stored, {"id": "t1", "status": "todo"}, TASK_AUTH, "pz", older)
    assert dropped == ["status"]


def test_dropped_empty_on_clean_first_write():
    now = utcnow()
    _, dropped = merge_entity(None, _row(status="todo"), TASK_AUTH, "pz", now)
    assert dropped == []


# --------------------------------------------------------------------------- #
# The first write is gated too (plan 0015 M3 / review finding 17)
# --------------------------------------------------------------------------- #
def test_a_pmo_first_write_cannot_author_a_pz_field():
    """The gate an update applies, applied to the insert: inventing a new id was
    a way to author a field the writer could not have changed a millisecond
    later. A gated field falls back to its model default rather than being
    dropped from the row, so every row in one batch keeps the same columns."""
    now = utcnow()
    merged, dropped = merge_entity(
        None,
        _row(status="verified", acceptance_criteria=[{"text": "mine"}], assignee="jane"),
        TASK_AUTH,
        "pmo",
        now,
        defaults=FIELD_DEFAULTS["tasks"],
    )
    assert merged["status"] == "todo"  # Task.status's default
    assert merged["acceptance_criteria"] == []
    assert sorted(dropped) == ["acceptance_criteria", "status"]
    # What the writer does own survives, stamped; what it doesn't is unstamped.
    assert merged["assignee"] == "jane"
    assert merged["field_versions"]["assignee"]["source"] == "pmo"
    assert "status" not in merged["field_versions"]


def test_a_pz_first_write_still_seeds_the_task_reference():
    """`feature_tag` is declared "pmo" but carries the plan's task reference,
    which the pz author writes at creation (app/generation/stage_apply.py's
    `_apply_tasks`, and the push-attribution path reads it back). It is the one
    named exemption from the creation gate — see app/db/merge.py."""
    now = utcnow()
    merged, dropped = merge_entity(
        None,
        _row(feature_tag="T012 [P]", status="in_progress"),
        TASK_AUTH,
        "pz",
        now,
        defaults=FIELD_DEFAULTS["tasks"],
    )
    assert merged["feature_tag"] == "T012 [P]"
    assert merged["status"] == "in_progress"
    assert dropped == []


def test_a_first_write_with_no_default_map_still_gates():
    """The gate fails closed: a caller that passes no defaults gets the key
    dropped, never an ungated cross-domain write."""
    now = utcnow()
    merged, dropped = merge_entity(None, _row(status="verified"), TASK_AUTH, "pmo", now)
    assert "status" not in merged
    assert dropped == ["status"]


def test_a_first_write_keeps_a_gated_field_that_has_no_default():
    """A required field has no default to fall back to, so dropping it would
    leave a row the model cannot construct. The value stands, unstamped — today
    that is only `Artifact.uri`, and no pmo writer creates an artifact."""
    now = utcnow()
    merged, dropped = merge_entity(
        None,
        {"id": "a1", "project_id": "p1", "task_id": "t1", "uri": "git:abc"},
        FIELD_AUTHORITY["artifacts"],
        "pmo",
        now,
        defaults=FIELD_DEFAULTS["artifacts"],
    )
    assert merged["uri"] == "git:abc"
    assert "uri" not in dropped
    assert "uri" not in merged["field_versions"]


# --------------------------------------------------------------------------- #
# The writer's domain comes from the route, not the request body (plan 0015 M2)
# --------------------------------------------------------------------------- #
def test_push_graph_ignores_a_client_declared_source(client):
    """`GraphUpsertRequest.source` used to be passed straight to the merge as
    the caller's authority domain, which let any project member write
    tracker-exclusive fields with no tracker credential. The field is still
    accepted (an older engine binary sends it) and now means nothing."""
    ws = client.post("/workspaces", json={"name": "W"}, headers={"X-User-Id": "alice"}).json()
    project = client.post(
        "/projects",
        json={"name": "P", "workspace_id": ws["id"]},
        headers={"X-User-Id": "alice"},
    ).json()
    pid = project["id"]

    # The tracker mirror — the only writer that owns `assignee` — writes
    # in-process, the way the signature-verified webhook does.
    client.app.state.repository.upsert_graph(
        pid,
        GraphUpsertRequest(tasks=[Task(id="t1", project_id=pid, title="X", assignee="Jira Name")]),
        source="pmo",
    )

    res = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "source": "pmo",  # the claim
            "tasks": [{"id": "t1", "project_id": pid, "title": "X", "assignee": "Hijacked"}],
        },
        headers={"X-User-Id": "alice"},
    )
    assert res.status_code == 200, res.text  # accepted, not a 422
    assert "assignee" in res.json()["conflicts"]["t1"]  # and reported as dropped

    task = client.get(f"/sync/projects/{pid}/graph", headers={"X-User-Id": "alice"}).json()[
        "tasks"
    ][0]
    assert task["assignee"] == "Jira Name"
    assert task["field_versions"]["assignee"]["source"] == "pmo"
