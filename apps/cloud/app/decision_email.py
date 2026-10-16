"""Best-effort decision notification email over SMTP (enterprise AI v2.1 D1).

Sending never blocks or fails a decision: the Decision Inbox is the source of
truth. One message per recipient, so recipients do not see each other.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import Protocol

from app.config import Settings

logger = logging.getLogger("promptworkspace")


class DecisionMailer(Protocol):
    def send(self, to: list[str], subject: str, text: str) -> bool: ...


class NullDecisionMailer:
    """Sends nothing (SMTP not configured / tests)."""

    def send(self, to: list[str], subject: str, text: str) -> bool:  # noqa: D102
        return False


class RecordingDecisionMailer:
    """Keeps what would be sent. Tests install it on `app.state.decision_mailer`."""

    def __init__(self) -> None:
        self.sent: list[tuple[list[str], str, str]] = []

    def send(self, to: list[str], subject: str, text: str) -> bool:  # noqa: D102
        if not to:
            return False
        self.sent.append((list(to), subject, text))
        return True


class SmtpDecisionMailer:
    def __init__(self, settings: Settings) -> None:
        self._s = settings

    def send(self, to: list[str], subject: str, text: str) -> bool:
        if not to:
            return False
        try:
            with smtplib.SMTP(self._s.smtp_host, self._s.smtp_port, timeout=10) as smtp:
                smtp.starttls()
                if self._s.smtp_user:
                    smtp.login(self._s.smtp_user, self._s.smtp_password)
                for address in to:
                    msg = EmailMessage()
                    msg["From"] = self._s.smtp_from
                    msg["To"] = address
                    msg["Subject"] = subject
                    msg.set_content(text)
                    smtp.send_message(msg)
            return True
        except Exception as exc:  # noqa: BLE001 - email must never break a decision
            logger.warning("decision email not sent (%s recipients): %s", len(to), exc)
            return False


def build_decision_mailer(settings: Settings) -> DecisionMailer:
    if settings.smtp_host and settings.smtp_from:
        return SmtpDecisionMailer(settings)
    return NullDecisionMailer()
