"""LINE webhook and project LINE settings API (plan 0032)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.delivery.line_notices import line_test_message, linked
from app.integrations.line import LineNotifier, RecordingLineClient
from app.main import create_app
from app.models.schemas import LineLinkCode, utcnow

SECRET = "test-line-secret"
ALICE = {"X-User-Id": "alice"}  # workspace creator, therefore admin
BOB = {"X-User-Id": "bob"}  # invited member
GROUP = "C0123456789abcdef"


def _sign(body: bytes, secret: str = SECRET) -> str:
    return base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()


def _post(client: TestClient, payload: dict, signature: str | None = "auto"):
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if signature == "auto":
        headers["X-Line-Signature"] = _sign(body)
    elif signature is not None:
        headers["X-Line-Signature"] = signature
    return client.post("/integrations/line/webhook", content=body, headers=headers)


def _message(text: str, event_id: str = "E1", redelivery: bool = False) -> dict:
    return {
        "type": "message",
        "replyToken": f"reply-{event_id}",
        "source": {"type": "group", "groupId": GROUP, "userId": "U1"},
        "message": {"type": "text", "text": text, "id": "1"},
        "deliveryContext": {"isRedelivery": redelivery},
        "webhookEventId": event_id,
    }


def _events(*events: dict) -> dict:
    return {"destination": "Ubot", "events": list(events)}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.settings.line_channel_secret = SECRET
        c.app.state.settings.line_channel_access_token = "token"
        c.app.state.settings.line_bot_basic_id = "@pwbot"
        line = RecordingLineClient()
        line.group_names[GROUP] = "Team room"
        c.app.state.line_notifier = LineNotifier(
            line, c.app.state.repository, ThreadPoolExecutor(max_workers=1)
        )
        c.line = line
        yield c


@pytest.fixture
def project(client: TestClient) -> dict:
    """A project in Alice's workspace, with Bob accepted as a plain member."""
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    invitation = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    accept = client.post(f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB)
    assert accept.status_code == 200, accept.text
    return client.post(
        "/projects", json={"name": "Apollo", "workspace_id": ws["id"]}, headers=ALICE
    ).json()


def _code(client: TestClient, project_id: str, code: str = "PW-ABC234") -> str:
    client.app.state.repository.put_line_link_code(
        LineLinkCode(
            code=code,
            project_id=project_id,
            created_by="alice",
            expires_at=utcnow() + timedelta(minutes=15),
        )
    )
    return code


def test_webhook_rejects_bad_and_missing_signature(client, project):
    code = _code(client, project["id"])
    payload = _events(_message(f"link {code}"))

    missing = _post(client, payload, signature=None)
    bad = _post(client, payload, signature=_sign(b"other body"))
    wrong_secret = _post(client, payload, signature=_sign(json.dumps(payload).encode(), "x"))

    for res in (missing, bad, wrong_secret):
        assert res.status_code == 401
        assert res.json()["detail"] == "invalid_signature"
    assert client.app.state.repository.get_project_line_link(project["id"]) is None
    assert client.line.replied == []


def test_webhook_without_a_configured_secret_rejects_everything(client, project):
    client.app.state.settings.line_channel_secret = ""
    body = json.dumps(_events()).encode()
    res = client.post(
        "/integrations/line/webhook",
        content=body,
        headers={"X-Line-Signature": _sign(body, "")},
    )
    assert res.status_code == 401


def test_webhook_verify_with_no_events_is_200(client):
    res = _post(client, _events())
    assert res.status_code == 200
    assert res.json() == {}


def test_link_command_links_group_and_replies_in_workspace_language(client, project):
    repo = client.app.state.repository
    repo.update_workspace(project["workspace_id"], language="th")
    code = _code(client, project["id"])

    res = _post(client, _events(_message(f"  LINK {code.lower()}  ")))

    assert res.status_code == 200
    link = repo.get_project_line_link(project["id"])
    assert link is not None
    assert link.group_id == GROUP
    assert link.group_name == "Team room"
    assert link.linked_by == "alice"
    assert client.line.replied == [("reply-E1", linked("Apollo", "th"))]
    # Single use: the code is gone.
    assert repo.take_line_link_code(code, utcnow()) is None


def test_expired_or_unknown_code_is_ignored_silently(client, project):
    repo = client.app.state.repository
    repo.put_line_link_code(
        LineLinkCode(
            code="PW-OLDOLD",
            project_id=project["id"],
            created_by="alice",
            expires_at=utcnow() - timedelta(seconds=1),
        )
    )

    expired = _post(client, _events(_message("link PW-OLDOLD", "E1")))
    unknown = _post(client, _events(_message("link PW-ZZZZZZ", "E2")))

    assert expired.status_code == 200
    assert unknown.status_code == 200
    assert repo.get_project_line_link(project["id"]) is None
    assert client.line.replied == []


def test_redelivered_link_event_links_and_replies_once(client, project):
    code = _code(client, project["id"])

    first = _post(client, _events(_message(f"link {code}", "E1")))
    again = _post(client, _events(_message(f"link {code}", "E1", redelivery=True)))
    # Idempotent on the event id even when LINE does not flag the redelivery.
    unflagged = _post(client, _events(_message(f"link {code}", "E1")))

    assert [r.status_code for r in (first, again, unflagged)] == [200, 200, 200]
    assert client.app.state.repository.get_project_line_link(project["id"]).group_id == GROUP
    assert len(client.line.replied) == 1


def test_ordinary_group_message_is_ignored(client, project):
    code = _code(client, project["id"])
    events = _events(
        _message("hello everyone", "E1"),
        _message(f"please link {code} later", "E2"),
        {"type": "join", "source": {"type": "group", "groupId": GROUP}, "webhookEventId": "E3"},
        {"type": "follow", "source": {"type": "user", "userId": "U1"}, "webhookEventId": "E4"},
        {
            **_message(f"link {code}", "E5"),
            "source": {"type": "user", "userId": "U1"},
        },
    )

    res = _post(client, events)

    assert res.status_code == 200
    assert client.app.state.repository.get_project_line_link(project["id"]) is None
    assert client.line.replied == []


def test_failing_event_still_returns_200_and_later_events_run(client, project):
    code = _code(client, project["id"])

    def boom(_token, _text):
        raise RuntimeError("LINE down")

    client.line.reply = boom
    res = _post(client, _events({"type": "message"}, _message(f"link {code}", "E2")))

    assert res.status_code == 200
    assert client.app.state.repository.get_project_line_link(project["id"]) is not None


def test_leave_event_clears_link(client, project):
    code = _code(client, project["id"])
    _post(client, _events(_message(f"link {code}", "E1")))

    res = _post(
        client,
        _events({"type": "leave", "source": {"type": "group", "groupId": GROUP}}),
    )

    assert res.status_code == 200
    assert client.app.state.repository.get_project_line_link(project["id"]) is None


def test_link_code_requires_admin_and_configuration(client, project):
    url = f"/projects/{project['id']}/line/link-code"

    member = client.post(url, headers=BOB)
    assert member.status_code == 403
    assert member.json()["detail"] == "admin_required"

    before = utcnow()
    res = client.post(url, headers=ALICE)
    assert res.status_code == 200, res.text
    body = res.json()
    assert re.fullmatch(r"PW-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}", body["code"])
    assert body["bot_basic_id"] == "@pwbot"
    expires = datetime.fromisoformat(body["expires_at"])
    assert timedelta(minutes=14) < expires - before <= timedelta(minutes=15, seconds=5)
    # The code it hands out is the one the webhook accepts.
    _post(client, _events(_message(f"link {body['code']}")))
    assert client.app.state.repository.get_project_line_link(project["id"]) is not None

    client.app.state.line_notifier = LineNotifier(
        None, client.app.state.repository, ThreadPoolExecutor(max_workers=1)
    )
    off = client.post(url, headers=ALICE)
    assert off.status_code == 409
    assert off.json()["detail"] == "line_not_configured"


def test_status_reports_connected_group(client, project):
    url = f"/projects/{project['id']}/line"

    before = client.get(url, headers=BOB)
    assert before.status_code == 200
    assert before.json() == {
        "configured": True,
        "connected": False,
        "group_name": None,
        "linked_at": None,
        "bot_basic_id": "@pwbot",
    }

    _post(client, _events(_message(f"link {_code(client, project['id'])}")))
    after = client.get(url, headers=BOB).json()
    assert after["connected"] is True
    assert after["group_name"] == "Team room"
    assert after["linked_at"] is not None

    assert client.get(url, headers={"X-User-Id": "mallory"}).status_code == 403


def test_disconnect_and_test_message(client, project):
    base = f"/projects/{project['id']}/line"

    not_linked = client.post(f"{base}/test", headers=ALICE)
    assert not_linked.status_code == 409
    assert not_linked.json()["detail"] == "line_not_connected"

    _post(client, _events(_message(f"link {_code(client, project['id'])}")))

    assert client.post(f"{base}/test", headers=BOB).status_code == 403
    sent = client.post(f"{base}/test", headers=ALICE)
    assert sent.status_code == 204
    assert client.line.pushed == [(GROUP, line_test_message("Apollo", "en"))]

    def boom(_to, _text):
        raise RuntimeError("LINE down")

    client.line.push = boom
    failed = client.post(f"{base}/test", headers=ALICE)
    assert failed.status_code == 502
    assert failed.json()["detail"] == "line_send_failed"

    assert client.delete(base, headers=BOB).status_code == 403
    gone = client.delete(base, headers=ALICE)
    assert gone.status_code == 204
    assert client.app.state.repository.get_project_line_link(project["id"]) is None
    assert client.get(base, headers=ALICE).json()["connected"] is False
