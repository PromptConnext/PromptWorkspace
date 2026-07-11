"""Per-workspace daily token budget for chat (M9 cost control).

Same in-process, single-instance shape as `app/ratelimit.py`'s token bucket —
inherits that module's existing "needs Redis before horizontal scale" note
rather than introducing a second one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models.schemas import utcnow


@dataclass
class _DayUsage:
    day: str
    used: int = 0


@dataclass
class DailyTokenBudget:
    _usage: dict[str, _DayUsage] = field(default_factory=dict)

    def _today(self) -> str:
        return utcnow().strftime("%Y-%m-%d")

    def remaining(self, workspace_id: str, daily_budget: int) -> int:
        usage = self._usage.get(workspace_id)
        if usage is None or usage.day != self._today():
            return daily_budget
        return max(0, daily_budget - usage.used)

    def record(self, workspace_id: str, tokens: int) -> None:
        today = self._today()
        usage = self._usage.get(workspace_id)
        if usage is None or usage.day != today:
            usage = _DayUsage(day=today)
            self._usage[workspace_id] = usage
        usage.used += max(0, tokens)


def estimate_tokens(text: str) -> int:
    """Rough chars/4 heuristic — avoids a tokenizer dependency for a budget
    guard that only needs to be approximately right."""
    return max(1, len(text) // 4)
