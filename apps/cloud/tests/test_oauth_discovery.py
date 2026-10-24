import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.oauth.known_clients import classify


def _pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


@pytest.fixture
def oauth_client(monkeypatch):
    monkeypatch.setenv("MCP_ENABLED", "1")
    monkeypatch.setenv("MCP_OAUTH_SIGNING_KEY", _pem())
    monkeypatch.setenv("PUBLIC_API_URL", "https://api.test/")
    get_settings.cache_clear()
    yield TestClient(create_app())
    get_settings.cache_clear()


def test_as_metadata_exact(oauth_client):
    iss = "https://api.test"
    for path in (
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/mcp",
    ):
        r = oauth_client.get(path)
        assert r.status_code == 200
        assert r.headers["cache-control"] == "public, max-age=300"
        assert r.json() == {
            "issuer": iss,
            "authorization_endpoint": f"{iss}/oauth/authorize",
            "token_endpoint": f"{iss}/oauth/token",
            "registration_endpoint": f"{iss}/oauth/register",
            "revocation_endpoint": f"{iss}/oauth/revoke",
            "jwks_uri": f"{iss}/oauth/jwks.json",
            "code_challenge_methods_supported": ["S256"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "response_types_supported": ["code"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": ["mcp"],
            "client_id_metadata_document_supported": True,
            "authorization_response_iss_parameter_supported": True,
        }


def test_prm_exact_and_paths_identical(oauth_client):
    a = oauth_client.get("/.well-known/oauth-protected-resource")
    b = oauth_client.get("/.well-known/oauth-protected-resource/mcp")
    assert a.status_code == b.status_code == 200
    assert a.headers["cache-control"] == "public, max-age=300"
    assert a.json() == b.json() == {
        "resource": "https://api.test/mcp",
        "authorization_servers": ["https://api.test"],
        "scopes_supported": ["mcp"],
        "bearer_methods_supported": ["header"],
    }


def test_jwks(oauth_client):
    r = oauth_client.get("/oauth/jwks.json")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=300"
    keys = r.json()["keys"]
    assert len(keys) == 1 and keys[0]["kid"]


def test_absent_when_disabled(client):
    assert client.get("/oauth/jwks.json").status_code == 404
    assert client.get("/.well-known/oauth-protected-resource").status_code == 404


@pytest.mark.parametrize(
    "uris,expected",
    [
        (["http://127.0.0.1:5555/callback"], ("loopback", True)),
        (["http://localhost:1234/cb"], ("loopback", True)),
        (["https://claude.ai/api/mcp/auth_callback"], ("Claude", True)),
        (
            ["http://localhost:8787/callback", "https://www.cursor.com/agents/mcp/oauth/callback"],
            ("Cursor", True),
        ),
        (
            [
                "cursor://anysphere.cursor-mcp/oauth/callback",
                "https://www.cursor.com/agents/mcp/oauth/callback",
                "http://localhost:8787/callback",
            ],
            ("Cursor", True),
        ),
        (["cursor://evil/callback"], (None, False)),
        (["https://chatgpt.com/connector_platform_oauth_redirect"], ("ChatGPT", True)),
        (["http://localhost:1/cb", "https://chatgpt.com/x"], (None, False)),
        (["https://evil.example/cb"], (None, False)),
        (["http://localhost.evil.com/cb"], (None, False)),
        (["http://user@localhost/cb"], (None, False)),
        (["https://claude.ai/a", "https://www.cursor.com/b"], (None, False)),
        ([], (None, False)),
    ],
)
def test_classify(uris, expected):
    assert classify(uris) == expected
