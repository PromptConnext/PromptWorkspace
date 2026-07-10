"""Jira Cloud adapter (M5).

Outbound: create an issue for a task (summary/description/labels), and a
separate transition builder to mirror `status` → Jira status. Inbound: a
signature-verified `jira:issue_updated` webhook is parsed into pmo-only updates
(assignee/sprint/status) which the API layer writes with source="pmo".

The pure builders (`build_push`, `build_transition`, `handle_webhook`) contain
all field mapping and are unit-tested without a network. The thin `send` is the
only part that touches httpx.
"""

from __future__ import annotations

import hashlib
import hmac

from app.integrations.tracker import InboundUpdate, OutboundRequest
from app.models.schemas import Task, TaskStatus

_DEFAULT_STATUS_MAP = {
    "todo": "To Do",
    "in_progress": "In Progress",
    "implemented": "In Review",
    "verified": "Done",
}


class JiraAdapter:
    provider = "jira"

    # -- outbound --------------------------------------------------------- #
    def build_push(self, task: Task, config: dict) -> OutboundRequest:
        base = config["base_url"].rstrip("/")
        project_key = config["project_key"]
        description = "\n".join(c.text for c in task.acceptance_criteria)
        fields: dict = {
            "project": {"key": project_key},
            "summary": task.title,
            "issuetype": {"name": "Task"},
        }
        if description:
            fields["description"] = description
        if task.feature_tag:
            fields["labels"] = [_label(task.feature_tag)]
        return OutboundRequest(
            method="POST", url=f"{base}/rest/api/3/issue", json={"fields": fields}
        )

    def parse_push_response(self, body: dict, config: dict) -> tuple[str, str]:
        key = body["key"]
        base = config["base_url"].rstrip("/")
        return key, f"{base}/browse/{key}"

    def jira_status_name(self, status: TaskStatus | str, config: dict) -> str:
        status_map = config.get("status_map") or _DEFAULT_STATUS_MAP
        value = status.value if isinstance(status, TaskStatus) else status
        return status_map.get(value, _DEFAULT_STATUS_MAP.get(value, value))

    def build_transition(
        self, external_key: str, transition_id: str, config: dict
    ) -> OutboundRequest:
        """Build the transition call. `transition_id` is resolved by the caller
        from Jira's GET /transitions (they are per-workflow ids, not names)."""
        base = config["base_url"].rstrip("/")
        return OutboundRequest(
            method="POST",
            url=f"{base}/rest/api/3/issue/{external_key}/transitions",
            json={"transition": {"id": transition_id}},
        )

    # -- inbound ---------------------------------------------------------- #
    def handle_webhook(self, payload: dict, config: dict) -> list[InboundUpdate]:
        if payload.get("webhookEvent") not in {"jira:issue_updated", "jira:issue_created"}:
            return []
        issue = payload.get("issue") or {}
        key = issue.get("key")
        if not key:
            return []
        fields = issue.get("fields") or {}

        assignee = None
        raw_assignee = fields.get("assignee")
        if isinstance(raw_assignee, dict):
            assignee = raw_assignee.get("displayName") or raw_assignee.get("accountId")

        sprint = None
        raw_sprint = fields.get("sprint") or _first_sprint(fields.get("customfield_10020"))
        if isinstance(raw_sprint, dict):
            sprint = raw_sprint.get("name")
        elif isinstance(raw_sprint, str):
            sprint = raw_sprint

        status = None
        raw_status = fields.get("status")
        if isinstance(raw_status, dict) and raw_status.get("name"):
            status = _reverse_status(raw_status["name"], config)

        update = InboundUpdate(
            external_key=key, status=status, assignee=assignee, sprint=sprint
        )
        return [update] if update.has_updates() else []

    def verify_signature(self, body: bytes, signature: str | None, secret: str) -> bool:
        if not signature or not secret:
            return False
        # Jira/Automation "secret" webhooks send an HMAC-SHA256 hex digest,
        # optionally prefixed "sha256=".
        provided = signature.split("=", 1)[-1].strip()
        expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, provided)


def _label(value: str) -> str:
    # Jira labels may not contain spaces.
    return value.strip().replace(" ", "-")


def _first_sprint(value):
    if isinstance(value, list) and value:
        return value[0]
    return value


def _reverse_status(jira_status_name: str, config: dict) -> TaskStatus | None:
    status_map = config.get("status_map") or _DEFAULT_STATUS_MAP
    for pz_value, jira_name in status_map.items():
        if jira_name.lower() == jira_status_name.lower():
            try:
                return TaskStatus(pz_value)
            except ValueError:
                return None
    return None
