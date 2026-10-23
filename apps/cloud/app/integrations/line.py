"""LINE Messaging API client and a best-effort notifier (plan 0032).

A LINE failure is logged and dropped; it never fails or slows a request. The
notifier hands the work to a small thread pool and returns at once (not
FastAPI `BackgroundTasks`: the rate-limit middleware holds the response until
those finish). The channel access token is never logged.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import time
from collections.abc import Callable
from concurrent.futures import Executor, ThreadPoolExecutor
from typing import TYPE_CHECKING, Protocol

import httpx

from app.config import Settings

if TYPE_CHECKING:
    from app.db.repository import Repository

logger = logging.getLogger("promptworkspace")

_API = "https://api.line.me/v2/bot"
_TIMEOUT_SECONDS = 5.0


class LineClient(Protocol):
    def push(self, to: str, text: str) -> None: ...

    def reply(self, reply_token: str, text: str) -> None: ...

    def group_name(self, group_id: str) -> str | None: ...


class HttpLineClient:
    def __init__(self, access_token: str) -> None:
        self._http = httpx.Client(
            timeout=_TIMEOUT_SECONDS,
            headers={"Authorization": f"Bearer {access_token}"},
        )

    def _post(self, path: str, payload: dict) -> None:
        self._http.post(f"{_API}/{path}", json=payload).raise_for_status()

    def push(self, to: str, text: str) -> None:
        self._post("message/push", {"to": to, "messages": [{"type": "text", "text": text}]})

    def reply(self, reply_token: str, text: str) -> None:
        self._post(
            "message/reply",
            {"replyToken": reply_token, "messages": [{"type": "text", "text": text}]},
        )

    def group_name(self, group_id: str) -> str | None:
        try:
            resp = self._http.get(f"{_API}/group/{group_id}/summary")
            resp.raise_for_status()
            name = resp.json().get("groupName")
            return name if isinstance(name, str) else None
        except Exception:  # noqa: BLE001 - the name is cosmetic
            logger.warning("LINE group name lookup failed")
            return None

    def close(self) -> None:
        self._http.close()


class RecordingLineClient:
    """Keeps what would be sent. Tests install it behind the notifier."""

    def __init__(self, delay: float = 0.0) -> None:
        self.pushed: list[tuple[str, str]] = []
        self.replied: list[tuple[str, str]] = []
        self.group_names: dict[str, str] = {}
        self.delay = delay

    def push(self, to: str, text: str) -> None:
        if self.delay:
            time.sleep(self.delay)
        self.pushed.append((to, text))

    def reply(self, reply_token: str, text: str) -> None:
        self.replied.append((reply_token, text))

    def group_name(self, group_id: str) -> str | None:
        return self.group_names.get(group_id)


def verify_signature(secret: str, body: bytes, signature: str | None) -> bool:
    if not signature:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    return hmac.compare_digest(base64.b64encode(digest).decode(), signature)


class LineNotifier:
    def __init__(
        self, client: LineClient | None, repo: Repository, executor: Executor
    ) -> None:
        self._client = client
        self._repo = repo
        self._executor = executor

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def notify_project(self, project_id: str, build: Callable[[str], str]) -> None:
        if self._client is None:
            return
        try:
            self._executor.submit(self._deliver, project_id, build)
        except Exception:  # noqa: BLE001 - e.g. pool already shut down
            logger.warning("LINE notification not queued")

    def _deliver(self, project_id: str, build: Callable[[str], str]) -> None:
        # Runs on the worker: the repository read (a network call on Supabase)
        # must not happen on the request thread.
        try:
            if self._client is None:
                return
            link = self._repo.get_project_line_link(project_id)
            if link is None:
                return
            project = self._repo.get_project(project_id)
            workspace = self._repo.get_workspace(project.workspace_id) if project else None
            language = workspace.language if workspace else "en"
            self._client.push(link.group_id, build(language))
        except Exception:  # noqa: BLE001 - LINE must never break a request
            logger.warning("LINE notification failed for project %s", project_id, exc_info=True)

    def send_now(self, group_id: str, text: str) -> None:
        """Synchronous push (the settings test message); the caller sees errors."""
        if self._client is None:
            raise RuntimeError("LINE is not configured")
        self._client.push(group_id, text)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
        close = getattr(self._client, "close", None)
        if close:
            close()


def build_line_notifier(settings: Settings, repo: Repository) -> LineNotifier:
    client: LineClient | None = None
    if settings.line_channel_secret and settings.line_channel_access_token:
        client = HttpLineClient(settings.line_channel_access_token)
    return LineNotifier(client, repo, ThreadPoolExecutor(max_workers=2, thread_name_prefix="line"))
