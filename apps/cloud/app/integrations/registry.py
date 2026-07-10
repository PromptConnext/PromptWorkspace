"""Adapter registry — resolve a provider name to its TrackerAdapter."""

from __future__ import annotations

from app.integrations.clickup import ClickUpAdapter
from app.integrations.jira import JiraAdapter
from app.integrations.tracker import TrackerAdapter

_ADAPTERS: dict[str, TrackerAdapter] = {
    "jira": JiraAdapter(),
    "clickup": ClickUpAdapter(),
}


def get_adapter(provider: str) -> TrackerAdapter | None:
    return _ADAPTERS.get(provider)


def list_providers() -> list[str]:
    return list(_ADAPTERS)
