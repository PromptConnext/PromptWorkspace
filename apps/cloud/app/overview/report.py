"""Governance report aggregation (plan 0033, task 10). Pure: lists in, models out."""

from __future__ import annotations

from datetime import datetime, timezone
from statistics import median

from app.delivery.receipts import verify_chain
from app.generation.managed import MANAGED_PROVIDER
from app.models.schemas import (
    Decision,
    DisciplineOut,
    GenerationRun,
    Receipt,
    UsageSourceOut,
    UsageStageOut,
)
from app.overview.checks import decision_counts


def _tokens(run: GenerationRun) -> int:
    return run.prompt_tokens + run.completion_tokens


def build_usage(
    runs: list[GenerationRun],
    now: datetime,
    *,
    managed_budget: int | None,
    byo_budget: int | None,
    byo_provider: str | None,
) -> list[UsageSourceOut]:
    """One entry per source that has runs; a source with none is absent."""
    today = now.astimezone(timezone.utc).date()
    out: list[UsageSourceOut] = []
    for source, budget, provider in (
        ("managed", managed_budget, MANAGED_PROVIDER),
        ("byo", byo_budget, byo_provider),
    ):
        mine = [r for r in runs if r.model_source == source]
        if not mine:
            continue
        stages: dict[str, dict] = {}
        for r in mine:
            s = stages.setdefault(r.stage, {"runs": 0, "tokens": 0, "models": []})
            s["runs"] += 1
            if r.model not in s["models"]:
                s["models"].append(r.model)
            s["tokens"] += _tokens(r)
        out.append(
            UsageSourceOut(
                source=source,  # type: ignore[arg-type]
                provider=provider,
                runs=len(mine),
                tokens=sum(_tokens(r) for r in mine),
                today_tokens=sum(
                    _tokens(r)
                    for r in mine
                    if r.created_at.astimezone(timezone.utc).date() == today
                ),
                daily_budget=budget,
                by_stage=[
                    UsageStageOut(
                        stage=k,
                        runs=v["runs"],
                        model=", ".join(v["models"]),
                        tokens=v["tokens"],
                    )
                    for k, v in sorted(stages.items())
                ],
            )
        )
    return out


def build_discipline(
    decisions: list[Decision], chains: list[list[Receipt]], now: datetime
) -> DisciplineOut:
    hours = [
        (d.resolved_at - d.created_at).total_seconds() / 3600
        for d in decisions
        if d.status in ("approved", "rejected") and d.resolved_at and d.created_at
    ]
    counts = decision_counts(decisions, now)
    non_empty = [c for c in chains if c]
    return DisciplineOut(
        resolved=sum(1 for d in decisions if d.status in ("approved", "rejected")),
        open=counts["open"],
        expired_30d=counts["expired_30d"],
        median_hours_to_decide=round(median(hours), 2) if hours else None,
        chains_verified=sum(1 for c in non_empty if verify_chain(c).ok),
        chains_total=len(non_empty),
    )
