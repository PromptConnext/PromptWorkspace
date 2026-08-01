"""Built-in Policy Scope templates (C2, Policy Scope feature).

Six built-in compliance/regulatory templates a project can select as its
planning frame — Thai PDPA, general Thai law, GDPR, ISO 27001, SOC 2, and a
lighter internal-policy scaffold. Template bodies live in `templates/<id>.md`
next to this file — deliberately **not** `app/generation/templates/`, which
is contractually mirrored with the engine's own Spec Kit templates (see
app/generation/prompts.py:1-7). These are cloud-only planning inputs, not
Spec Kit stage templates, so there is no engine-side mirror to keep in sync.

Future org-owned custom templates (deferred, designed-for — see the Policy
Scope plan's "Future org templates" section) resolve through this same
module: built-in IDs are bare slugs (never containing ":"); namespaced
`ws:<uuid>` IDs will resolve against a `pz_workspace_policy_templates` table
instead. Nothing here needs to change shape when that lands.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.models.schemas import PolicyScope

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

_TRUNCATION_MARKER = "\n\n...[truncated]"


@dataclass(frozen=True)
class PolicyTemplate:
    id: str
    name: str
    description: str


BUILTIN_TEMPLATES: list[PolicyTemplate] = [
    PolicyTemplate(
        id="thai-pdpa",
        name="Thai PDPA",
        description=(
            "Thailand's Personal Data Protection Act — consent, cross-border "
            "transfer, and breach notification."
        ),
    ),
    PolicyTemplate(
        id="thai-law",
        name="Thai Law (General)",
        description=(
            "General Thai regulatory considerations beyond PDPA — electronic "
            "transactions, computer crime, consumer protection."
        ),
    ),
    PolicyTemplate(
        id="gdpr",
        name="GDPR",
        description=(
            "EU General Data Protection Regulation — lawful basis, data "
            "subject rights, and 72-hour breach notification."
        ),
    ),
    PolicyTemplate(
        id="iso-27001",
        name="ISO 27001",
        description=(
            "Information security management system controls, mapped to "
            "Annex A control families."
        ),
    ),
    PolicyTemplate(
        id="soc-2",
        name="SOC 2",
        description=(
            "Trust Services Criteria — security, availability, processing "
            "integrity, confidentiality, and privacy."
        ),
    ),
    PolicyTemplate(
        id="internal-policy",
        name="Internal Policy",
        description="A lightweight scaffold deferring to your own free-text policy scope.",
    ),
]

_BY_ID: dict[str, PolicyTemplate] = {t.id: t for t in BUILTIN_TEMPLATES}


def get_template(template_id: str) -> PolicyTemplate | None:
    return _BY_ID.get(template_id)


def template_body(template_id: str) -> str:
    """Same dir-relative loading pattern as app/generation/prompts.py:16."""
    return (_TEMPLATES_DIR / f"{template_id}.md").read_text(encoding="utf-8")


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = max(max_chars - len(_TRUNCATION_MARKER), 0)
    return text[:cut] + _TRUNCATION_MARKER


def render_policy_context(scope: PolicyScope | None, *, max_chars: int) -> str:
    """Full bodies of every selected template, in selection order, each
    under a `[policy_template:<id>]` label (mirrors the `[spec_documents:{id}]`
    convention in app/api/generation.py), followed by `[custom_policy]`.
    Truncated to `max_chars` with a visible `...[truncated]` marker. Returns
    "" for an empty/None scope."""
    if scope is None or (not scope.selected and not scope.custom_text.strip()):
        return ""

    parts: list[str] = []
    for template_id in scope.selected:
        if get_template(template_id) is None:
            continue
        parts.append(f"[policy_template:{template_id}]\n{template_body(template_id)}")
    if scope.custom_text.strip():
        parts.append(f"[custom_policy]\n{scope.custom_text.strip()}")

    return _truncate("\n\n".join(parts), max_chars)


def render_policy_summary(scope: PolicyScope | None, *, max_chars: int = 1_500) -> str:
    """Compact `## Policy Scope` block — template names + descriptions plus a
    preview of custom text — for stages that already have the full
    constitution available and don't need the whole template bodies
    repeated. Returns "" for an empty/None scope."""
    if scope is None or (not scope.selected and not scope.custom_text.strip()):
        return ""

    lines = ["## Policy Scope"]
    for template_id in scope.selected:
        template = get_template(template_id)
        if template is None:
            continue
        lines.append(f"- **{template.name}**: {template.description}")
    if scope.custom_text.strip():
        lines.append(f"- **Custom policy**: {scope.custom_text.strip()[:500]}")

    return _truncate("\n".join(lines), max_chars)


def render_policy_scope_doc(scope: PolicyScope) -> str:
    """Full, self-contained `docs/policy-scope.md` body for repo seeding —
    complete template bodies (not summaries), since this is the durable
    artifact the seeded repo carries forward. Caller (app/integrations/
    repo_seed.py) only invokes this when `scope` is non-empty."""
    lines = ["# Policy Scope", ""]
    if scope.selected:
        lines.append(
            "This project's constitution was generated under the following policy scope:"
        )
        lines.append("")
        for template_id in scope.selected:
            template = get_template(template_id)
            if template is None:
                continue
            lines.append(f"## {template.name}")
            lines.append("")
            lines.append(template_body(template_id))
            lines.append("")
    if scope.custom_text.strip():
        lines.append("## Custom Policy")
        lines.append("")
        lines.append(scope.custom_text.strip())
        lines.append("")
    return "\n".join(lines).strip() + "\n"
