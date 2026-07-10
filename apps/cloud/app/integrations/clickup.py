"""ClickUp adapter (M5).

The second adapter behind the same TrackerAdapter interface, proving the sync
boundary is provider-agnostic. Field mapping and webhook parsing are pure and
unit-tested; outbound uses the ClickUp v2 task API.
"""

from __future__ import annotations

import hashlib
import hmac

from app.integrations.tracker import InboundUpdate, OutboundRequest
from app.models.schemas import Task, TaskStatus

_DEFAULT_STATUS_MAP = {
    "todo": "to do",
    "in_progress": "in progress",
    "implemented": "review",
    "verified": "complete",
}


class ClickUpAdapter:
    provider = "clickup"
    # Only the official ClickUp API host may receive the outbound token.
    allowed_host_suffixes = ("api.clickup.com",)

    # -- outbound --------------------------------------------------------- #
    def build_push(self, task: Task, config: dict) -> OutboundRequest:
        # ClickUp creates tasks under a list; project_key holds the list id.
        list_id = config["project_key"]
        base = config.get("base_url", "https://api.clickup.com").rstrip("/")
        body: dict = {"name": task.title}
        description = "\n".join(c.text for c in task.acceptance_criteria)
        if description:
            body["description"] = description
        if task.feature_tag:
            body["tags"] = [task.feature_tag]
        body["status"] = self.clickup_status_name(task.status, config)
        return OutboundRequest(
            method="POST", url=f"{base}/api/v2/list/{list_id}/task", json=body
        )

    def parse_push_response(self, body: dict, config: dict) -> tuple[str, str]:
        return body["id"], body.get("url", "")

    def clickup_status_name(self, status: TaskStatus | str, config: dict) -> str:
        status_map = config.get("status_map") or _DEFAULT_STATUS_MAP
        value = status.value if isinstance(status, TaskStatus) else status
        return status_map.get(value, _DEFAULT_STATUS_MAP.get(value, value))

    # -- inbound ---------------------------------------------------------- #
    def handle_webhook(self, payload: dict, config: dict) -> list[InboundUpdate]:
        key = payload.get("task_id")
        if not key:
            return []
        status = None
        assignee = None
        for item in payload.get("history_items") or []:
            field = item.get("field")
            after = item.get("after")
            if field == "status" and isinstance(after, dict):
                status = _reverse_status(after.get("status", ""), config)
            elif field == "assignee_add" and isinstance(after, dict):
                assignee = after.get("username") or after.get("id")
        update = InboundUpdate(external_key=key, status=status, assignee=assignee)
        return [update] if update.has_updates() else []

    def verify_signature(self, body: bytes, signature: str | None, secret: str) -> bool:
        if not signature or not secret:
            return False
        expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature.strip())


def _reverse_status(clickup_status: str, config: dict) -> TaskStatus | None:
    status_map = config.get("status_map") or _DEFAULT_STATUS_MAP
    for pz_value, cu_name in status_map.items():
        if cu_name.lower() == clickup_status.lower():
            try:
                return TaskStatus(pz_value)
            except ValueError:
                return None
    return None
