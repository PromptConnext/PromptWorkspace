"""Build the hosted MCP server and its ASGI app.

`build_mcp_server` wires bearer verification and the tools;
`build_mcp_asgi` returns the SDK's streamable-HTTP Starlette app with its
endpoint at "/", to be mounted at /mcp by app/main.py. The SDK's own
protected-resource metadata route lands at /mcp/.well-known/...; clients use
the top-level ones Task 4 serves, and the 401 `WWW-Authenticate` header the
SDK sends is computed from `resource_server_url`, so it names
`{PUBLIC_API_URL}/.well-known/oauth-protected-resource/mcp`."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import urlsplit

from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette

from app.db.repository import Repository
from app.mcp.auth import PromptWorkspaceTokenVerifier
from app.mcp.tools_planning import register_planning_tools
from app.mcp.tools_tasks import register_task_tools
from app.oauth.keys import SigningKey

INSTRUCTIONS = (
    "PromptWorkspace task tools. Call list_my_tasks to see the tasks assigned to you, "
    "get_task for one task's acceptance criteria, spec excerpt, branch name and commit "
    "prefix, and close_task to report progress: in_progress when you start, implemented "
    "with the commit sha when the work is pushed. Verification is a reviewer's step. "
    "For an imported project still being planned, start_planning returns the brief, "
    "submit_repo_analysis stores your clone's baseline (admins), and submit_stage_draft "
    "submits a stage document for review; pass project_id or your clone's repo_url."
)


def build_mcp_server(
    settings,
    repo_provider: Callable[[], Repository],
    keys: Iterable[SigningKey | None],
    *,
    app_provider: Callable[[], Any] | None = None,
    family_cache_ttl: float = 30.0,
) -> MCPServer:
    verifier = PromptWorkspaceTokenVerifier(
        settings, keys, repo_provider, family_cache_ttl=family_cache_ttl
    )
    server = MCPServer(
        name="promptworkspace",
        instructions=INSTRUCTIONS,
        token_verifier=verifier,
        auth=AuthSettings(
            issuer_url=settings.oauth_issuer,
            resource_server_url=settings.canonical_mcp_url,
            required_scopes=["mcp"],
            validate_token_resource=True,
        ),
    )
    server.promptworkspace_token_verifier = verifier  # type: ignore[attr-defined]
    register_task_tools(server, repo_provider, app_provider)
    register_planning_tools(server, repo_provider, app_provider)
    return server


def build_mcp_asgi(server: MCPServer, settings) -> Starlette:
    public_host = urlsplit(settings.public_api_url).netloc
    allowed_hosts = [h for h in (public_host, "localhost:*", "127.0.0.1:*") if h]
    return server.streamable_http_app(
        streamable_http_path="/",
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=allowed_hosts,
            allowed_origins=settings.cors_origin_list,
        ),
        session_idle_timeout=1800,
    )
