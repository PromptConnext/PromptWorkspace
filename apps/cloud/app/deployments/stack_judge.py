"""Judging a project's stack profile with a typed model (TypeSafe), pinned.

`plan_profile.derive_stack_profile` counts keywords, which cannot tell "we
will NOT use Redis" from "we use Redis", or a Python backend from its
TypeScript client. This module asks a System One model the same two things —
which runtime the application server is written in, and whether each backing
service is needed — as three independent typed questions answered in one
request, and turns the answers into a `StackProfile` with explicit thresholds.

What it does not change is plan_profile's contract:

- **It still only selects.** Every answer is one of the runtimes and services
  the template already ships a hand-written scaffold for; an answer outside
  that set ("other") is not a selection, it is a fall back. ADR 0024
  decision 1 holds exactly as it did for the scanner.
- **The seed is still reproducible.** The judgment is stored on
  `DeploymentConfig.stack_judgment` with a hash of the exact state it was
  asked about, and reused for as long as that hash matches. The seed preview
  and `create_repository` — and any retry of it — therefore select the same
  files; a changed plan is asked again, once.
- **It degrades per dimension, never fails.** No client, a failed call, a
  diffuse runtime distribution or a service probability in the uncertain
  band each fall back to the keyword scan for that dimension only.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from app.deployments.plan_profile import (
    RUNTIMES,
    SERVICES,
    StackProfile,
    derive_stack_profile,
)
from app.integrations.typesafe import TypeSafeClient, TypeSafeError
from app.models.schemas import RepoSnapshot, StackJudgment

logger = logging.getLogger("promptworkspace.stack_judge")

# The plan is the whole evidence for a scratch project; a very long one is
# cut rather than refused. Manifests are short by nature, and only their head
# says what the project is built with.
_PLAN_CHARS = 30_000
_MANIFEST_CHARS = 2_000

# Below this the runtime distribution is spread across options — typically a
# plan that describes two stacks without saying which one serves — and the
# keyword scan (or an imported repository's manifests) decides instead.
RUNTIME_MIN_CONFIDENCE = 0.5
# A service is added at or above YES, left out at or below NO, and between
# the two the keyword scan decides. Adding a service is cheap to undo (one
# block in compose.yaml), missing one is the first thing the first deploy
# trips over, so the band is symmetric rather than biased either way.
SERVICE_YES = 0.7
SERVICE_NO = 0.3

_RUNTIME_OTHER = "other"

QUESTIONS: dict[str, dict[str, Any]] = {
    "runtime": {
        "type": "choice",
        "instructions": {
            "question": (
                "Which runtime will this project's application server — the process "
                "that serves requests and would run in a container — be written in? "
                "Use `plan`, and `repository` when it is present."
            ),
            "focus": (
                "Decide by the server, not by every language mentioned. A web client, "
                "build tooling or scripts in another language do not decide it. A "
                "statement that a technology will not be used counts against it."
            ),
        },
        "criteria": {
            "node": "Node.js: a JavaScript or TypeScript server (Express, Next.js, "
            "NestJS, Fastify, Hono and similar).",
            "python": "Python: FastAPI, Django, Flask or another Python server.",
            "go": "Go: net/http, Gin, Fiber, Echo or another Go server.",
            _RUNTIME_OTHER: "Any other runtime (Rust, Java, PHP, Ruby, .NET, ...), no "
            "server at all, or the evidence does not say which.",
        },
    },
    "postgres": {
        "type": "noul",
        "instructions": (
            "Does the project need a PostgreSQL-compatible relational database that "
            "it runs alongside the application itself, per `plan`?"
        ),
        "criteria": {
            "true": "The application stores data in PostgreSQL, or in a relational / "
            "SQL database without a named vendor, that it hosts itself.",
            "false": "No database; only a non-relational store; a different named "
            "engine such as MySQL or MongoDB; a fully hosted database service it "
            "connects to (Supabase, Neon, RDS); or the plan rules a database out.",
        },
    },
    "redis": {
        "type": "noul",
        "instructions": (
            "Does the project need Redis, or a cache, job queue or message queue it "
            "runs alongside the application itself, per `plan`?"
        ),
        "criteria": {
            "true": "The plan uses Redis, or a cache / job queue / message queue / "
            "pub-sub that would run next to the application.",
            "false": "No cache or queue; a hosted broker it only connects to; or the "
            "plan explicitly rules one out.",
        },
    },
}


def judgment_state(
    plan_text: str | None, snapshot: RepoSnapshot | None = None
) -> dict[str, Any] | None:
    """The state the questions are asked about, or None when there is no
    evidence at all (the keyword scan's `DEFAULT_PROFILE` needs no model)."""
    plan = (plan_text or "").strip()
    if not plan and snapshot is None:
        return None
    state: dict[str, Any] = {"plan": plan[:_PLAN_CHARS]}
    if snapshot is not None:
        manifests = set(snapshot.stack.manifests)
        state["repository"] = {
            "root_manifests": snapshot.stack.manifests,
            "languages_by_file_count": snapshot.stack.languages,
            "manifest_contents": {
                e.path: e.content[:_MANIFEST_CHARS]
                for e in snapshot.excerpts
                if e.path in manifests
            },
        }
    return state


def fingerprint(state: dict[str, Any], plan_text: str | None) -> str:
    """Identity of what a judgment answers, for deciding whether a stored one
    still does. The full plan is hashed, not the capped copy in `state`: the
    keyword fallback reads all of it, so an edit past the cap must re-ask too.
    Questions are part of it: rewording one invalidates every judgment made
    under the old wording."""
    canonical = json.dumps(
        {"state": state, "plan": plan_text or "", "questions": QUESTIONS}, sort_keys=True
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _probability(value: Any) -> float:
    p = float(value)
    if not 0.0 <= p <= 1.0:  # also rejects NaN, which fails every comparison
        raise ValueError(f"probability out of range: {value!r}")
    return p


def unanswered(input_sha256: str) -> StackJudgment:
    """The pin for "asked, got nothing usable": `apply_judgment` falls back to
    the keyword scan on every dimension. Stored like a real judgment so a
    preview whose call failed and a later seed whose call succeeds still
    select the same files."""
    return StackJudgment(
        input_sha256=input_sha256, model="none", runtime=_RUNTIME_OTHER, runtime_confidence=0.0
    )


async def judge(
    client: TypeSafeClient, state: dict[str, Any], input_sha256: str
) -> StackJudgment | None:
    """Ask once. None on any failure — the caller falls back to keywords."""
    try:
        answers = await client.evaluate(state, QUESTIONS)
        runtime = answers["runtime"]
        return StackJudgment(
            input_sha256=input_sha256,
            model=getattr(client, "model", "unknown"),
            runtime=str(runtime["choice"]),
            runtime_confidence=_probability(runtime["confidence"]),
            services={name: _probability(answers[name]["noul"]) for name in SERVICES},
        )
    except (TypeSafeError, KeyError, TypeError, ValueError) as exc:
        logger.warning("stack judgment unavailable, using keywords: %s", exc)
        return None


def apply_judgment(
    judgment: StackJudgment | None,
    plan_text: str | None,
    detected_runtime: str | None = None,
) -> StackProfile:
    """The profile to seed: the judgment where it is decisive, the keyword
    scan (with an imported repository's manifests) everywhere else. Pure."""
    fallback = derive_stack_profile(plan_text, detected_runtime)
    if judgment is None:
        return fallback

    runtime = fallback.runtime
    if judgment.runtime in RUNTIMES and judgment.runtime_confidence >= RUNTIME_MIN_CONFIDENCE:
        runtime = judgment.runtime

    services = []
    for name in SERVICES:  # fixed order: compose.yaml is spliced in this order
        p = judgment.services.get(name)
        if p is None or SERVICE_NO < p < SERVICE_YES:
            wanted = name in fallback.services
        else:
            wanted = p >= SERVICE_YES
        if wanted:
            services.append(name)
    return StackProfile(runtime=runtime, services=tuple(services))
