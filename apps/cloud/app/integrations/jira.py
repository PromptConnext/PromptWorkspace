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

from app.integrations.account import normalize_account_key
from app.integrations.tracker import InboundComment, InboundUpdate, OutboundRequest
from app.models.schemas import Task, TaskStatus

_DEFAULT_STATUS_MAP = {
    "todo": "To Do",
    "in_progress": "In Progress",
    "implemented": "In Review",
    "verified": "Done",
}


class JiraAdapter:
    provider = "jira"
    # Only Atlassian Cloud hosts may receive the outbound API token. Prevents a
    # compromised/malicious admin from pointing base_url at an attacker server
    # to exfiltrate the server's Jira credentials (SSRF / credential exfil).
    allowed_host_suffixes = (".atlassian.net",)

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
    def account_key_from_payload(self, payload: dict) -> str:
        """Which Jira *site* sent this delivery (plan 0019 M2).

        Jira Cloud exposes no stable installation id in a webhook body, but
        every entity it serializes carries `self` — an absolute REST URL on the
        sending tenant's own host (`https://acme.atlassian.net/rest/api/3/...`).
        `issue.self` is present on issue and comment events alike; the
        top-level `self` and `comment.self` are the fallbacks for payload
        shapes that omit it. Normalized to the same value
        `configure_integration` derives from the admin's `base_url`, so the two
        sides agree without either trusting the other.

        Returns `""` when no host can be read — the route treats that as an
        unrecognized account and drops the delivery unverified.
        """
        candidates = (
            (payload.get("issue") or {}).get("self"),
            (payload.get("comment") or {}).get("self"),
            payload.get("self"),
        )
        for candidate in candidates:
            if isinstance(candidate, str):
                key = normalize_account_key(candidate)
                if key:
                    return key
        return ""

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

    def parse_comment_webhook(self, payload: dict, config: dict) -> InboundComment | None:
        """`comment_created`/`comment_updated` webhook events (M12). Jira
        Cloud's comment `body` may be a plain string (older webhook configs)
        or Atlassian Document Format (a rich-text JSON tree) depending on API
        version — `_adf_to_text` best-effort-extracts plain text from the
        latter; this is a v1 simplification (formatting/mentions are lost),
        not a full ADF renderer."""
        if payload.get("webhookEvent") not in {"comment_created", "comment_updated"}:
            return None
        issue_key = (payload.get("issue") or {}).get("key")
        comment = payload.get("comment") or {}
        comment_id = comment.get("id")
        if not issue_key or not comment_id:
            return None
        author = comment.get("author") or {}
        author_name = author.get("displayName") or author.get("accountId") or "unknown"
        body = comment.get("body")
        text = body if isinstance(body, str) else _adf_to_text(body)
        return InboundComment(
            external_key=issue_key, comment_id=str(comment_id), author=author_name, body=text
        )

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


def _adf_to_text(node) -> str:
    """Best-effort plain-text extraction from an Atlassian Document Format
    node tree — walks `content`, joins `text` leaves. Not a full renderer
    (tables, mentions, etc. are flattened or dropped); good enough for
    embedding a comment's substance."""
    if not isinstance(node, dict):
        return ""
    if "text" in node and isinstance(node["text"], str):
        return node["text"]
    parts = [_adf_to_text(child) for child in node.get("content") or []]
    return " ".join(p for p in parts if p)


def _reverse_status(jira_status_name: str, config: dict) -> TaskStatus | None:
    status_map = config.get("status_map") or _DEFAULT_STATUS_MAP
    for pz_value, jira_name in status_map.items():
        if jira_name.lower() == jira_status_name.lower():
            try:
                return TaskStatus(pz_value)
            except ValueError:
                return None
    return None
