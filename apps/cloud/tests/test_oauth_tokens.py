import base64
import hashlib
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import Settings
from app.oauth.keys import jwks, load_signing_keys
from app.oauth.tokens import (
    TokenError,
    hash_token,
    issue_access_token,
    new_refresh_token,
    verify_access_token,
)


def _pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


@pytest.fixture
def settings_with_key():
    return Settings(mcp_enabled=True, mcp_oauth_signing_key=_pem(), public_api_url="https://api.test")


@pytest.fixture
def settings_with_two_keys():
    return Settings(
        mcp_enabled=True,
        mcp_oauth_signing_key=_pem(),
        mcp_oauth_previous_signing_key=_pem(),
        public_api_url="https://api.test",
    )


def _issue(settings, key):
    return issue_access_token(
        settings, key, sub="u1", email="u@x", client_id="c1", family_id="f1"
    )


def test_issue_and_verify_round_trip(settings_with_key):
    key, _ = load_signing_keys(settings_with_key)
    token, claims = _issue(settings_with_key, key)
    back = verify_access_token(settings_with_key, [key], token)
    assert (back.sub, back.client_id, back.family_id, back.scope) == ("u1", "c1", "f1", "mcp")
    assert back.email == "u@x" and back.jti == claims.jti
    assert back.aud == "https://api.test/mcp"
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "ES256" and header["kid"] == key.kid


def test_wrong_audience_is_refused(settings_with_key):
    key, _ = load_signing_keys(settings_with_key)
    other = settings_with_key.model_copy(update={"public_api_url": "https://other"})
    # same issuer string needed so only aud differs
    token = jwt.encode(
        {
            "iss": "https://api.test",
            "aud": "https://other/mcp",
            "sub": "u1",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        key.private_pem,
        algorithm="ES256",
        headers={"kid": key.kid},
    )
    assert other  # silence unused
    with pytest.raises(TokenError) as exc:
        verify_access_token(settings_with_key, [key], token)
    assert exc.value.code == "wrong_audience"


def test_iss_is_the_metadata_issuer_without_a_trailing_slash(settings_with_key):
    slash = settings_with_key.model_copy(update={"public_api_url": "https://api.test/"})
    key, _ = load_signing_keys(slash)
    token, _ = _issue(slash, key)
    assert jwt.decode(token, options={"verify_signature": False})["iss"] == "https://api.test"
    assert slash.oauth_issuer == "https://api.test"
    # Either spelling of PUBLIC_API_URL verifies the other's tokens.
    assert verify_access_token(settings_with_key, [key], token).sub == "u1"
    token2, _ = _issue(settings_with_key, key)
    assert verify_access_token(slash, [key], token2).sub == "u1"


def test_wrong_issuer_and_expired(settings_with_key):
    key, _ = load_signing_keys(settings_with_key)
    token = jwt.encode(
        {
            "iss": "https://evil.test",
            "aud": "https://api.test/mcp",
            "sub": "u1",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        key.private_pem,
        algorithm="ES256",
        headers={"kid": key.kid},
    )
    with pytest.raises(TokenError) as exc:
        verify_access_token(settings_with_key, [key], token)
    assert exc.value.code == "wrong_issuer"
    old = datetime.now(timezone.utc) - timedelta(hours=2)
    token, _ = issue_access_token(
        settings_with_key, key, sub="u", email="e", client_id="c", family_id="f", now=old
    )
    with pytest.raises(TokenError) as exc:
        verify_access_token(settings_with_key, [key], token)
    assert exc.value.code == "expired"


def test_supabase_shaped_token_is_refused(settings_with_key):
    key, _ = load_signing_keys(settings_with_key)
    token = jwt.encode({"aud": "authenticated", "sub": "u1"}, "s" * 32, algorithm="HS256")
    with pytest.raises(TokenError) as exc:
        verify_access_token(settings_with_key, [key], token)
    assert exc.value.code == "malformed"


def test_bad_signature_and_garbage(settings_with_two_keys):
    cur, prev = load_signing_keys(settings_with_two_keys)
    token, _ = _issue(settings_with_two_keys, cur)
    forged = jwt.encode(
        jwt.decode(token, options={"verify_signature": False}),
        prev.private_pem,
        algorithm="ES256",
        headers={"kid": cur.kid},
    )
    with pytest.raises(TokenError) as exc:
        verify_access_token(settings_with_two_keys, [cur], forged)
    assert exc.value.code == "invalid_signature"
    with pytest.raises(TokenError) as exc:
        verify_access_token(settings_with_two_keys, [cur], "not-a-jwt")
    assert exc.value.code == "malformed"


def test_previous_key_still_verifies(settings_with_two_keys):
    cur, prev = load_signing_keys(settings_with_two_keys)
    assert prev is not None and prev.kid != cur.kid
    token, _ = _issue(settings_with_two_keys, prev)
    assert verify_access_token(settings_with_two_keys, [cur, prev], token).sub == "u1"
    with pytest.raises(TokenError) as exc:
        verify_access_token(settings_with_two_keys, [cur], token)
    assert exc.value.code == "malformed"


def test_jwks_lists_current_and_previous_with_kids(settings_with_two_keys):
    cur, prev = load_signing_keys(settings_with_two_keys)
    doc = jwks([cur, prev])
    assert [k["kid"] for k in doc["keys"]] == [cur.kid, prev.kid]
    for k in doc["keys"]:
        assert k["kty"] == "EC" and k["crv"] == "P-256" and k["alg"] == "ES256"
        assert k["use"] == "sig" and "d" not in k


def test_kid_is_rfc7638_thumbprint(settings_with_key):
    import json

    key, _ = load_signing_keys(settings_with_key)
    j = key.public_jwk
    canon = json.dumps(
        {"crv": j["crv"], "kty": j["kty"], "x": j["x"], "y": j["y"]},
        separators=(",", ":"),
        sort_keys=True,
    )
    digest = hashlib.sha256(canon.encode()).digest()
    assert key.kid == base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def test_require_mcp_refuses_enabled_without_key_or_public_url():
    Settings(mcp_enabled=False).require_mcp()
    with pytest.raises(RuntimeError, match="MCP_OAUTH_SIGNING_KEY"):
        Settings(mcp_enabled=True, public_api_url="https://api.test").require_mcp()
    with pytest.raises(RuntimeError, match="PUBLIC_API_URL"):
        Settings(mcp_enabled=True, mcp_oauth_signing_key="x").require_mcp()
    Settings(
        mcp_enabled=True, mcp_oauth_signing_key="x", public_api_url="https://api.test/"
    ).require_mcp()


def test_canonical_mcp_url():
    assert Settings(public_api_url="https://api.test/").canonical_mcp_url == "https://api.test/mcp"


def test_refresh_token_is_48_bytes_urlsafe_and_hash_is_sha256():
    raw, digest = new_refresh_token()
    assert len(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))) == 48
    assert digest == hashlib.sha256(raw.encode()).hexdigest() == hash_token(raw)
