"""What decision emails say (enterprise AI v2.1 D1). Pure. An email names the
decision, the project and where to answer it; it never carries the document,
which may hold personal data."""

from __future__ import annotations

from app.models.schemas import Decision, ProjectRole, WorkspaceMember

HAT_LABEL = {"business_owner": "business owner", "tech_steward": "tech steward"}
KIND_LABEL = {"intent_approval": "intent", "plan_approval": "delivery plan"}
_PREFIX = "[PromptWorkspace]"


def _line(text: str) -> str:
    """One header-safe line: CR/LF in a name would make EmailMessage refuse
    every subject."""
    return text.replace("\r", " ").replace("\n", " ")


def line_who(
    decision: Decision,
    resolvers: set[str],
    roles: list[ProjectRole],
    members: list[WorkspaceMember],
) -> tuple[bool, str | None]:
    """Whether a LINE notice goes out for `decision`, and whom it names.
    `resolvers` is `eligible_resolvers`: nobody means nobody can act (no
    message); the routed hat's holder means their email (no message if they
    have none); anyone else is the admin pool (any-admin wording, name None)."""
    if not resolvers:
        return False, None
    holder = next((r.user_id for r in roles if r.hat == decision.routed_hat), None)
    if holder in resolvers:
        email = next((m.email for m in members if m.user_id == holder and m.email), None)
        return email is not None, email
    return True, None


def decision_link(web_app_url: str, decision: Decision) -> str:
    base = web_app_url.rstrip("/")
    return f"{base}/w/{decision.workspace_id}/p/{decision.project_id}?tab=decisions"


def recipients(user_ids: set[str], members: list[WorkspaceMember]) -> list[str]:
    return [m.email for m in members if m.user_id in user_ids and m.email]


def requested(decision: Decision, project_name: str, link: str) -> tuple[str, str]:
    project_name = _line(project_name)
    decision = decision.model_copy(update={"title": _line(decision.title)})
    return (
        f"{_PREFIX} {decision.title} — {project_name}",
        f"A decision in {project_name} is waiting for you as "
        f"{HAT_LABEL[decision.routed_hat]}: {decision.title}.\n\n"
        f"Read the document and decide: {link}\n\n"
        "Unanswered decisions expire, and an expired decision counts as no.\n",
    )


def assigned(decisions: list[Decision], project_name: str, link: str, hat: str) -> tuple[str, str]:
    project_name = _line(project_name)
    titles = "\n".join(f"- {_line(d.title)}" for d in decisions)
    return (
        f"{_PREFIX} You are now {HAT_LABEL[hat]} — {project_name}",
        f"You were made {HAT_LABEL[hat]} of {project_name}. "
        f"These decisions are waiting for you:\n\n{titles}\n\nDecide here: {link}\n",
    )


def reminder(decision: Decision, project_name: str, link: str) -> tuple[str, str]:
    project_name = _line(project_name)
    decision = decision.model_copy(update={"title": _line(decision.title)})
    return (
        f"{_PREFIX} Reminder: {decision.title} — {project_name}",
        f"This decision in {project_name} expires soon: {decision.title}.\n\n"
        f"Decide here: {link}\n",
    )


def expired(decision: Decision, project_name: str, link: str) -> tuple[str, str]:
    project_name = _line(project_name)
    decision = decision.model_copy(update={"title": _line(decision.title)})
    return (
        f"{_PREFIX} Expired: {decision.title} — {project_name}",
        f"Nobody answered your request in {project_name} in time: {decision.title}. "
        f"It counts as not approved. Ask again when ready: {link}\n",
    )


def changes_requested(decision: Decision, project_name: str, link: str) -> tuple[str, str]:
    project_name = _line(project_name)
    label = KIND_LABEL.get(decision.kind, "decision")
    return (
        f"{_PREFIX} Changes requested: {label} for {project_name}",
        f"Changes were requested on the {label} in {project_name}.\n\n"
        f"Reason: {decision.rationale or 'No reason was given.'}\n\n"
        f"Review the decision and ask again when ready: {link}\n",
    )
