"""FastAPI dependencies: current user (stubbed) and repository accessor.

Auth is intentionally stubbed for this milestone. `get_current_user` returns a
dev identity, optionally overridden by an `X-User-Id` header so multi-user
behaviour can be exercised in tests. Swap this for Supabase JWT validation when
auth lands (roadmap Phase 2).
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, Request

from app.db.repository import Repository


@dataclass
class User:
    id: str
    email: str


def get_current_user(x_user_id: str | None = Header(default=None)) -> User:
    user_id = x_user_id or "dev-user"
    return User(id=user_id, email=f"{user_id}@promptzone.local")


def get_repository(request: Request) -> Repository:
    return request.app.state.repository
