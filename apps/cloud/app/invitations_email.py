"""Best-effort invitation email via Supabase Admin (uses its configured SMTP).

Sending never blocks or fails an invitation: the invite row is the source of
truth and always has a shareable accept link. `send` returns True only when an
email actually went out, so the caller can tell the admin to share the link
manually otherwise (notably for an email that already has a Supabase account —
`invite_user_by_email` refuses those, which we treat as "not sent").
"""

from __future__ import annotations

import logging
from typing import Protocol

from app.config import Settings

logger = logging.getLogger("promptconnext")


class InvitationMailer(Protocol):
    def send(self, email: str, token: str) -> bool: ...


class NullInvitationMailer:
    """Sends nothing (Supabase not configured / tests). Always 'not sent'."""

    def send(self, email: str, token: str) -> bool:  # noqa: D102
        return False


class SupabaseInvitationMailer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        from supabase import create_client  # lazy import

        # Service-role key: admin auth calls require it.
        self._client = create_client(settings.supabase_url, settings.supabase_key)

    def send(self, email: str, token: str) -> bool:
        redirect_to = f"{self._settings.web_app_url.rstrip('/')}/invite/{token}"
        try:
            self._client.auth.admin.invite_user_by_email(
                email, {"redirect_to": redirect_to}
            )
            return True
        except Exception as exc:  # noqa: BLE001 - email must never break invites
            # Existing-user (already registered) and transient SMTP errors both
            # land here; the invite is still valid via its link.
            logger.info("invitation email not sent to %s: %s", email, exc)
            return False


def build_invitation_mailer(settings: Settings) -> InvitationMailer:
    if settings.data_backend == "supabase" and settings.supabase_url and settings.supabase_key:
        return SupabaseInvitationMailer(settings)
    return NullInvitationMailer()
