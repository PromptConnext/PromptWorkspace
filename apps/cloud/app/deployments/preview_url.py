"""Where a template's preview is expected to answer (ADR 0023's 2026-09-06
amendment).

Two callers need the same answer, at different times and for different
reasons, and they must never disagree:

  `sync.create_repository` needs it *before* the repository exists, to hand
  the workflow the URL it will report and to record the project's initial
  deployment state.

  `github._trusted_environment_url` needs it when a `deployment_status`
  arrives, to decide whether the URL the workflow reported is the preview we
  provisioned. A workflow is editable by anyone with push access, so without
  that pin a repo pusher chooses what the workspace's Preview tab embeds.

Before this module the expected value was computed by calling
`platform_r2_preview_url` directly, which is the shape of exactly one
template. Every other `url_kind="platform"` template was then silently pinned
against an R2 prefix it could never match, and its reported URL was discarded.
`DeploymentTemplate.platform_url_source` names the source instead, and this
module is the one place that reads it — a declarative table, like VarSpec's
`source`, rather than a branch per template.
"""

from __future__ import annotations

from urllib.parse import urlparse

from app.deployments.registry import DeploymentTemplate
from app.integrations.deploy_providers import platform_r2_preview_url

# Sources whose value only exists once the repository does. `create_repository`
# resolves the URL twice for these — once as None before the repo is created,
# once for real afterwards — rather than failing its "a platform URL must be
# computable" guard on a template that was never going to have one yet.
_REPO_DERIVED = frozenset({"github_pages"})


def repo_full_name_from_url(repo_url: str | None) -> str | None:
    """`https://github.com/acme/widget` -> `acme/widget`.

    Derived rather than stored: `repo_url` is what repo creation persisted,
    and a second column that could disagree with it would be one more thing to
    keep in sync for no gain.

    Split on the URL's *path* rather than on the whole string: splitting the
    string treats `https:` and the host as segments, so a URL with no path at
    all (`https://github.com`) yields `https:/github.com` instead of nothing —
    which as a Pages prefix would be a nonsense host we then pin against.
    """
    if not repo_url:
        return None
    parts = [p for p in urlparse(repo_url).path.split("/") if p]
    if len(parts) < 2:
        return None
    return f"{parts[-2]}/{parts[-1]}"


def resolves_before_repo(template: DeploymentTemplate) -> bool:
    """False when this template's URL cannot be known until its repository
    exists, so repo creation must not treat an absent one as a failure."""
    return template.platform_url_source.split(":", 1)[0] not in _REPO_DERIVED


def platform_preview_url(
    template: DeploymentTemplate,
    *,
    project,
    settings,
    repo_full_name: str | None = None,
) -> str | None:
    """The URL this template's preview is expected to answer on, or None.

    None means "no expectation", and the two callers read that differently on
    purpose: repo creation refuses to provision a `url_kind="platform"`
    template with no URL, while the webhook path treats the absence as "take
    the reported URL as given", which is exactly what a provider-minted URL
    (Vercel) needs.
    """
    source = template.platform_url_source
    if not source:
        return None

    kind, _, argument = source.partition(":")

    if kind == "platform_r2":
        return platform_r2_preview_url(settings, project.id, template.health_path)

    if kind == "project_value":
        # Named by a human on the project's deployment template (ADR 0025/0026)
        # — the address of a server the customer administers is not
        # discoverable from either side.
        config = getattr(project, "deployment_config", None)
        value = ((config.provider_values if config else None) or {}).get(argument, "").strip()
        return value or None

    if kind == "github_pages":
        full_name = repo_full_name or repo_full_name_from_url(getattr(project, "repo_url", None))
        if not full_name:
            return None
        owner, _, repo = full_name.partition("/")
        if not owner or not repo:
            return None
        # Project pages, always: every repository this platform creates is a
        # project repository, never an `<owner>.github.io` user site. The
        # owner is lower-cased because that is how GitHub reports `page_url`,
        # and a case difference here would reject a perfectly good report.
        return f"https://{owner.lower()}.github.io/{repo}/"

    return None
