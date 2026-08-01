"""app/policies/registry.py + GET /policy-templates (C7, Policy Scope
feature): registry completeness and the listing endpoint."""

from __future__ import annotations

import jwt
import pytest
from fastapi.testclient import TestClient

from app.policies.registry import BUILTIN_TEMPLATES, get_template, template_body

ALICE = {"X-User-Id": "alice"}

_EXPECTED_IDS = {"thai-pdpa", "thai-law", "gdpr", "iso-27001", "soc-2", "internal-policy"}


def test_registry_has_exactly_the_six_builtin_ids():
    assert {t.id for t in BUILTIN_TEMPLATES} == _EXPECTED_IDS


def test_every_builtin_template_has_a_non_empty_body_with_the_disclaimer():
    for template in BUILTIN_TEMPLATES:
        body = template_body(template.id)
        assert body.strip()
        assert "Planning guidance for an AI assistant, not legal advice." in body
        assert template.name
        assert template.description


def test_get_template_resolves_known_ids_and_none_for_unknown():
    assert get_template("gdpr") is not None
    assert get_template("not-a-real-template") is None


def test_list_policy_templates_returns_all_six_with_bodies(client: TestClient):
    res = client.get("/policy-templates", headers=ALICE)
    assert res.status_code == 200, res.text
    body = res.json()
    assert {t["id"] for t in body} == _EXPECTED_IDS
    for entry in body:
        assert entry["body"].strip()
        assert entry["name"]
        assert entry["description"]


def test_list_policy_templates_accepts_unused_workspace_id_query_param(client: TestClient):
    res = client.get("/policy-templates", params={"workspace_id": "ws-1"}, headers=ALICE)
    assert res.status_code == 200, res.text
    assert len(res.json()) == 6


# --------------------------------------------------------------------------- #
# 401 under supabase auth mode (stub auth mode never rejects — see
# app/dependencies.py::get_current_user)
# --------------------------------------------------------------------------- #
JWT_SECRET = "test-secret-please-change-0123456789abcdef"


@pytest.fixture
def jwt_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", JWT_SECRET)
    from app.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def test_list_policy_templates_401_without_a_token(jwt_client: TestClient):
    assert jwt_client.get("/policy-templates").status_code == 401


def test_list_policy_templates_200_with_a_valid_token(jwt_client: TestClient):
    token = jwt.encode(
        {"sub": "alice", "email": "alice@x.com", "aud": "authenticated"},
        JWT_SECRET,
        algorithm="HS256",
    )
    res = jwt_client.get("/policy-templates", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, res.text
    assert len(res.json()) == 6
