"""Built-in Deployment Templates (ADR 0021).

A Deployment Template is the answer to "how does this project get built,
deployed, and seen". It seeds a runnable application scaffold, a GitHub
Actions workflow, an env/secret contract and a `docs/deployment.md` into the
project repository at the `tech_review -> repo_created` transition
(app/api/sync.py::create_repository), so the preview URL is live from the
first commit rather than after the first implementation task.

Template files live in `templates/<id>/` next to this module — deliberately
**not** `app/generation/templates/`, which is contractually mirrored with the
engine's own Spec Kit templates (app/generation/prompts.py:1-7), and not
`app/policies/templates/`, whose bodies are markdown fed to a model. These
are executable scaffolds committed verbatim into a customer repository, which
is a third thing again.

Future org-owned custom templates (deferred, designed-for) resolve through
this same module, exactly as app/policies/registry.py describes for policy
templates: built-in IDs are bare slugs that never contain ":", and namespaced
`ws:<uuid>` IDs will resolve against a `pz_workspace_deployment_templates`
table instead. Nothing here needs to change shape when that lands, and
`GET /deployment-templates` already accepts the `workspace_id` it will need.

What a new template may be, and what it may not:

  Adding one is (1) a directory here, (2) one BUILTIN_TEMPLATES entry, and
  (3) optionally one DeployProvider entry in app/integrations/
  deploy_providers.py. It must not change the SeedFile shape, the webhook
  contract (environment "preview", environment_url set, one GitHub Deployment
  per run), the pz_deployments row shape, DeploymentConfig/DeploymentState, or
  the lifecycle state machine — and it cannot introduce a new inbound
  callback, a cloud-side build step, a per-template route or a per-template
  database column. A template that needs one of those is an ADR, not a
  template.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

# Repo-relative path every template's workflow is seeded to. Fixed rather than
# per-template so the inbound workflow_run handler can tell "our pipeline" from
# a workflow the repo's own developers added later.
WORKFLOW_PATH = ".github/workflows/deploy.yml"

# The single environment this feature deploys to. The webhook handlers filter
# on it, so a repo that grows its own staging/production workflows does not
# start reporting them as the business user's preview.
PREVIEW_ENVIRONMENT = "preview"

# How the platform PRESENTS a build. The one new dispatch key ADR 0023 adds,
# and deliberately not `stack`: `stack` stays a display string so a template
# can never grow a per-stack special case in the cloud.
#
#   embedded_url      a web page the platform frames
#   external_url      a web page that refuses framing, opened in its own tab
#   api_console       an HTTP API; the build publishes an OpenAPI document
#   artifact_download a file a person installs (installer, APK, .app archive)
#   store_build       reaches its audience through TestFlight / a Play track
DELIVERY_KINDS = frozenset(
    {"embedded_url", "external_url", "api_console", "artifact_download", "store_build"}
)


@dataclass(frozen=True)
class SecretSpec:
    """One GitHub Actions *secret* the seeded workflow needs.

    `from_provider` names the key to read out of the resolved provider
    credential; "" means the platform supplies the value itself (the
    platform-owned R2 template). This is the seam that keeps templates and
    providers independent: the template declares the name its workflow reads,
    the provider decides what goes in it.
    """

    name: str
    label: str
    from_provider: str = ""


@dataclass(frozen=True)
class VarSpec:
    """One GitHub Actions *variable* — plaintext, visible in repo settings.

    Variables exist here for a specific reason: `PZ_WEB_ORIGIN` feeds the
    seeded frame-ancestors config, and if the web app ever changes origin,
    every project's preview would break. As a variable it is repairable with
    one API call and no commit; as a baked-in file it would need a commit to
    every repository ever created.
    """

    name: str
    label: str
    # project_id | template_id | environment | web_origin | preview_url |
    # provider:<key> | literal:<value>
    source: str


@dataclass(frozen=True)
class DeploymentTemplate:
    id: str
    name: str
    description: str
    # Display only — the picker groups by it. Not a dispatch key; nothing
    # branches on `stack`, which is what keeps templates from growing
    # per-stack special cases in the cloud.
    stack: str
    provider: str
    # Key into Workspace.integration_config for this provider's credential.
    # None = platform-owned (the cloud is the provider, and mints a scoped
    # credential per workspace rather than sealing its own into a repo).
    provider_credential_kind: str | None
    scaffold_dir: str
    # ADR 0023. Defaults to embedded_url so every template written before this
    # field existed keeps exactly its previous presentation. Declared here
    # rather than beside `stack` only because a defaulted field cannot precede
    # the non-defaulted ones above it.
    delivery_kind: str = "embedded_url"
    required_secrets: tuple[SecretSpec, ...] = ()
    required_vars: tuple[VarSpec, ...] = ()
    # Design-time claim, narrowed later by the server-side header probe. True
    # means "we control this stack's response headers and set frame-ancestors
    # to allow the web app", or "this host sends no framing header at all".
    embeddable: bool = True
    health_path: str = "/"
    # "provider" = the provider mints the URL and it arrives with the
    # deployment_status delivery. "platform" = the cloud computes it up front
    # and hands it to the workflow as a variable, so both sides agree.
    url_kind: str = "provider"
    workflow_path: str = WORKFLOW_PATH
    docs_path: str = "docs/deployment.md"
    # Extra per-template context for docs rendering. Never used for dispatch.
    notes: tuple[str, ...] = field(default_factory=tuple)


BUILTIN_TEMPLATES: list[DeploymentTemplate] = [
    DeploymentTemplate(
        id="static-r2",
        name="Static site → PromptZone hosting",
        description=(
            "A plain HTML/CSS/JS site published to PromptZone-managed storage. "
            "No third-party account to create — the fastest way to get a live "
            "preview a business user can open."
        ),
        stack="static",
        provider="platform-r2",
        provider_credential_kind=None,
        scaffold_dir="static-r2",
        required_secrets=(
            SecretSpec("PZ_R2_ACCESS_KEY_ID", "Storage access key id"),
            SecretSpec("PZ_R2_SECRET_ACCESS_KEY", "Storage secret access key"),
        ),
        required_vars=(
            VarSpec("PZ_R2_BUCKET", "Preview bucket", "provider:bucket"),
            VarSpec("PZ_R2_ENDPOINT", "Storage S3 endpoint", "provider:endpoint"),
            VarSpec("PZ_PREVIEW_URL", "Public preview URL", "preview_url"),
            VarSpec("PZ_PROJECT_ID", "PromptZone project id", "project_id"),
            VarSpec("PZ_ENVIRONMENT", "Deployment environment", "environment"),
        ),
        # Public bucket URLs send neither X-Frame-Options nor a CSP, so they
        # frame by default. Worth stating plainly rather than implying we set
        # a permissive header here: for this template we *cannot* set
        # frame-ancestors — the host serves no custom headers — and "no
        # restriction" is the reason embedding works. That is also why this
        # template declares no PZ_WEB_ORIGIN: nothing here could read it.
        embeddable=True,
        health_path="/index.html",
        url_kind="platform",
        notes=(
            "Preview storage is managed by PromptZone; there is no account to "
            "create and no bill to pay for it.",
            "Public preview URLs are rate-limited and intended for review, not "
            "production traffic.",
        ),
    ),
]

_BY_ID: dict[str, DeploymentTemplate] = {t.id: t for t in BUILTIN_TEMPLATES}


def get_template(template_id: str) -> DeploymentTemplate | None:
    return _BY_ID.get(template_id)


def template_files(template_id: str) -> list[tuple[str, str, bool]]:
    """Every file in a template's scaffold, as (repo path, content,
    executable), sorted for a deterministic commit.

    Paths are resolved and re-checked against the template root before being
    read. A scaffold is committed verbatim into a customer's repository, so a
    `..` escaping the template directory would be a file-disclosure bug, not
    a cosmetic one — and this stays correct even if template directories
    later come from somewhere less trusted than the package itself.
    """
    template = get_template(template_id)
    if template is None:
        return []
    root = (_TEMPLATES_DIR / template.scaffold_dir).resolve()
    if not root.is_dir():
        return []

    files: list[tuple[str, str, bool]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            continue
        rel = resolved.relative_to(root)
        # Stored as `<name>.tmpl` so the scaffold's own dotfiles and workflow
        # files never take effect inside *this* repository — a
        # .github/workflows/deploy.yml sitting in the package would otherwise
        # be a live workflow here.
        parts = list(rel.parts)
        parts[-1] = parts[-1][: -len(".tmpl")] if parts[-1].endswith(".tmpl") else parts[-1]
        repo_path = "/".join(parts)
        files.append(
            (repo_path, resolved.read_text(encoding="utf-8"), resolved.stat().st_mode & 0o100 != 0)
        )
    return files


def render_deployment_doc(
    template: DeploymentTemplate,
    *,
    project_name: str,
    preview_url: str | None,
) -> str:
    """`docs/deployment.md` — the durable, self-contained explanation of how
    this repository ships, committed alongside the pipeline it describes.

    Deliberately not added to the three files the VS Code extension reads as
    coding rules (apps/vscode/src/context/repoDocs.ts): this is operational
    documentation, and widening that list would change what every developer's
    AI assistant reads.
    """
    lines = [
        f"# Deployment — {project_name}",
        "",
        f"**Template:** {template.name} (`{template.id}`)  ",
        f"**Provider:** {template.provider}  ",
        f"**Environment:** `{PREVIEW_ENVIRONMENT}`",
        "",
        "## How this repository ships",
        "",
        "Every push to the default branch runs "
        f"`{template.workflow_path}`, which builds this project and publishes "
        "it, then records the result as a GitHub Deployment. PromptZone reads "
        "that deployment over the repository's webhook and shows the live "
        "application in the project's Preview tab, so business stakeholders "
        "can review real progress without a development environment.",
        "",
        "PromptZone does not build or host anything itself — this repository's "
        "own CI does the work, using credentials stored as repository secrets. "
        "The workflow is an ordinary file: edit it freely.",
        "",
    ]
    if preview_url:
        lines += ["## Live preview", "", f"<{preview_url}>", ""]

    if template.required_secrets:
        lines += [
            "## Repository secrets",
            "",
            "Written by PromptZone at repository creation. Rotate them by "
            "reconnecting the provider in workspace settings and re-provisioning "
            "— editing them here will be overwritten.",
            "",
        ]
        lines += [f"- `{s.name}` — {s.label}" for s in template.required_secrets]
        lines.append("")

    if template.required_vars:
        lines += ["## Repository variables", ""]
        lines += [f"- `{v.name}` — {v.label}" for v in template.required_vars]
        lines.append("")

    if template.notes:
        lines += ["## Notes", ""]
        lines += [f"- {note}" for note in template.notes]
        lines.append("")

    lines += [
        "## Anyone who can push here can use these credentials",
        "",
        "A repository secret is readable by any workflow someone with write "
        "access can author. That is inherent to running deployments from this "
        "repository, so the credentials above are scoped as narrowly as the "
        "provider allows, and pull-request checks run without access to them. "
        "Treat push access to this repository as equivalent to access to its "
        "preview environment.",
        "",
    ]
    return "\n".join(lines).strip() + "\n"
