"""Shared validation of a policy scope (project PATCH and workspace governance PUT)."""

from __future__ import annotations

from fastapi import HTTPException

from app.models.schemas import PolicyScope
from app.policies.registry import get_template

# Full custom_text cap (mirrors the plan's budget accounting: custom_text is
# capped independently of the render-time budgets in app/policies/registry.py).
MAX_CUSTOM_TEXT_CHARS = 20_000


def validate_scope(selected: list[str], custom_text: str) -> PolicyScope:
    """Resolve `selected` against the built-ins (de-duplicated, order kept) and
    cap `custom_text`; 422 on an unknown template or oversized text."""
    resolved: list[str] = []
    seen: set[str] = set()
    for template_id in selected:
        if get_template(template_id) is None:
            raise HTTPException(status_code=422, detail="unknown_policy_template")
        if template_id not in seen:
            seen.add(template_id)
            resolved.append(template_id)
    if len(custom_text) > MAX_CUSTOM_TEXT_CHARS:
        raise HTTPException(status_code=422, detail="custom_text_too_long")
    return PolicyScope(selected=resolved, custom_text=custom_text)
