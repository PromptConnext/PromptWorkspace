"""Is a Supabase user still allowed to hold MCP tokens?

The token endpoint asks before each refresh rotation (and at code exchange), so
a deleted or banned account loses its agents within one access-token lifetime.
Fail closed only on a definite answer (404, or `banned_until` in the future);
an infrastructure failure (network, 5xx) fails open with a warning, since
locking every agent out during a Supabase blip would be worse than a few more
minutes of access for an account that is still, as far as we know, active.
Definite answers are cached per user for 300 s; failures are not cached."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

CACHE_TTL = timedelta(seconds=300)
_TIMEOUT = 5.0


@dataclass(frozen=True)
class UserRecord:
    active: bool
    email: str = ""


def _banned(value, now: datetime) -> bool:
    if not value or not isinstance(value, str):
        return False
    try:
        until = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        # GoTrue writes "none" for an unbanned user; anything unparseable is
        # not a ban we can act on.
        return False
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until > now


async def lookup_user(
    settings, user_id: str, *, http: httpx.AsyncClient | None, cache: dict, now=None
) -> UserRecord:
    if settings.auth_mode == "stub":
        return UserRecord(active=True, email=f"{user_id}@promptworkspace.local")
    now = now or datetime.now(timezone.utc)
    hit = cache.get(user_id)
    if hit is not None and hit[0] > now:
        return hit[1]
    if http is None:
        logger.warning("Supabase user check skipped: no HTTP client")
        return UserRecord(active=True)
    key = settings.supabase_key
    url = f"{settings.supabase_url.rstrip('/')}/auth/v1/admin/users/{quote(user_id, safe='')}"
    try:
        resp = await http.get(
            url,
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as err:
        logger.warning("Supabase user check failed (%s); allowing", type(err).__name__)
        return UserRecord(active=True)
    if resp.status_code == 404:
        record = UserRecord(active=False)
    elif resp.status_code == 200:
        try:
            body = resp.json()
        except ValueError:
            logger.warning("Supabase user check returned non-JSON; allowing")
            return UserRecord(active=True)
        body = body if isinstance(body, dict) else {}
        email = body.get("email") if isinstance(body.get("email"), str) else ""
        record = UserRecord(active=not _banned(body.get("banned_until"), now), email=email)
    else:
        logger.warning("Supabase user check returned %s; allowing", resp.status_code)
        return UserRecord(active=True)
    cache[user_id] = (now + CACHE_TTL, record)
    return record


async def user_is_active(
    settings, user_id: str, *, http: httpx.AsyncClient | None, cache: dict, now=None
) -> bool:
    return (await lookup_user(settings, user_id, http=http, cache=cache, now=now)).active
