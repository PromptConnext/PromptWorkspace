# Workspace Part 1 — Cloud Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the cloud backend contracts the workspace experience needs — membership-scoped project listing, invitation list/revoke, a hardened invite token, and best-effort invitation email via Supabase Admin.

**Architecture:** All changes are in `apps/cloud` (FastAPI + pytest, the repo's only test suite). New endpoints hang off the existing `workspaces` router; new persistence methods go on the `Repository` ABC + both `InMemoryRepository` (unit-tested) and `SupabaseRepository` (mirrored). Email is a mockable `app.state.invitation_mailer`, following the existing `github_client`/`chat_provider` provider pattern.

**Tech Stack:** FastAPI, Pydantic v2, pytest + `TestClient`, supabase-py (`auth.admin.invite_user_by_email`).

## Global Constraints

- Invite token must be `secrets.token_urlsafe(32)` (unguessable secret; it grants membership on accept) — NOT a UUID.
- `GET /workspaces/{id}/projects` requires `require_workspace` (403 `not_a_member`); `GET /workspaces/{id}/invitations` and `DELETE /workspaces/{id}/invitations/{id}` require `require_admin` (403 `admin_required`).
- Revoke sets `status = "revoked"` (enum exists, `schemas.py:82`); revoking a non-pending invite → 409; missing/cross-workspace id → 404.
- Email is **best-effort**: existing-user (`email_exists`/422) → swallow, invite still returned; any other email error → log, `email_sent=false`; never a 5xx from an email failure. Create response is `{invitation, accept_url, email_sent}`.
- Accept-by-token (`POST /invitations/{token}/accept`) keeps its current shape/behavior.
- Tests run under `AUTH_MODE=stub` (default), `DATA_BACKEND=memory`. No real network. A machine-local `apps/cloud/.env.local` forces supabase mode — run tests with `AUTH_MODE=stub` prefixed and (if present) `DATA_BACKEND=memory`.
- Match existing code style; `ruff check .` (line-length 100) must stay clean.

---

### Task 1: Harden the invitation token

**Files:**
- Modify: `apps/cloud/app/models/schemas.py` (the `Invitation.token` default)
- Test: `apps/cloud/tests/test_invitations_foundation.py` (new)

**Interfaces:**
- Produces: `Invitation.token` now defaults to a URL-safe 43-char secret. No signature change; `token: str` still.

- [ ] **Step 1: Write the failing test**

```python
# apps/cloud/tests/test_invitations_foundation.py
from __future__ import annotations

from app.models.schemas import Invitation, utcnow


def _invite(**kw):
    base = dict(workspace_id="w1", email="a@b.com", invited_by="admin", expires_at=utcnow())
    base.update(kw)
    return Invitation(**base)


def test_invitation_token_is_high_entropy_secret():
    tok = _invite().token
    # token_urlsafe(32) yields 43 url-safe chars; a uuid4 is 36 chars with dashes.
    assert "-" not in tok
    assert len(tok) >= 43


def test_two_invitations_get_distinct_tokens():
    assert _invite().token != _invite().token
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v`
Expected: FAIL — token contains a dash / length 36 (current uuid default).

- [ ] **Step 3: Change the token default**

In `apps/cloud/app/models/schemas.py`, add `import secrets` at the top with the other stdlib imports, and change the `Invitation.token` field (currently `token: str = Field(default_factory=new_id)`):

```python
    token: str = Field(default_factory=lambda: secrets.token_urlsafe(32))
```

Leave `id` on `new_id` (UUID is fine for a non-secret primary key). Do not change any other model.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/models/schemas.py apps/cloud/tests/test_invitations_foundation.py
git commit -m "feat(cloud): harden invitation token to a high-entropy secret"
```

---

### Task 2: Repository methods — scoped projects, list/revoke invitations

**Files:**
- Modify: `apps/cloud/app/db/repository.py` (abstract `Repository` + `InMemoryRepository`)
- Modify: `apps/cloud/app/db/supabase_repository.py` (mirror on `SupabaseRepository`)
- Test: `apps/cloud/tests/test_invitations_foundation.py` (append)

**Interfaces:**
- Consumes: `Invitation`, `Project`, `InvitationStatus` from schemas.
- Produces on `Repository`:
  - `list_projects_by_workspace(workspace_id: str) -> list[Project]`
  - `list_invitations(workspace_id: str, status: InvitationStatus | None = None) -> list[Invitation]`
  - `revoke_invitation(workspace_id: str, invitation_id: str) -> Invitation` — raises `KeyError` if the id doesn't exist in that workspace, `ValueError("invitation_not_pending")` if not pending.

- [ ] **Step 1: Write the failing tests (append)**

```python
from app.db.repository import InMemoryRepository
from app.models.schemas import InvitationStatus, Role


def _repo_with_ws():
    repo = InMemoryRepository()
    ws = repo.create_workspace(name="Acme", created_by="admin")
    return repo, ws


def test_list_projects_by_workspace_scopes_to_that_workspace():
    repo, ws = _repo_with_ws()
    other = repo.create_workspace(name="Other", created_by="admin")
    p1 = repo.create_project(workspace_id=ws.id, created_by="admin", name="P1")
    repo.create_project(workspace_id=other.id, created_by="admin", name="P2")
    got = repo.list_projects_by_workspace(ws.id)
    assert [p.id for p in got] == [p1.id]


def test_list_invitations_filters_by_status():
    repo, ws = _repo_with_ws()
    inv = repo.create_invitation(
        Invitation(workspace_id=ws.id, email="a@b.com", invited_by="admin", expires_at=utcnow_plus())
    )
    pending = repo.list_invitations(ws.id, status=InvitationStatus.pending)
    assert [i.id for i in pending] == [inv.id]
    # a revoked invite is excluded from a pending filter
    repo.revoke_invitation(ws.id, inv.id)
    assert repo.list_invitations(ws.id, status=InvitationStatus.pending) == []


def test_revoke_invitation_sets_status_and_guards():
    repo, ws = _repo_with_ws()
    inv = repo.create_invitation(
        Invitation(workspace_id=ws.id, email="a@b.com", invited_by="admin", expires_at=utcnow_plus())
    )
    revoked = repo.revoke_invitation(ws.id, inv.id)
    assert revoked.status == InvitationStatus.revoked
    # revoking again (now non-pending) raises
    import pytest

    with pytest.raises(ValueError):
        repo.revoke_invitation(ws.id, inv.id)
    # unknown / cross-workspace id raises KeyError
    with pytest.raises(KeyError):
        repo.revoke_invitation(ws.id, "does-not-exist")
```

Add this helper near the top of the test file (after the imports):

```python
from datetime import timedelta


def utcnow_plus(days: int = 14):
    return utcnow() + timedelta(days=days)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v`
Expected: FAIL — `AttributeError: 'InMemoryRepository' object has no attribute 'list_projects_by_workspace'`.

- [ ] **Step 3: Add abstract methods**

In `apps/cloud/app/db/repository.py`, in the `Repository` ABC (near the existing `list_projects` / invitation abstract methods), add:

```python
    @abc.abstractmethod
    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]: ...

    @abc.abstractmethod
    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]: ...

    @abc.abstractmethod
    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation: ...
```

Ensure `InvitationStatus` is imported at the top of the file alongside the other schema imports.

- [ ] **Step 4: Implement on InMemoryRepository**

In `apps/cloud/app/db/repository.py`, `InMemoryRepository`, near `list_projects` / the invitation methods:

```python
    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]:
        return [p for p in self._projects.values() if p.workspace_id == workspace_id]

    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        out = [i for i in self._invitations.values() if i.workspace_id == workspace_id]
        if status is not None:
            out = [i for i in out if i.status == status]
        return out

    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation:
        inv = next(
            (
                i
                for i in self._invitations.values()
                if i.id == invitation_id and i.workspace_id == workspace_id
            ),
            None,
        )
        if inv is None:
            raise KeyError("invitation_not_found")
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        inv.status = InvitationStatus.revoked
        return inv
```

(Note: `self._invitations` is keyed by token; iterate values to find by id.)

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v`
Expected: PASS (all).

- [ ] **Step 6: Mirror on SupabaseRepository**

In `apps/cloud/app/db/supabase_repository.py`, add the same three methods, following the file's existing `.table(...)` patterns (see `list_projects` at line ~227, `get_invitation` at ~195, and the `accept_invitation` update at ~211). `_INVITATIONS` / `_PROJECTS` table constants already exist. Use `_row` / `_dump` helpers as the surrounding methods do:

```python
    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]:
        res = self._client.table(_PROJECTS).select("*").eq("workspace_id", workspace_id).execute()
        return [Project(**r) for r in res.data]

    def list_invitations(
        self, workspace_id: str, status: InvitationStatus | None = None
    ) -> list[Invitation]:
        q = self._client.table(_INVITATIONS).select("*").eq("workspace_id", workspace_id)
        if status is not None:
            q = q.eq("status", status.value)
        res = q.execute()
        return [Invitation(**r) for r in res.data]

    def revoke_invitation(self, workspace_id: str, invitation_id: str) -> Invitation:
        res = (
            self._client.table(_INVITATIONS)
            .select("*")
            .eq("id", invitation_id)
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        if not res.data:
            raise KeyError("invitation_not_found")
        inv = Invitation(**res.data[0])
        if inv.status != InvitationStatus.pending:
            raise ValueError("invitation_not_pending")
        self._client.table(_INVITATIONS).update({"status": "revoked"}).eq(
            "id", invitation_id
        ).execute()
        inv.status = InvitationStatus.revoked
        return inv
```

Match the exact `Project(**r)` / `Invitation(**r)` construction style already in the file (if it uses a `_row` helper instead of `**r`, follow that). Ensure `InvitationStatus` is imported there. This path is not unit-tested (supabase isn't in the test env) — verify by reading + `ruff`.

- [ ] **Step 7: Commit**

```bash
cd apps/cloud && ruff check .
git add apps/cloud/app/db/repository.py apps/cloud/app/db/supabase_repository.py apps/cloud/tests/test_invitations_foundation.py
git commit -m "feat(cloud): repo methods for workspace-scoped projects and invitation list/revoke"
```

---

### Task 3: Endpoints — scoped projects, list invitations, revoke invitation

**Files:**
- Modify: `apps/cloud/app/api/workspaces.py`
- Test: `apps/cloud/tests/test_invitations_foundation.py` (append TestClient tests)

**Interfaces:**
- Consumes: Task 2 repo methods; `require_workspace` / `require_admin` from `_guards.py`.
- Produces:
  - `GET /workspaces/{workspace_id}/projects` → `list[Project]` (member-scoped)
  - `GET /workspaces/{workspace_id}/invitations` → `list[Invitation]` (admin, pending only)
  - `DELETE /workspaces/{workspace_id}/invitations/{invitation_id}` → 204 (admin)

- [ ] **Step 1: Write failing TestClient tests (append)**

```python
from fastapi.testclient import TestClient

from app.main import create_app


def _client():
    return TestClient(create_app())


def _mk_ws(c, user="alice", name="Acme"):
    return c.post("/workspaces", json={"name": name}, headers={"X-User-Id": user}).json()


def test_scoped_projects_endpoint_member_only():
    with _client() as c:
        ws = _mk_ws(c)
        c.post("/projects", json={"name": "P1", "workspace_id": ws["id"]}, headers={"X-User-Id": "alice"})
        ok = c.get(f"/workspaces/{ws['id']}/projects", headers={"X-User-Id": "alice"})
        assert ok.status_code == 200
        assert [p["name"] for p in ok.json()] == ["P1"]
        denied = c.get(f"/workspaces/{ws['id']}/projects", headers={"X-User-Id": "mallory"})
        assert denied.status_code == 403


def test_list_and_revoke_invitations_admin_only():
    with _client() as c:
        ws = _mk_ws(c)
        inv = c.post(
            f"/workspaces/{ws['id']}/invitations",
            json={"email": "new@b.com", "role": "member"},
            headers={"X-User-Id": "alice"},
        ).json()
        # object under test in task 4 may wrap this; here we read the invitation id
        inv_id = inv["invitation"]["id"] if "invitation" in inv else inv["id"]

        listed = c.get(f"/workspaces/{ws['id']}/invitations", headers={"X-User-Id": "alice"})
        assert listed.status_code == 200
        assert any(i["id"] == inv_id for i in listed.json())

        # non-admin cannot list
        assert c.get(
            f"/workspaces/{ws['id']}/invitations", headers={"X-User-Id": "mallory"}
        ).status_code == 403

        # revoke
        rev = c.delete(
            f"/workspaces/{ws['id']}/invitations/{inv_id}", headers={"X-User-Id": "alice"}
        )
        assert rev.status_code == 204
        assert c.get(
            f"/workspaces/{ws['id']}/invitations", headers={"X-User-Id": "alice"}
        ).json() == []
        # revoking again → 409
        assert c.delete(
            f"/workspaces/{ws['id']}/invitations/{inv_id}", headers={"X-User-Id": "alice"}
        ).status_code == 409
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v`
Expected: FAIL — 404/405 on the new routes (not yet defined).

- [ ] **Step 3: Add the endpoints to workspaces.py**

Add these routes (import `Project` and `InvitationStatus` at the top; `Response` and `HTTPException` are already imported). Place the projects route near the other workspace GETs and the invitation routes after `create_invitation`:

```python
@router.get("/workspaces/{workspace_id}/projects", response_model=list[Project])
def list_workspace_projects(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Project]:
    require_workspace(repo, workspace_id, user)
    return repo.list_projects_by_workspace(workspace_id)


@router.get(
    "/workspaces/{workspace_id}/invitations", response_model=list[Invitation]
)
def list_workspace_invitations(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Invitation]:
    require_admin(repo, workspace_id, user)
    return repo.list_invitations(workspace_id, status=InvitationStatus.pending)


@router.delete(
    "/workspaces/{workspace_id}/invitations/{invitation_id}",
    status_code=204,
    response_class=Response,
)
def revoke_workspace_invitation(
    workspace_id: str,
    invitation_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Response:
    require_admin(repo, workspace_id, user)
    try:
        repo.revoke_invitation(workspace_id, invitation_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="invitation_not_found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return Response(status_code=204)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/cloud && ruff check .
git add apps/cloud/app/api/workspaces.py apps/cloud/tests/test_invitations_foundation.py
git commit -m "feat(cloud): scoped-projects, list-invitations, revoke-invitation endpoints"
```

---

### Task 4: Invitation email (best-effort) + create response

**Files:**
- Create: `apps/cloud/app/invitations_email.py`
- Modify: `apps/cloud/app/config.py` (add `web_app_url`)
- Modify: `apps/cloud/app/main.py` (wire `app.state.invitation_mailer`)
- Modify: `apps/cloud/app/models/schemas.py` (add `InvitationCreateResponse`)
- Modify: `apps/cloud/app/api/workspaces.py` (create route returns the new response, sends email)
- Test: `apps/cloud/tests/test_invitations_foundation.py` (append)

**Interfaces:**
- Produces:
  - `InvitationMailer` protocol with `send(email: str, token: str) -> bool` (True = emailed).
  - `SupabaseInvitationMailer(settings)` — real impl; `NullInvitationMailer` — returns False (used when supabase unconfigured / in tests by default).
  - `InvitationCreateResponse` = `{invitation: Invitation, accept_url: str, email_sent: bool}`.
  - Create route response_model becomes `InvitationCreateResponse`.

- [ ] **Step 1: Write failing tests (append)**

```python
class _FakeMailer:
    def __init__(self, result: bool):
        self.result = result
        self.calls = []

    def send(self, email: str, token: str) -> bool:
        self.calls.append((email, token))
        return self.result


def _client_with_mailer(mailer):
    app = create_app()
    app.state.invitation_mailer = mailer
    return TestClient(app)


def test_create_invitation_emails_and_returns_accept_url():
    mailer = _FakeMailer(result=True)
    with _client_with_mailer(mailer) as c:
        ws = _mk_ws(c)
        res = c.post(
            f"/workspaces/{ws['id']}/invitations",
            json={"email": "new@b.com", "role": "member"},
            headers={"X-User-Id": "alice"},
        )
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["email_sent"] is True
        assert body["accept_url"].endswith(f"/invite/{body['invitation']['token']}")
        assert mailer.calls == [("new@b.com", body["invitation"]["token"])]


def test_create_invitation_survives_email_failure():
    mailer = _FakeMailer(result=False)  # e.g. existing user / SMTP down
    with _client_with_mailer(mailer) as c:
        ws = _mk_ws(c)
        res = c.post(
            f"/workspaces/{ws['id']}/invitations",
            json={"email": "existing@b.com", "role": "member"},
            headers={"X-User-Id": "alice"},
        )
        assert res.status_code == 201
        body = res.json()
        assert body["email_sent"] is False
        assert body["accept_url"].endswith(f"/invite/{body['invitation']['token']}")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v`
Expected: FAIL — response has no `email_sent`/`accept_url` (still bare `Invitation`), and `app.state.invitation_mailer` unset.

- [ ] **Step 3: Add `web_app_url` to config**

In `apps/cloud/app/config.py`, add to `Settings` (near `cors_origins`):

```python
    # Where invitation accept links point (the web app). Used to build the
    # accept URL emailed to invitees; also the Supabase invite redirect target.
    web_app_url: str = "http://localhost:3000"
```

- [ ] **Step 4: Create the mailer module**

```python
# apps/cloud/app/invitations_email.py
"""Best-effort invitation email via Supabase Admin (uses its configured SMTP).

Sending never blocks or fails an invitation: the invite row is the source of
truth and always has a shareable accept link. `send` returns True only when an
email actually went out, so the caller can tell the admin to share the link
manually otherwise (notably for an email that already has a Supabase account —
`invite_user_by_email` refuses those, which we treat as "not sent").
"""

from __future__ import annotations

import logging
from typing import Protocol

from app.config import Settings

logger = logging.getLogger("promptzone")


class InvitationMailer(Protocol):
    def send(self, email: str, token: str) -> bool: ...


class NullInvitationMailer:
    """Sends nothing (Supabase not configured / tests). Always 'not sent'."""

    def send(self, email: str, token: str) -> bool:  # noqa: D102
        return False


class SupabaseInvitationMailer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        from supabase import create_client  # lazy import

        # Service-role key: admin auth calls require it.
        self._client = create_client(settings.supabase_url, settings.supabase_key)

    def send(self, email: str, token: str) -> bool:
        redirect_to = f"{self._settings.web_app_url.rstrip('/')}/invite/{token}"
        try:
            self._client.auth.admin.invite_user_by_email(
                email, {"redirect_to": redirect_to}
            )
            return True
        except Exception as exc:  # noqa: BLE001 - email must never break invites
            # Existing-user (already registered) and transient SMTP errors both
            # land here; the invite is still valid via its link.
            logger.info("invitation email not sent to %s: %s", email, exc)
            return False


def build_invitation_mailer(settings: Settings) -> InvitationMailer:
    if settings.data_backend == "supabase" and settings.supabase_url and settings.supabase_key:
        return SupabaseInvitationMailer(settings)
    return NullInvitationMailer()
```

- [ ] **Step 5: Wire the mailer in main.py**

In `apps/cloud/app/main.py` `lifespan`, alongside the other `app.state.*` providers (e.g. after `app.state.github_client = ...`):

```python
    from app.invitations_email import build_invitation_mailer

    app.state.invitation_mailer = build_invitation_mailer(settings)
```

- [ ] **Step 6: Add the response model**

In `apps/cloud/app/models/schemas.py`, after the `Invitation` class:

```python
class InvitationCreateResponse(BaseModel):
    invitation: Invitation
    accept_url: str
    email_sent: bool
```

- [ ] **Step 7: Update the create route**

In `apps/cloud/app/api/workspaces.py`, change `create_invitation` to send email and return the new shape (import `InvitationCreateResponse`; add `Request` to the fastapi import):

```python
@router.post(
    "/workspaces/{workspace_id}/invitations",
    response_model=InvitationCreateResponse,
    status_code=201,
)
def create_invitation(
    workspace_id: str,
    body: InvitationCreate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> InvitationCreateResponse:
    require_admin(repo, workspace_id, user)
    invitation = Invitation(
        workspace_id=workspace_id,
        email=body.email,
        role=body.role,
        invited_by=user.id,
        expires_at=utcnow() + timedelta(days=INVITATION_TTL_DAYS),
    )
    saved = repo.create_invitation(invitation)
    web = request.app.state.settings.web_app_url.rstrip("/")
    accept_url = f"{web}/invite/{saved.token}"
    email_sent = request.app.state.invitation_mailer.send(saved.email, saved.token)
    return InvitationCreateResponse(invitation=saved, accept_url=accept_url, email_sent=email_sent)
```

- [ ] **Step 8: Run tests + full suite delta**

Run: `cd apps/cloud && AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_invitations_foundation.py -v && ruff check .`
Expected: PASS, ruff clean. Then run the existing invitation/workspace tests to confirm the create-response change didn't break them:
`AUTH_MODE=stub DATA_BACKEND=memory python -m pytest tests/test_workspaces.py -v`
If any existing test asserted the old bare-`Invitation` create shape, update it to read `.json()["invitation"]` — do NOT weaken assertions, adjust them to the new documented shape.

- [ ] **Step 9: Commit**

```bash
git add apps/cloud/app/invitations_email.py apps/cloud/app/config.py apps/cloud/app/main.py apps/cloud/app/models/schemas.py apps/cloud/app/api/workspaces.py apps/cloud/tests/test_invitations_foundation.py
git commit -m "feat(cloud): best-effort invitation email via Supabase Admin + accept_url response"
```

---

## Self-Review notes (for the executor)

- Spec coverage: scoped projects (Task 3) ✓, list/revoke invitations (Tasks 2–3) ✓, token hardening (Task 1) ✓, email best-effort + response shape + WEB_APP_URL (Task 4) ✓.
- Type consistency: `list_projects_by_workspace` / `list_invitations` / `revoke_invitation` signatures identical across ABC, InMemory, Supabase, and call sites. Create response `{invitation, accept_url, email_sent}` matches the web spec (Part 3) consumer.
- The one existing-test risk is the create-invitation response shape change (Task 4 Step 8) — reconcile, don't weaken.
