"""Decision timeouts (enterprise AI v2.1 D1, View 1: unanswered means no).

One pass: every open decision expiring within the reminder window gets one
reminder to the people who can decide; every overdue one becomes `expired`,
its requester is told, and its project's receipts are brought up to date.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import NamedTuple

from app.config import Settings
from app.db.repository import Repository
from app.decision_email import DecisionMailer
from app.delivery import notices
from app.delivery.decisions import eligible_resolvers, is_overdue
from app.delivery.ledger import sync_decision_receipts
from app.models.schemas import Role


class SweepResult(NamedTuple):
    expired: int
    reminded: int


def sweep_decisions(
    repo: Repository, mailer: DecisionMailer, settings: Settings, now: datetime
) -> SweepResult:
    expired = reminded = 0
    touched: set[str] = set()
    for d in repo.list_due_decisions(now + timedelta(hours=settings.decision_reminder_hours)):
        project = repo.get_project(d.project_id)
        if project is None:
            continue
        members = repo.list_members(d.workspace_id)
        link = notices.decision_link(settings.web_app_url, d)
        if is_overdue(d, now):
            repo.save_decision(d.model_copy(update={"status": "expired", "resolved_at": now}))
            mailer.send(notices.recipients({d.requested_by}, members),
                        *notices.expired(d, project.name, link))
            expired += 1
            touched.add(d.project_id)
        elif d.reminded_at is None:
            repo.save_decision(d.model_copy(update={"reminded_at": now}))
            admins = {m.user_id for m in members if m.role == Role.admin}
            resolvers = eligible_resolvers(d, repo.list_project_roles(d.project_id),
                                           {m.user_id for m in members}, admins)
            mailer.send(notices.recipients(resolvers, members),
                        *notices.reminder(d, project.name, link))
            reminded += 1
    for project_id in touched:
        sync_decision_receipts(repo, project_id, repo.list_decisions(project_id))
    return SweepResult(expired, reminded)
