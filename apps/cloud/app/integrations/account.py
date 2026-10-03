"""Tracker account identity (plan 0019 M1).

A tracker reference is unique within a provider *account*, not within the
provider: Jira issue keys are short and sequential per project and operators
reuse the same project prefix across independently provisioned Cloud sites, so
two tenants both produce `PZ-1`. `account_key` is the identity that separates
them, and it has to be derivable from two places that never talk to each other
— the admin's stored `base_url` at configuration time, and the sending tenant's
own URL inside an inbound webhook payload — so the normalization lives here,
once, rather than being open-coded on either side.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlparse


def normalize_account_key(url: str) -> str:
    """Reduce any URL on a provider account to that account's identity: scheme
    plus lowercased host, no port-less/trailing-slash variation, no path.

    `https://Acme.atlassian.net/`, `https://acme.atlassian.net`,
    `https://acme.atlassian.net:443` and the `issue.self` link
    `https://acme.atlassian.net/rest/api/3/issue/10002` all normalize to
    `https://acme.atlassian.net`. Returns `""` for anything that is not an
    absolute http(s) URL with a host — callers treat that as "no account
    identity", never as a wildcard, and `pw_workspace_integrations.account_key`
    carries a `<> ''` check constraint so an empty key can never match a row.

    The default port is dropped rather than kept, and that is not cosmetic: an
    admin who saves `https://acme.atlassian.net:443` would otherwise get an
    account_key no Jira payload can ever produce (Jira's `self` links are
    port-less), so every delivery would fail to route — and a later re-save
    without the port would look like a *different* account and silently rotate
    the secret out from under the webhook already registered on the Jira side.
    """
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https"):
        return ""
    host = (parsed.hostname or "").lower()
    if not host:
        return ""
    default_port = 443 if parsed.scheme == "https" else 80
    port = parsed.port
    netloc = host if port in (None, default_port) else f"{host}:{port}"
    return f"{parsed.scheme}://{netloc}"


def new_webhook_secret() -> str:
    """Signing secret for one tracker account's webhook.

    The tracker analogue of `app/integrations/github.py::new_webhook_secret`,
    and for the same reason: generated per account at configuration time, so a
    delivery that validates against an account's secret provably came from that
    account. The retired `JIRA_WEBHOOK_SECRET` was one process-wide value every
    configured site held, which could only ever prove that *some* configured
    site sent a delivery.
    """
    return secrets.token_hex(32)
