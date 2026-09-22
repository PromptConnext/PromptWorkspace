"""Shared helper for the tracker-webhook tests (plan 0019).

Not a `conftest.py` and not a fixture: it is one plain function three test
modules need, which is the shape `tests/contract/_helpers.py` already uses.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def account_secret(client: TestClient, workspace_id: str, provider: str = "jira") -> str:
    """The signing secret for one workspace's tracker account.

    Deliberately unavailable over HTTP: `WorkspaceIntegration` is never returned
    by a route, exactly as `RepoWebhook` never is, so a test that wants to play
    the part of the tracker reads the row and decrypts it the way the webhook
    route does. If this ever becomes obtainable through the API, that is the
    regression to look at first.
    """
    integration = client.app.state.repository.get_workspace_integration(workspace_id, provider)
    assert integration is not None, f"no {provider} integration for workspace {workspace_id}"
    return client.app.state.secret_store.decrypt(integration.webhook_secret_ref)
