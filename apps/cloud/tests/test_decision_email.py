"""Decision notifications (D1): who is emailed, and what an email may say."""

from __future__ import annotations

from app.config import Settings
from app.decision_email import NullDecisionMailer, SmtpDecisionMailer, build_decision_mailer
from app.delivery import notices
from app.models.schemas import Decision, Role, WorkspaceMember


def _decision(**o):
    return Decision(project_id="p1", workspace_id="w1", kind="plan_approval",
                    title="Approve the delivery plan", subject_stage="tasks",
                    subject_hash="h", subject_content="Patient: Somchai 081-234-5678",
                    routed_hat="tech_steward", requested_by="bob", **o)


def test_the_link_opens_the_decisions_tab():
    assert notices.decision_link("https://w.example/", _decision()) == \
        "https://w.example/w/w1/p/p1?tab=decisions"


def test_recipients_are_the_members_emails_in_order_skipping_unknown():
    members = [WorkspaceMember(workspace_id="w1", user_id="a", email="a@x.com", role=Role.admin),
               WorkspaceMember(workspace_id="w1", user_id="b", email=None)]
    assert notices.recipients({"b", "a", "zz"}, members) == ["a@x.com"]


def test_a_request_email_names_the_decision_and_project_but_not_the_document():
    subject, text = notices.requested(_decision(), "Clinic booking", "https://l")
    assert subject == "[PromptWorkspace] Approve the delivery plan — Clinic booking"
    assert "https://l" in text and "tech steward" in text
    assert "Somchai" not in subject + text


def test_without_smtp_settings_nothing_is_sent():
    mailer = build_decision_mailer(Settings(smtp_host="", smtp_from=""))
    assert isinstance(mailer, NullDecisionMailer)
    assert mailer.send(["a@x.com"], "s", "t") is False


def test_with_smtp_settings_the_smtp_mailer_is_used():
    s = Settings(smtp_host="smtp-relay.brevo.com", smtp_from="PromptWorkspace <no-reply@x.com>")
    assert isinstance(build_decision_mailer(s), SmtpDecisionMailer)


def test_an_smtp_failure_is_reported_not_raised(monkeypatch):
    import smtplib

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(smtplib, "SMTP", boom)
    s = Settings(smtp_host="h", smtp_from="f@x.com")
    assert SmtpDecisionMailer(s).send(["a@x.com"], "s", "t") is False


def test_starttls_verifies_the_relay_certificate(monkeypatch):
    import smtplib
    import ssl

    seen = {}

    class FakeSMTP:
        def __init__(self, *a, **k): ...
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def starttls(self, context=None): seen["context"] = context
        def login(self, *a): ...
        def send_message(self, msg): ...

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    s = Settings(smtp_host="h", smtp_from="f@x.com")
    assert SmtpDecisionMailer(s).send(["a@x.com"], "s", "t") is True
    assert seen["context"].verify_mode == ssl.CERT_REQUIRED
    assert seen["context"].check_hostname is True
