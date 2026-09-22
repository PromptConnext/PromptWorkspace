"""The single-instance ceiling, reported rather than removed.

Plan 0021 M4. Four pieces of this service hold state in the process rather than
in a store, and each of them is why `docs/DEPLOYMENT.md` §2.5 says "Replicas =
1": presence (`app/ws/manager.py`), the request rate limiter
(`app/ratelimit.py`), the per-workspace daily token budget
(`app/rag/budget.py`) plus the global managed limiter built in `app/main.py`,
and the embed queue (`app/rag/queue.py`). This module adds **no** shared
backplane, no Redis and no coordination — the plan declined to recommend one
merely because these components exist, and a single container is the right shape
for the current load. What it adds is the ability to find out.

**The order things break in, which the payload below is ordered by.** The
budget first, because its failure costs money rather than fidelity: split the
per-workspace daily cap across N replicas and the managed-Typhoon bill
multiplies by N, quietly and in the direction of spending more. Presence
second — it is user-visible (two people on the same project connected to
different replicas simply do not see each other) and therefore gets reported by
the people it happens to. The rate limiter and the embed queue come last not
because they matter least but because they degrade *silently*: every client's
effective request limit becomes N times the configured one, and a job enqueued
on one replica is invisible to the other, with nothing anywhere saying so. Those
two are the reason an external alarm exists at all.

**Why there is no replica count here, and what replaces it.** A process cannot
count its own peers. There is no discovery mechanism in this service, no
registry, and nothing in the container's environment that Railway or Cloud Run
guarantees to set to the current replica count — so a `replicas` field would
either be a configured constant repeating what the operator already typed, or a
guess. Instead this module mints `INSTANCE_ID` once, at import, and reports it
on every `/health` response. That turns "how many replicas are running?" into a
question an external monitor can answer without cooperation from the service:
poll `/health` repeatedly and compare the id. Two concurrent polls returning
different ids means more than one instance is serving traffic — the condition
that breaks all four components above. An id that changes between polls means
the single instance restarted, which is a different fault (in-flight embed jobs
lost, presence rooms emptied) and is worth its own alert.

`docs/DEPLOYMENT.md` §2.5 states the thresholds; this file only produces the
numbers. Everything here is read-only: it calls introspection accessors on the
four components and never touches enforcement.

One deliberate omission in the payload: **no workspace or project ids.**
`/health` is unauthenticated (`app/api/health.py` has no auth dependency), so
the budget block reports how much the busiest workspace has spent without
saying which one it is. An operator with a report in hand can get the identity
from the logs, where it is already scoped to a caller.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.models.schemas import utcnow

# Minted once per process, at import. Not a UUID for a request, a deployment or
# an app object: two `create_app()` calls in the same interpreter share it,
# because what it identifies is the process whose in-memory state all four
# components live in. See the module docstring for what an external monitor does
# with it.
INSTANCE_ID = uuid.uuid4().hex
INSTANCE_STARTED_AT = utcnow().isoformat()


def capacity_snapshot(state: Any) -> dict:
    """Point-in-time gauges for the four in-process components, plus this
    process's identity.

    Ordered by the sequence in the module docstring — budget, presence, then
    the queue — so the payload itself says what to fix first. The rate limiter
    has no block of its own: unlike the other three it has no meaningful depth
    to report (a bucket count measures client population, not saturation), and
    its multi-instance failure is detected by `instance_id` like everything
    else that degrades silently.

    Tolerates missing `app.state` attributes and reports nulls rather than
    raising: `/health` answering at all is more valuable than `/health`
    answering completely, and a request that arrives before `lifespan` has
    finished populating state should not 500.
    """
    return {
        "instance_id": INSTANCE_ID,
        "instance_started_at": INSTANCE_STARTED_AT,
        "budget": _budget(state),
        "presence": _presence(state),
        "queue": _queue(state),
    }


def _budget(state: Any) -> dict:
    """Headroom against the *managed* daily cap.

    The cap is per model connection, and a workspace on its own BYO key carries
    its own `daily_token_budget` that this module cannot see from the budget
    ledger alone. Reporting against `MANAGED_DAILY_TOKEN_BUDGET` is the right
    single number anyway: it is the one whose overrun spends the platform's
    money (ADR 0027 — planning is free and metered on managed Typhoon), while a
    BYO workspace exceeding its own cap spends its own key.
    """
    budget = getattr(state, "token_budget", None)
    limit = getattr(getattr(state, "settings", None), "managed_daily_token_budget", None)
    if budget is None:
        return {
            "managed_daily_limit": limit,
            "busiest_workspace_tokens": None,
            "headroom_tokens": None,
            "headroom_fraction": None,
            "workspaces_charged_today": None,
        }
    peak, workspaces = budget.peak_usage_today()
    headroom = None if limit is None else max(0, limit - peak)
    fraction = None
    if limit:
        fraction = round(max(0, limit - peak) / limit, 4)
    return {
        "managed_daily_limit": limit,
        "busiest_workspace_tokens": peak,
        "headroom_tokens": headroom,
        "headroom_fraction": fraction,
        "workspaces_charged_today": workspaces,
    }


def _presence(state: Any) -> dict:
    manager = getattr(state, "presence", None)
    if manager is None:
        return {"rooms": None, "connections": None}
    rooms, connections = manager.occupancy()
    return {"rooms": rooms, "connections": connections}


def _queue(state: Any) -> dict:
    queue = getattr(state, "embed_queue", None)
    if queue is None:
        return {"depth": None, "projects": None}
    depth, projects = queue.pending_snapshot()
    return {"depth": depth, "projects": projects}
