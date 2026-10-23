"""LINE group notifications API (plan 0032): the inbound webhook and a project's settings.

  POST   /integrations/line/webhook        public, signature-verified (LINE console)
  GET    /projects/{id}/line               member — status
  POST   /projects/{id}/line/link-code     admin — a single-use code to paste in the group
  DELETE /projects/{id}/line               admin — disconnect
  POST   /projects/{id}/line/test          admin — a test message, sent synchronously

An admin links a group by inviting the bot and posting `link PW-XXXXXX`; the
webhook trades that code for the link and replies in the workspace's language.
After a valid signature the webhook always answers 200, even when an event
fails: LINE retries a non-2xx, and a retry cannot fix our error. The channel
access token is never logged.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
from collections import deque
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from app.api._guards import require_project, require_project_role
from app.db.repository import Repository
from app.delivery.line_notices import line_test_message, linked
from app.dependencies import User, get_current_user, get_repository
from app.integrations.line import LineClient, LineNotifier, verify_signature
from app.models.schemas import (
    LineLinkCode,
    LineLinkCodeOut,
    Project,
    ProjectLineLink,
    ProjectLineStatus,
    Role,
    utcnow,
)

logger = logging.getLogger("promptworkspace")

router = APIRouter(tags=["line"])

# No 0/O, 1/I/L: the code is read off a screen and typed into a chat.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6
CODE_TTL = timedelta(minutes=15)
_LINK_COMMAND = re.compile(r"^\s*link\s+(PW-[A-Z0-9]{6})\s*$", re.IGNORECASE)


class SeenEvents:
    """The last `size` webhook event ids, for idempotency.

    LINE redelivers an event it thinks failed and flags it with
    `deliveryContext.isRedelivery`, but the flag alone can't make a link
    command idempotent: the first delivery burned the code, so the retry can't
    tell which project it named. Keying on `webhookEventId` (stable across
    redeliveries) skips the duplicate whether or not it is flagged. In-memory
    and bounded, like the rate limiter: a restart forgets it, and then the
    burned code makes the retry a silent no-op anyway.
    """

    def __init__(self, size: int = 1000) -> None:
        self._order: deque[str] = deque()
        self._ids: set[str] = set()
        self._size = size
        self._lock = threading.Lock()

    def first_time(self, event_id: str) -> bool:
        with self._lock:
            if event_id in self._ids:
                return False
            self._ids.add(event_id)
            self._order.append(event_id)
            if len(self._order) > self._size:
                self._ids.discard(self._order.popleft())
            return True


def _notifier(request: Request) -> LineNotifier:
    return request.app.state.line_notifier


def _seen(request: Request) -> SeenEvents:
    state = request.app.state
    if getattr(state, "line_seen_events", None) is None:
        state.line_seen_events = SeenEvents()
    return state.line_seen_events


def _language(repo: Repository, project: Project) -> str:
    workspace = repo.get_workspace(project.workspace_id)
    return workspace.language if workspace else "en"


def _handle_link(repo: Repository, client: LineClient, event: dict) -> None:
    source = event.get("source") or {}
    message = event.get("message") or {}
    if source.get("type") != "group" or message.get("type") != "text":
        return
    match = _LINK_COMMAND.match(message.get("text") or "")
    group_id = source.get("groupId")
    if match is None or not group_id:
        return
    code = repo.take_line_link_code(match.group(1).upper(), utcnow())
    if code is None:
        return  # unknown, expired or already used: say nothing to the group
    project = repo.get_project(code.project_id)
    if project is None:
        return
    repo.set_project_line_link(
        ProjectLineLink(
            project_id=project.id,
            group_id=group_id,
            group_name=client.group_name(group_id),
            linked_by=code.created_by,
            linked_at=utcnow(),
        )
    )
    reply_token = event.get("replyToken")
    if reply_token:
        client.reply(reply_token, linked(project.name, _language(repo, project)))


def _handle_events(
    repo: Repository, client: LineClient, seen: SeenEvents, events: list
) -> None:
    for event in events:
        try:
            if not isinstance(event, dict):
                continue
            event_id = event.get("webhookEventId")
            if event_id and not seen.first_time(event_id):
                continue
            kind = event.get("type")
            if kind == "message":
                _handle_link(repo, client, event)
            elif kind == "leave":
                group_id = (event.get("source") or {}).get("groupId")
                if group_id:
                    repo.delete_line_links_for_group(group_id)
            # join, follow and anything else: nothing to do.
        except Exception:  # noqa: BLE001 - one bad event must not fail the delivery
            logger.warning("LINE webhook event failed", exc_info=True)


@router.post("/integrations/line/webhook")
async def line_webhook(request: Request, repo: Repository = Depends(get_repository)) -> dict:
    raw = await request.body()
    secret = request.app.state.settings.line_channel_secret
    client = _notifier(request).client
    # Verify the raw bytes before parsing anything. With no secret configured
    # every signature is refused: an empty HMAC key would be forgeable.
    if not secret or client is None:
        raise HTTPException(status_code=401, detail="invalid_signature")
    if not verify_signature(secret, raw, request.headers.get("x-line-signature")):
        raise HTTPException(status_code=401, detail="invalid_signature")

    try:
        events = json.loads(raw).get("events") or []
    except (ValueError, AttributeError):
        logger.warning("LINE webhook body was not a JSON object")
        return {}
    if not isinstance(events, list) or not events:
        return {}  # the console's "Verify" button sends an empty list
    # Repository reads and LINE calls block; keep them off the event loop.
    await run_in_threadpool(_handle_events, repo, client, _seen(request), events)
    return {}


def _require_admin(repo: Repository, project_id: str, user: User) -> Project:
    project, role = require_project_role(repo, project_id, user)
    if role != Role.admin:
        raise HTTPException(status_code=403, detail="admin_required")
    return project


@router.get("/projects/{project_id}/line", response_model=ProjectLineStatus)
def get_line_status(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ProjectLineStatus:
    require_project(repo, project_id, user)
    link = repo.get_project_line_link(project_id)
    return ProjectLineStatus(
        configured=_notifier(request).enabled,
        connected=link is not None,
        group_name=link.group_name if link else None,
        linked_at=link.linked_at if link else None,
        bot_basic_id=request.app.state.settings.line_bot_basic_id or None,
    )


@router.post("/projects/{project_id}/line/link-code", response_model=LineLinkCodeOut)
def create_line_link_code(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> LineLinkCodeOut:
    _require_admin(repo, project_id, user)
    if not _notifier(request).enabled:
        raise HTTPException(status_code=409, detail="line_not_configured")
    code = LineLinkCode(
        code="PW-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH)),
        project_id=project_id,
        created_by=user.id,
        expires_at=utcnow() + CODE_TTL,
    )
    repo.put_line_link_code(code)
    return LineLinkCodeOut(
        code=code.code,
        expires_at=code.expires_at,
        bot_basic_id=request.app.state.settings.line_bot_basic_id or None,
    )


@router.delete("/projects/{project_id}/line", status_code=204, response_class=Response)
def disconnect_line(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Response:
    _require_admin(repo, project_id, user)
    repo.delete_project_line_link(project_id)
    return Response(status_code=204)


@router.post("/projects/{project_id}/line/test", status_code=204, response_class=Response)
def send_line_test(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Response:
    project = _require_admin(repo, project_id, user)
    notifier = _notifier(request)
    if not notifier.enabled:
        raise HTTPException(status_code=409, detail="line_not_configured")
    link = repo.get_project_line_link(project_id)
    if link is None:
        raise HTTPException(status_code=409, detail="line_not_connected")
    # The one synchronous LINE call: an admin pressed the button and is waiting.
    try:
        notifier.send_now(link.group_id, line_test_message(project.name, _language(repo, project)))
    except Exception:  # noqa: BLE001 - surfaced as 502; the token is never logged
        logger.warning("LINE test message failed for project %s", project_id)
        raise HTTPException(status_code=502, detail="line_send_failed") from None
    return Response(status_code=204)
