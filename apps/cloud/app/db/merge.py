"""Field-level merge engine with declared ownership (M3).

Row-level last-write-wins (LWW) silently drops concurrent edits and cannot
coexist with an external tracker: if Jira owns `assignee` and PromptConnext owns
`status`, a whole-row overwrite corrupts one of them. We instead merge
field-by-field, honouring each field's *authority domain*:

  * "pz"     — only a `source="pz"` writer may change it (the AI-native moat).
  * "pmo"    — only a `source="pmo"` writer may change it (external tracker).
  * "shared" — either side may write; LWW by per-field timestamp.

Within an *allowed* field, LWW still applies using per-field timestamps stored
in `field_versions[field] = {"updated_at": iso, "source": src}`. A field with
no recorded version is treated as older than any incoming write (so the first
write always lands — this is what makes the migration backfill behave as LWW
until the first field-scoped write).

The *ownership* gate, unlike LWW, applies to a row's creation as well as to its
updates (`_gate_creation`): a writer that invents an id must not be able to
author a field it could not have changed a millisecond later.

This module is intentionally pure and dependency-free so it is trivial to unit
test and reason about. `stored` and `incoming` are plain dicts (JSON-safe);
timestamps are ISO-8601 strings or `datetime`.
"""

from __future__ import annotations

from datetime import datetime, timezone

# Fields that are identity/bookkeeping, never merged as data. Kept local to the
# engine so it has no import cycle with schemas.
_RESERVED = frozenset({"id", "project_id", "updated_at", "deleted_at", "field_versions"})

# Fields whose default (unset) value must never merge as an implicit write —
# the engine literally never sends them (ADR 0018: assigned_user_id is
# app-authored via a dedicated endpoint, not the graph push). Unlike ordinary
# pz fields, a full model dump can't distinguish "the writer wants to clear
# this" from "the writer never touches this field at all", so these are
# dropped from the incoming dict when the caller didn't explicitly set them.
_OMIT_IF_UNSET = frozenset({"assigned_user_id"})

# Fields a writer outside the declared domain may still seed on a *first* write
# (see _gate_creation). `feature_tag` is declared "pmo" in FIELD_AUTHORITY, but
# it is also where the pz author records the plan's task reference ("T012 [P]"):
# app/generation/stage_apply.py::_apply_tasks writes it when it creates a task,
# and both the regeneration match and the push-attribution path
# (app/api/github.py) read it back. Gating a pz creation on it would therefore
# delete the task-reference machinery rather than close a hole. The honest fix is
# to re-declare that field's authority, which is a schema decision plan 0015 does
# not own — this exemption is the narrow, named alternative.
_CREATION_SEEDABLE = frozenset({"feature_tag"})


def incoming_dump(item) -> dict:
    """JSON-safe dict of `item` for merge_entity, dropping any `_OMIT_IF_UNSET`
    field the caller didn't explicitly set (so an engine push that has never
    heard of it can't clobber an app-authored value with an implicit None)."""
    dumped = item.model_dump(mode="json")
    fields_set = getattr(item, "model_fields_set", set())
    for field in _OMIT_IF_UNSET:
        if field in dumped and field not in fields_set:
            dumped.pop(field)
    return dumped


def _as_dt(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    # ISO-8601 string; tolerate a trailing "Z".
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def merge_entity(
    stored: dict | None,
    incoming: dict,
    authority: dict[str, str],
    source: str,
    now: datetime,
    defaults: dict | None = None,
) -> tuple[dict, list[str]]:
    """Merge `incoming` into `stored` field-by-field, returning the new row and
    the list of incoming field names that were silently dropped (rejected by
    the ownership gate or stale under LWW), so callers can surface this data
    loss instead of swallowing it.

    * `authority` maps field name -> domain ("pz" | "pmo" | "shared"). Fields
      absent from the map default to "pz".
    * `source` is the writer's domain ("pz" or "pmo").
    * `now` stamps both the row `updated_at` and each written field's version.
    * `defaults` is the entity model's per-field default (schemas.FIELD_DEFAULTS),
      used by the creation gate below to reset a field the writer may not author.
      Omitting it makes that gate drop such a key outright instead — gated either
      way, never ungated; see _gate_creation.

    A field is written only if (a) `source` is allowed to own it and (b) the
    incoming write is newer than the stored field version (LWW within a domain).
    """
    now_iso = now.isoformat()

    # First write for this id. There is no prior value to conflict with, so LWW
    # has nothing to say — but ownership still does: this branch used to accept
    # the row whole, which let a writer author, at creation, a field the gate
    # below would refuse it a millisecond later (review finding 17, plan 0015).
    if not stored:
        merged, dropped = _gate_creation(incoming, authority, source, defaults)
        merged["updated_at"] = now_iso
        merged["field_versions"] = _stamp_all(merged, authority, source, now_iso)
        return merged, dropped

    merged = dict(stored)
    versions: dict = dict(stored.get("field_versions") or {})
    dropped: list[str] = []

    for field, value in incoming.items():
        if field in _RESERVED:
            continue
        domain = authority.get(field, "pz")

        # Ownership gate: a pz writer can't touch pmo fields and vice-versa.
        # "shared" is writable by either side.
        if domain != "shared" and domain != source:
            dropped.append(field)
            continue

        # LWW within the allowed domain, using the per-field version clock.
        prior = versions.get(field) or {}
        prior_dt = _as_dt(prior.get("updated_at"))
        if prior_dt is not None and prior_dt >= now:
            dropped.append(field)  # stored field is at least as new; keep it
            continue

        merged[field] = value
        versions[field] = {"updated_at": now_iso, "source": source}

    # deleted_at is a tombstone signal, not an owned field: let either side set
    # or clear it (LWW at the row level, consistent with M1).
    if "deleted_at" in incoming:
        merged["deleted_at"] = incoming["deleted_at"]

    merged["field_versions"] = versions
    merged["updated_at"] = now_iso
    return merged, dropped


def _gate_creation(
    incoming: dict, authority: dict[str, str], source: str, defaults: dict | None
) -> tuple[dict, list[str]]:
    """Apply the ownership gate to a row that does not exist yet.

    Only *declared* ownership is enforced here, unlike the update path's
    `authority.get(field, "pz")`. A field absent from the map is the row's own
    structure rather than contested data — a discussion's `parent_node_type`, a
    spec's `requirement_id`, the entity-level `source` a mirrored comment carries
    — and it is required to construct the row the writer is creating. There is no
    prior value to protect, so it is accepted; what is refused is authoring a
    field the *other* domain is declared to own.

    A refused field is reset to its model default rather than dropped from the
    row, so all rows in one batch keep the same columns (PostgREST rejects a bulk
    insert whose objects disagree). A field with no default is required: dropping
    it would leave a row the model cannot construct, so the writer's value stands
    unstamped (today that is only `Artifact.uri`, and no pmo writer creates an
    artifact). Refusals are returned so the caller reports them as conflicts.
    """
    merged = dict(incoming)
    dropped: list[str] = []
    for field, domain in authority.items():
        if field not in merged or field in _RESERVED or field in _CREATION_SEEDABLE:
            continue
        if domain == "shared" or domain == source:
            continue
        if defaults is None:
            # A caller that passed no default map still gets a gate: drop the
            # key rather than let a cross-domain value through. Fail closed — if
            # the field was required the row then fails to construct, loudly,
            # instead of quietly recording a write its writer does not own.
            merged.pop(field)
            dropped.append(field)
            continue
        if field not in defaults:
            continue  # required field: keep it, but _stamp_all still won't stamp it
        if merged[field] == defaults[field]:
            # A full model dump carries every field, so the writer "sent" this
            # one at its default without authoring anything. Resetting it would
            # be a no-op and reporting it would make every creation look like a
            # conflict, drowning the ones that are real.
            continue
        merged[field] = defaults[field]
        dropped.append(field)
    return merged, dropped


def _stamp_all(incoming: dict, authority: dict[str, str], source: str, now_iso: str) -> dict:
    versions: dict = {}
    for field in incoming:
        if field in _RESERVED:
            continue
        domain = authority.get(field, "pz")
        if domain != "shared" and domain != source:
            continue
        versions[field] = {"updated_at": now_iso, "source": source}
    return versions
