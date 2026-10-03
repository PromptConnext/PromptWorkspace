"""Resolving a workspace's GitHub credential.

Three call sites need "the token for this workspace" — repo creation
(`api/sync.py`), RAG code indexing (`rag/queue.py`) and assistant snippet
fetch (`api/assistant.py`). Under the old GitHub App they each rebuilt the
same four-line dance of reading `settings.github_app_*`, pulling
`installation_id` off the workspace and minting a token. Under per-workspace
PATs the read is a decrypt, and it lives here once.

Returns `None` rather than raising for every "not configured" shape — no
GitHub config, no token, wrong auth kind. All three callers treat an
unconfigured workspace as a skip, not a failure.
"""

from __future__ import annotations

import logging

from app.models.schemas import Workspace

logger = logging.getLogger("promptworkspace.github")


def github_config(workspace: Workspace | None) -> dict | None:
    """The workspace's GitHub block, or None if it isn't connected.

    Rejects a config that predates the PAT migration (one carrying
    `installation_id` and no `secret_ref`) instead of half-working: those
    workspaces must reconnect with a token.
    """
    if workspace is None:
        return None
    config = (workspace.integration_config or {}).get("github")
    if not isinstance(config, dict) or not config.get("secret_ref"):
        return None
    return config


def resolve_token(app, workspace: Workspace | None) -> tuple[str, dict] | None:
    """(plaintext token, config) for this workspace, or None if unconfigured.

    A decrypt failure — a rotated `RAG_KEY_ENCRYPTION_KEY`, a corrupted row —
    is logged and treated as unconfigured. Raising would turn a broken
    credential into a 500 on unrelated read paths like the assistant.
    """
    config = github_config(workspace)
    if config is None:
        return None
    try:
        token = app.state.secret_store.decrypt(config["secret_ref"])
    except Exception:  # noqa: BLE001 - any decrypt failure is "unusable credential"
        logger.warning(
            "github token for workspace=%s could not be decrypted", getattr(workspace, "id", "?")
        )
        return None
    if not token:
        return None
    return token, config
