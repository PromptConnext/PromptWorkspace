"""Real-time presence over WebSocket (M6).

`WS /ws/projects/{id}/presence` — authenticates the caller (JWT in supabase
mode, `?user_id=` in stub mode), verifies workspace membership, joins a
per-project room, and fans out the roster on every join/leave/heartbeat.

Clients send periodic heartbeats `{"cursor_hint": "..."}`; the server updates
last-seen and rebroadcasts. No graph data flows here.
"""

from __future__ import annotations

import time

import jwt
from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from app.dependencies import User

router = APIRouter(tags=["presence"])

# Close codes.
_POLICY_VIOLATION = 1008  # unauthenticated / not a member
_TRY_AGAIN_LATER = 1013  # room at capacity


def _identify(websocket: WebSocket, settings) -> User | None:
    if settings.auth_mode == "stub":
        uid = websocket.query_params.get("user_id") or "dev-user"
        return User(id=uid, email=f"{uid}@promptconnext.local")
    token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        claims = jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except jwt.PyJWTError:
        return None
    sub = claims.get("sub")
    return User(id=sub, email=claims.get("email", "")) if sub else None


@router.websocket("/ws/projects/{project_id}/presence")
async def presence(websocket: WebSocket, project_id: str) -> None:
    settings = websocket.app.state.settings
    repo = websocket.app.state.repository
    manager = websocket.app.state.presence

    user = _identify(websocket, settings)
    if user is None:
        await websocket.close(code=_POLICY_VIOLATION)
        return

    project = repo.get_project(project_id)
    if project is None or repo.get_membership(project.workspace_id, user.id) is None:
        await websocket.close(code=_POLICY_VIOLATION)
        return

    if not await manager.connect(project_id, websocket, user.id, time.monotonic()):
        await websocket.close(code=_TRY_AGAIN_LATER)
        return

    await manager.broadcast_roster(project_id)
    try:
        while True:
            data = await websocket.receive_json()
            manager.touch(
                project_id, websocket, data.get("cursor_hint"), time.monotonic()
            )
            await manager.broadcast_roster(project_id)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(project_id, websocket)
        await manager.broadcast_roster(project_id)
