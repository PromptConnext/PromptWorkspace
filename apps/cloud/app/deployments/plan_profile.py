"""Reading a stack profile out of a project's technical plan (ADR 0026).

One deployment template — `docker-compose` — ships more than one hand-written
scaffold and picks between them. This module is the picker, and everything it
does is a keyword count over the `plan` stage document: which runtime the plan
describes, and which backing services it names.

Two properties matter more than accuracy here, and they are why this is a
scanner rather than a model call.

**It is deterministic.** `template_files()` sorts its output so two projects
with the same selection seed the same tree, which is what makes a seeded
pipeline reviewable and a template bug reproducible (ADR 0021, and ADR 0024
decision 3 named losing it as the cost of generation). A pure function of the
plan text keeps that property: the same plan seeds the same commit, every
time.

**It selects, it does not author.** ADR 0024 decision 1 draws the boundary at
the application root — a model may write files the workflow *builds*, never
the files that *deploy*, because `create_repository` writes the Actions
secrets before it commits the scaffold, and the plan is free text a business
user wrote in the Planner. A scanner choosing among hand-written files cannot
cross that boundary: its worst failure is seeding the Python placeholder for a
Go project, which the first implementation task replaces anyway.

So this is deliberately dumb, in the same spirit as
`repo_seed.py::_conventions_section`: a best-effort read, not a parse. When
the plan says nothing recognisable, `DEFAULT_PROFILE` applies.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Runtimes, in tie-break order: an equal score picks the earlier entry. Each
# maps to a `runtimes/<name>/` directory in the template's scaffold, so adding
# one here without adding the directory seeds nothing.
_RUNTIME_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("node", ("node.js", "nodejs", "node", "express", "typescript", "javascript", "next.js")),
    ("python", ("python", "fastapi", "django", "flask", "uvicorn", "gunicorn", "pydantic")),
    # Bare "go" is deliberately absent: it is a common English word, and a
    # plan that says "users go to the dashboard" twice would otherwise
    # outscore one mention of the stack the project is actually built in.
    ("go", ("golang", "go service", "go module", "goroutine", "gin", "fiber", "net/http")),
)

# Backing services, in the order they are appended to `compose.yaml`. Each maps
# to a `services/<name>.yaml` fragment in the template's scaffold.
_SERVICE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("postgres", ("postgres", "postgresql", "psql", "relational database")),
    ("redis", ("redis", "cache layer", "job queue", "message queue")),
)


@dataclass(frozen=True)
class StackProfile:
    """What the plan says this project is, in the only two dimensions the
    container template varies along."""

    runtime: str
    services: tuple[str, ...] = ()


DEFAULT_PROFILE = StackProfile(runtime="node")


def _score(text: str, keywords: tuple[str, ...]) -> int:
    # Word-bounded so `go` does not match "going" and `node` does not match
    # "node_modules" in a path the plan happens to quote. `re.escape` because
    # several keywords carry a dot or a slash.
    return sum(len(re.findall(rf"\b{re.escape(kw)}\b", text)) for kw in keywords)


def derive_stack_profile(plan_text: str | None) -> StackProfile:
    """The stack profile a plan describes, or `DEFAULT_PROFILE` for a project
    whose plan is missing, empty or unrecognisable.

    Never raises and never returns a runtime the template has no scaffold for:
    repository creation must not fail on a partially-planned project, which is
    the same contract `build_seed_files` already keeps.
    """
    text = (plan_text or "").lower()
    if not text.strip():
        return DEFAULT_PROFILE

    best_runtime = DEFAULT_PROFILE.runtime
    best_score = 0
    for runtime, keywords in _RUNTIME_KEYWORDS:
        score = _score(text, keywords)
        if score > best_score:
            best_runtime, best_score = runtime, score

    services = tuple(
        name for name, keywords in _SERVICE_KEYWORDS if _score(text, keywords) > 0
    )
    return StackProfile(runtime=best_runtime, services=services)
