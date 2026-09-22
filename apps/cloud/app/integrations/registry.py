"""Adapter registry — resolve a provider name to its TrackerAdapter.

REGISTERED IS NOT AVAILABLE (plan 0019 M4; finding 14)
`ClickUpAdapter` implements the whole `TrackerAdapter` surface and is
deliberately kept here — it is what keeps the sync boundary honestly
provider-agnostic — but it has no working credential path end to end:
`app/api/integrations.py::_outbound_auth` resolves a token for `jira` only, so
every outbound mirror raised `tracker_credentials_missing`, and it has no
account-identity source for the inbound side either (plan 0019 M2 routes on the
site URL Jira puts in every payload; ClickUp's webhook body carries no
equivalent), so an inbound delivery could never resolve an account or verify
against one.

Advertising it through `GET /integrations/providers` and accepting a
configuration for it therefore promised support nothing could deliver. The
honest split is the one below: `_ADAPTERS` is what the codebase *implements*,
`_AVAILABLE` is what an operator may actually configure. Completing ClickUp
means giving it its own credential resolution and its own account identity —
which is a second provider's settings surface with no first user driving it, a
separate change from this one — and when that lands, its name joins `_AVAILABLE`
and nothing else here moves.
"""

from __future__ import annotations

from app.integrations.clickup import ClickUpAdapter
from app.integrations.jira import JiraAdapter
from app.integrations.tracker import TrackerAdapter

_ADAPTERS: dict[str, TrackerAdapter] = {
    "jira": JiraAdapter(),
    "clickup": ClickUpAdapter(),
}

# Providers whose credential *and* account-identity path exists end to end.
_AVAILABLE = frozenset({"jira"})


def get_adapter(provider: str) -> TrackerAdapter | None:
    """The adapter for a *registered* provider, available or not.

    Deliberately not filtered: the API layer needs to tell an unknown provider
    name (404 `unknown_provider`) apart from a real one that cannot be used yet
    (400 `provider_unavailable`), and collapsing the two would report a typo and
    a known gap identically.
    """
    return _ADAPTERS.get(provider)


def is_available(provider: str) -> bool:
    return provider in _AVAILABLE


def list_providers() -> list[str]:
    """Only the providers an operator can actually configure — this is what
    `GET /integrations/providers` advertises."""
    return [name for name in _ADAPTERS if name in _AVAILABLE]
