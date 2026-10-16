"""Decision timeouts (enterprise AI v2.1 D1, View 1: unanswered means no).

One pass: every open decision expiring within the reminder window gets one
reminder to the people who can decide; every overdue one becomes `expired`,
its requester is told, and its project's receipts are brought up to date.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import NamedTuple

from app.config import Settings
from app.db.repository import Repository
from app.decision_email import DecisionMailer
from app.delivery import notices
from app.delivery.decisions import eligible_resolvers, is_overdue
from app.delivery.ledger import sync_decision_receipts
from app.models.schemas import Role

logger = logging.getLogger(__name__)


class SweepResult(NamedTuple):
    expired: int
    reminded: int


def sweep_decisions(
    repo: Repository, mailer: DecisionMailer, settings: Settings, now: datetime
) -> SweepResult:
    expired = reminded = 0
    touched: set[str] = set()
    try:
        due = repo.list_due_decisions(now + timedelta(hours=settings.decision_reminder_hours))
        for d in due:
            try:
                project = repo.get_project(d.project_id)
                if project is None:
                    continue
                members = repo.list_members(d.workspace_id)
                link = notices.decision_link(settings.web_app_url, d)
                if is_overdue(d, now):
                    # Compare-and-set: a decision resolved since the read stays resolved.
                    if repo.update_open_decision(
                        d.project_id, d.id, {"status": "expired", "resolved_at": now}
                    ) is None:
                        continue
                    touched.add(d.project_id)
                    expired += 1
                    mailer.send(notices.recipients({d.requested_by}, members),
                                *notices.expired(d, project.name, link))
                elif d.reminded_at is None:
                    if repo.update_open_decision(
                        d.project_id, d.id, {"reminded_at": now}
                    ) is None:
                        continue
                    reminded += 1
                    admins = {m.user_id for m in members if m.role == Role.admin}
                    resolvers = eligible_resolvers(
                        d, repo.list_project_roles(d.project_id),
                        {m.user_id for m in members}, admins)
                    mailer.send(notices.recipients(resolvers, members),
                                *notices.reminder(d, project.name, link))
            except Exception:  # noqa: BLE001 - one decision must not stop the pass
                logger.exception("decision sweep failed for decision=%s", d.id)
    finally:
        for project_id in touched:
            try:
                sync_decision_receipts(repo, project_id, repo.list_decisions(project_id))
            except Exception:  # noqa: BLE001
                logger.exception("decision sweep receipt sync failed for project=%s", project_id)
    return SweepResult(expired, reminded)
