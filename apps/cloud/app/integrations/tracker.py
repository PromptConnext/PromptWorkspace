"""Tracker adapter interface (M5).

Every provider (Jira, ClickUp, …) implements the same small surface so the API
layer and the registry stay provider-agnostic. Outbound calls are split into a
*pure* request builder (easy to unit-test) and a thin `send`, so field mapping
is verified without a live tracker.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.models.schemas import Task, TaskStatus


@dataclass
class OutboundRequest:
    """A provider-agnostic description of one outbound HTTP call. Pure data so
    the mapping can be asserted in tests without any network."""

    method: str
    url: str
    json: dict


@dataclass
class InboundUpdate:
    """A provider-neutral, pmo-only task update parsed from a webhook. The API
    layer resolves `external_key` to a PromptZone task via the task-link table,
    then writes these fields with source="pmo" (so M3 keeps pz fields safe)."""

    external_key: str
    status: TaskStatus | None = None
    assignee: str | None = None
    sprint: str | None = None

    def has_updates(self) -> bool:
        return any(v is not None for v in (self.status, self.assignee, self.sprint))


class TrackerAdapter(Protocol):
    provider: str

    def build_push(self, task: Task, config: dict) -> OutboundRequest:
        """Build the outbound create request for a task. Pure."""

    def parse_push_response(self, body: dict, config: dict) -> tuple[str, str]:
        """Return (external_key, external_url) from a create response."""

    def handle_webhook(self, payload: dict, config: dict) -> list[InboundUpdate]:
        """Translate an inbound event into pmo-only updates. Only pmo fields
        (assignee/sprint/status) are populated; pz fields are never touched."""

    def verify_signature(self, body: bytes, signature: str | None, secret: str) -> bool:
        """Verify the webhook HMAC. Returns False on any mismatch."""
