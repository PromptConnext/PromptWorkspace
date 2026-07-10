"""FastAPI dependencies: current user (stub or JWT) and repository accessor.

Two auth modes (see Settings.auth_mode):
  * "stub"     — identity from an `X-User-Id` header (default; tests/local dev).
                 Swap users freely to exercise multi-user behaviour.
  * "supabase" — verify a real Supabase HS256 bearer JWT (aud="authenticated")
                 on every request; identity comes from the `sub` claim.

Authorization (workspace membership / admin) lives in `app/api/_guards.py` so
it can be reused across routers.
"""

from __future__ import annotations

from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException, Request

from app.db.repository import Repository


@dataclass
class User:
    id: str
    email: str


def get_current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None),
) -> User:
    settings = request.app.state.settings
    if settings.auth_mode == "stub":
        uid = x_user_id or "dev-user"
        return User(id=uid, email=f"{uid}@promptzone.local")

    # supabase: verify the HS256 bearer JWT minted by Supabase Auth.
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="missing_token")
    try:
        claims = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid_token")
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="invalid_token")
    return User(id=sub, email=claims.get("email", ""))


def get_repository(request: Request) -> Repository:
    return request.app.state.repository
