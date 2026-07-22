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
# the engine literally never sends them (ADR 0016: assigned_user_id is
# app-authored via a dedicated endpoint, not the graph push). Unlike ordinary
# pz fields, a full model dump can't distinguish "the writer wants to clear
# this" from "the writer never touches this field at all", so these are
# dropped from the incoming dict when the caller didn't explicitly set them.
_OMIT_IF_UNSET = frozenset({"assigned_user_id"})


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
) -> dict:
    """Merge `incoming` into `stored` field-by-field, returning the new row.

    * `authority` maps field name -> domain ("pz" | "pmo" | "shared"). Fields
      absent from the map default to "pz".
    * `source` is the writer's domain ("pz" or "pmo").
    * `now` stamps both the row `updated_at` and each written field's version.

    A field is written only if (a) `source` is allowed to own it and (b) the
    incoming write is newer than the stored field version (LWW within a domain).
    """
    now_iso = now.isoformat()

    # First write for this id: accept it wholesale, recording field versions for
    # every data field the writer is allowed to own.
    if not stored:
        merged = dict(incoming)
        merged["updated_at"] = now_iso
        merged["field_versions"] = _stamp_all(incoming, authority, source, now_iso)
        return merged

    merged = dict(stored)
    versions: dict = dict(stored.get("field_versions") or {})

    for field, value in incoming.items():
        if field in _RESERVED:
            continue
        domain = authority.get(field, "pz")

        # Ownership gate: a pz writer can't touch pmo fields and vice-versa.
        # "shared" is writable by either side.
        if domain != "shared" and domain != source:
            continue

        # LWW within the allowed domain, using the per-field version clock.
        prior = versions.get(field) or {}
        prior_dt = _as_dt(prior.get("updated_at"))
        if prior_dt is not None and prior_dt >= now:
            continue  # stored field is at least as new; keep it

        merged[field] = value
        versions[field] = {"updated_at": now_iso, "source": source}

    # deleted_at is a tombstone signal, not an owned field: let either side set
    # or clear it (LWW at the row level, consistent with M1).
    if "deleted_at" in incoming:
        merged["deleted_at"] = incoming["deleted_at"]

    merged["field_versions"] = versions
    merged["updated_at"] = now_iso
    return merged


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
