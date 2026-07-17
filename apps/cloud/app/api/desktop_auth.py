# apps/cloud/app/api/desktop_auth.py
"""Desktop browser-auth handoff (ADR 0014).

The web app, after a Supabase sign-in, deposits its session here; the desktop
redeems the returned opaque code exactly once. `/handoff` is authenticated (the
depositor is a signed-in user); `/redeem` is NOT — the single-use, short-TTL
code IS the credential, and requiring a token there would defeat the purpose.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.dependencies import User, get_current_user

router = APIRouter(prefix="/desktop-auth", tags=["desktop-auth"])


class HandoffRequest(BaseModel):
    refresh_token: str
    access_token: str


class HandoffResponse(BaseModel):
    code: str


class RedeemRequest(BaseModel):
    code: str


class RedeemResponse(BaseModel):
    access_token: str
    refresh_token: str
    user_id: str


@router.post("/handoff", response_model=HandoffResponse)
def handoff(
    body: HandoffRequest,
    request: Request,
    user: User = Depends(get_current_user),
) -> HandoffResponse:
    store = request.app.state.handoff_store
    code = store.put(
        refresh_token=body.refresh_token,
        access_token=body.access_token,
        user_id=user.id,
    )
    return HandoffResponse(code=code)


@router.post("/redeem", response_model=RedeemResponse)
def redeem(body: RedeemRequest, request: Request) -> RedeemResponse:
    session = request.app.state.handoff_store.take(body.code)
    if session is None:
        raise HTTPException(status_code=404, detail="invalid_or_expired_code")
    return RedeemResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user_id=session.user_id,
    )
