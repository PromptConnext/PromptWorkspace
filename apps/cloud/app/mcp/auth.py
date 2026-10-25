"""Bearer verification for /mcp, and the caller's identity inside a tool.

The token is our own ES256 access token (app/oauth/tokens.py). On top of the
signature, issuer, audience and expiry checks, a token is refused once its
family is revoked: the family read is cached per family for
`family_cache_ttl` seconds, so "revoke" takes effect within that window
rather than within the access-token lifetime; a revocation through
`/me/oauth-grants` evicts the family at once (`evict`). Tokens are never logged; the
family id is what log lines name."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable
from datetime import datetime, timezone

import anyio.to_thread
from cryptography.hazmat.primitives import serialization
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.mcpserver.exceptions import ToolError

from app.db.repository import Repository
from app.dependencies import User
from app.oauth.keys import SigningKey
from app.oauth.tokens import TokenError, verify_access_token

logger = logging.getLogger("promptworkspace.mcp")

# How often a family's last_used_at is bumped from /mcp traffic.
_TOUCH_INTERVAL = 300.0


class PromptWorkspaceTokenVerifier(TokenVerifier):
    def __init__(
        self,
        settings,
        keys: Iterable[SigningKey | None],
        repo: Callable[[], Repository],
        *,
        family_cache_ttl: float = 30.0,
    ) -> None:
        self._settings = settings
        self._keys = [k for k in keys if k is not None]
        # Parse each PEM once, keyed by kid; verification never re-parses.
        self._public = {
            k.kid: serialization.load_pem_private_key(k.private_pem.encode(), None).public_key()
            for k in self._keys
        }
        self._repo = repo
        self.family_cache_ttl = family_cache_ttl
        self._family_ok: dict[str, float] = {}  # family_id -> monotonic expiry
        self._touched: dict[str, float] = {}  # family_id -> monotonic last touch

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            claims = verify_access_token(
                self._settings, self._keys, token, public_keys=self._public
            )
        except TokenError as err:
            logger.info("mcp bearer refused: %s", err.code)
            return None
        if "mcp" not in claims.scope.split():
            return None
        fid = claims.family_id
        if not fid or not await self._family_live(fid):
            logger.info("mcp bearer refused: family %s revoked or unknown", fid or "-")
            return None
        return AccessToken(
            token=token,
            client_id=claims.client_id,
            scopes=["mcp"],
            expires_at=int(claims.exp.timestamp()),
            resource=self._settings.canonical_mcp_url,
            subject=claims.sub,
            claims={"email": claims.email, "fid": claims.family_id},
        )

    def evict(self, family_id: str) -> None:
        """Forget a family's cached liveness, so a revocation made in this
        process takes effect on the very next call instead of within
        `family_cache_ttl`."""
        self._family_ok.pop(family_id, None)

    async def _family_live(self, fid: str) -> bool:
        now = time.monotonic()
        expiry = self._family_ok.get(fid)
        if expiry is not None and now < expiry:
            return True
        repo = self._repo()
        family = await anyio.to_thread.run_sync(repo.get_oauth_family, fid)
        if family is None or family.revoked_at is not None:
            self._family_ok.pop(fid, None)
            return False
        if self.family_cache_ttl > 0:
            self._family_ok[fid] = now + self.family_cache_ttl
        last = self._touched.get(fid)
        if last is None or now - last >= _TOUCH_INTERVAL:
            self._touched[fid] = now
            try:
                await anyio.to_thread.run_sync(
                    repo.touch_oauth_family, fid, datetime.now(timezone.utc)
                )
            except Exception:  # noqa: BLE001 - bookkeeping must not refuse a valid token
                logger.exception("touch_oauth_family failed for family %s", fid)
        return True


def current_user() -> User:
    """The authenticated caller, from the verified bearer only. Tools never
    take a user id from their arguments."""
    token = get_access_token()
    if token is None or not token.subject:
        raise ToolError("not_authenticated: sign in again; this request carried no valid token.")
    email = (token.claims or {}).get("email") or ""
    return User(id=token.subject, email=email)
