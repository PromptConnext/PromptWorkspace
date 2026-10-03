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

A template's scaffold directory has one of two layouts, and the second is a
convention rather than a per-template branch (ADR 0026):

  Flat. Every file under `templates/<id>/` is seeded verbatim. This is what
  `static-r2` and `next-vercel` use, and it is the layout to reach for.

  Composed. A `base/` subdirectory means the scaffold varies with the
  project's technical plan. `base/` is always seeded; `runtimes/<name>/`
  holds mutually exclusive variants of which exactly one is seeded, chosen by
  `plan_profile.derive_stack_profile`; `services/<name>.yaml` holds fragments
  appended in place of the `# pz:services` marker line in whichever seeded
  file carries it. Selection only — nothing here rewrites a file's content,
  and every candidate is hand-written in this repository, which is what keeps
  the plan (free text a business user wrote) from authoring a pipeline. See
  ADR 0024 decision 1 for why that boundary is where it is.

Future org-owned custom templates (deferred, designed-for) resolve through
this same module, exactly as app/policies/registry.py describes for policy
templates: built-in IDs are bare slugs that never contain ":", and namespaced
`ws:<uuid>` IDs will resolve against a `pw_workspace_deployment_templates`
table instead. Nothing here needs to change shape when that lands, and
`GET /deployment-templates` already accepts the `workspace_id` it will need.

What a new template may be, and what it may not:

  Adding one is (1) a directory here, (2) one BUILTIN_TEMPLATES entry, and
  (3) optionally one DeployProvider entry in app/integrations/
  deploy_providers.py. It must not change the SeedFile shape, the webhook
  contract (environment "preview", environment_url set, one GitHub Deployment
  per run), the pw_deployments row shape, DeploymentConfig/DeploymentState, or
  the lifecycle state machine — and it cannot introduce a new inbound
  callback, a cloud-side build step, a per-template route or a per-template
  database column. A template that needs one of those is an ADR, not a
  template.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from app.deployments.plan_profile import DEFAULT_PROFILE, StackProfile

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

# The line a composed scaffold's service fragments replace. A comment, so the
# unfragmented file on disk is still a valid document a developer can read.
_FRAGMENT_MARKER = "# pz:services"

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

    Variables exist here for a specific reason: `PROMPTWORKSPACE_WEB_ORIGIN` feeds the
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
    # None = there is no workspace credential at all, which happens for two
    # different reasons — the platform mints one per workspace, or the git
    # host supplies an ephemeral one to the workflow itself. The provider's
    # `credential_owner` is what distinguishes them.
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
    # How a `url_kind="platform"` template's URL is computed, resolved in
    # app/deployments/preview_url.py and nowhere else:
    #
    #   platform_r2            from the platform's own storage settings
    #   project_value:<key>    named by a human, from DeploymentConfig
    #   github_pages           derived from the repository the cloud created
    #
    # Empty for a provider-minted URL, which has no expected value to check a
    # report against. Declarative rather than a branch per template, for the
    # reason ADR 0023's amendment gives: computing this by calling one
    # provider's URL helper directly is what silently pinned every other
    # platform-URL template against a prefix it could never match.
    platform_url_source: str = ""
    workflow_path: str = WORKFLOW_PATH
    docs_path: str = "docs/deployment.md"
    # Extra per-template context for docs rendering. Never used for dispatch.
    notes: tuple[str, ...] = field(default_factory=tuple)


BUILTIN_TEMPLATES: list[DeploymentTemplate] = [
    DeploymentTemplate(
        id="static-r2",
        name="Static site → PromptWorkspace hosting",
        description=(
            "A plain HTML/CSS/JS site published to PromptWorkspace-managed storage. "
            "No third-party account to create — the fastest way to get a live "
            "preview a business user can open."
        ),
        stack="static",
        provider="platform-r2",
        provider_credential_kind=None,
        scaffold_dir="static-r2",
        required_secrets=(
            SecretSpec("PROMPTWORKSPACE_R2_ACCESS_KEY_ID", "Storage access key id"),
            SecretSpec("PROMPTWORKSPACE_R2_SECRET_ACCESS_KEY", "Storage secret access key"),
        ),
        required_vars=(
            VarSpec("PROMPTWORKSPACE_R2_BUCKET", "Preview bucket", "provider:bucket"),
            VarSpec("PROMPTWORKSPACE_R2_ENDPOINT", "Storage S3 endpoint", "provider:endpoint"),
            VarSpec("PROMPTWORKSPACE_PREVIEW_URL", "Public preview URL", "preview_url"),
            VarSpec("PROMPTWORKSPACE_PROJECT_ID", "PromptWorkspace project id", "project_id"),
            VarSpec("PROMPTWORKSPACE_ENVIRONMENT", "Deployment environment", "environment"),
        ),
        # Public bucket URLs send neither X-Frame-Options nor a CSP, so they
        # frame by default. Worth stating plainly rather than implying we set
        # a permissive header here: for this template we *cannot* set
        # frame-ancestors — the host serves no custom headers — and "no
        # restriction" is the reason embedding works. That is also why this
        # template declares no PROMPTWORKSPACE_WEB_ORIGIN: nothing here could read it.
        embeddable=True,
        health_path="/index.html",
        url_kind="platform",
        platform_url_source="platform_r2",
        notes=(
            "Preview storage is managed by PromptWorkspace; there is no account to "
            "create and no bill to pay for it.",
            "Public preview URLs are rate-limited and intended for review, not "
            "production traffic.",
        ),
    ),
    DeploymentTemplate(
        id="github-pages",
        name="Static site → GitHub Pages",
        description=(
            "A plain HTML/CSS/JS site published to GitHub Pages, out of the "
            "repository PromptWorkspace already created for this project. Nothing "
            "to connect and nothing to pay for — but the repository must be "
            "public unless your GitHub plan allows Pages on private ones."
        ),
        stack="static",
        provider="github-pages",
        # Host-owned: the credential is the workflow's own GITHUB_TOKEN, so
        # there is no workspace block to key into and nothing for an admin to
        # connect. See `credential_owner` on the provider.
        provider_credential_kind=None,
        scaffold_dir="github-pages",
        delivery_kind="embedded_url",
        # Nothing at all. Deploying needs only the ephemeral token GitHub
        # already gives the run, which is the whole point of this template.
        required_secrets=(),
        required_vars=(
            VarSpec("PROMPTWORKSPACE_PROJECT_ID", "PromptWorkspace project id", "project_id"),
            VarSpec("PROMPTWORKSPACE_ENVIRONMENT", "Deployment environment", "environment"),
        ),
        # Measured rather than assumed (ADR 0023's amendment): Pages-hosted
        # sites return neither X-Frame-Options nor a CSP, so the frame probe
        # reads `allow`. Like static-r2 this is the absence of a restriction —
        # Pages serves no custom headers, so we could not set one here — and
        # the probe still decides.
        embeddable=True,
        health_path="/",
        # Predictable, so it is pinned: a reported URL outside
        # `https://<owner>.github.io/<repo>/` is not the preview we
        # provisioned. Unlike every other platform URL, it cannot be computed
        # until the repository exists.
        url_kind="platform",
        platform_url_source="github_pages",
        notes=(
            "There is no account to create and no credential to connect — the "
            "deploy runs on the token GitHub gives this repository's own "
            "workflow.",
            "The repository must be public for Pages to serve it, unless the "
            "organisation's GitHub plan includes Pages on private "
            "repositories. A public repository exposes the source, this "
            "document, and every commit subject — choose the PromptWorkspace "
            "hosting template instead if that is not acceptable.",
            "The workflow enables Pages itself on its first run and sets the "
            "source to GitHub Actions; nobody has to switch it on in the "
            "repository's settings.",
            "The site is served under a `/<repository>/` path, so links and "
            "asset URLs in `site/` must stay relative.",
        ),
    ),
    DeploymentTemplate(
        id="next-vercel",
        name="Next.js app → Vercel",
        description=(
            "A Next.js App Router application deployed to your own Vercel "
            "project. Bring a Vercel access token; the pipeline builds the app "
            "and publishes it on every push to the default branch."
        ),
        stack="next",
        provider="vercel",
        provider_credential_kind="vercel",
        scaffold_dir="next-vercel",
        delivery_kind="embedded_url",
        required_secrets=(
            SecretSpec("VERCEL_TOKEN", "Vercel access token", from_provider="token"),
        ),
        required_vars=(
            VarSpec("VERCEL_ORG_ID", "Vercel team/personal account id", "provider:org_id"),
            VarSpec("VERCEL_PROJECT_ID", "Vercel project id", "provider:project_id"),
            # Read by next.config.mjs at BUILD time, on the runner, so the
            # frame-ancestors header is baked into the routes manifest. A
            # variable rather than a baked-in file for the same reason the
            # docker-compose template uses one: a web-app origin change is
            # then one API call, not a commit to every repository ever created.
            VarSpec("PROMPTWORKSPACE_WEB_ORIGIN", "PromptWorkspace web origin", "web_origin"),
            VarSpec("PROMPTWORKSPACE_PROJECT_ID", "PromptWorkspace project id", "project_id"),
            VarSpec("PROMPTWORKSPACE_ENVIRONMENT", "Deployment environment", "environment"),
        ),
        # Stronger than static-r2's claim: this template controls its own
        # response headers and names the web app as a frame ancestor, rather
        # than embedding because the host happens to send no framing header.
        embeddable=True,
        health_path="/",
        # Vercel mints the hostname, so the URL arrives with the
        # deployment_status delivery rather than being computed up front.
        url_kind="provider",
        notes=(
            "Create the Vercel project once in the Vercel dashboard; the "
            "pipeline deploys to it but does not create it.",
            "The workflow deploys to production, not to a Vercel preview "
            "deployment, because Vercel's Deployment Protection gates preview "
            "deployments behind a Vercel login by default and a login wall "
            "cannot be reviewed. If the Preview tab shows a Vercel sign-in "
            "page, turn Deployment Protection off for this project's "
            "production domain.",
            "Vercel bills this project to your own account.",
        ),
    ),
    # Last in the list on purpose: it is the most capable and the most
    # demanding. It runs anywhere, but it asks for a machine you administer
    # and a key that opens it, which is a bigger commitment than a hosted
    # provider's token.
    DeploymentTemplate(
        id="docker-compose",
        name="Docker + Docker Compose → your own server",
        description=(
            "A containerised application deployed with Docker Compose to a "
            "Linux server you own. The Dockerfile and the compose services are "
            "chosen from this project's technical plan, so a Python project "
            "with a database gets a Python image and a Postgres service. Bring "
            "a host and an SSH key."
        ),
        stack="container",
        provider="ssh-docker",
        provider_credential_kind="ssh-docker",
        scaffold_dir="docker-compose",
        delivery_kind="embedded_url",
        required_secrets=(
            SecretSpec(
                "PROMPTWORKSPACE_SSH_KEY",
                "SSH private key for the Docker host",
                from_provider="token",
            ),
        ),
        required_vars=(
            VarSpec("PROMPTWORKSPACE_SSH_HOST", "Docker host address", "provider:host"),
            VarSpec("PROMPTWORKSPACE_SSH_USER", "SSH user", "provider:ssh_user"),
            # Host key checking stays on in the seeded workflow, so the run
            # talks to the machine the admin named rather than to whatever
            # answers on that address at deploy time.
            VarSpec(
                "PROMPTWORKSPACE_SSH_KNOWN_HOSTS",
                "Docker host SSH host key",
                "provider:known_hosts",
            ),
            VarSpec("PROMPTWORKSPACE_APP_SLUG", "Compose project name", "provider:app_slug"),
            VarSpec(
                "PROMPTWORKSPACE_HOST_PORT", "Published port on the host", "provider:host_port"
            ),
            # This template's workflow needs the URL it is deploying to — it
            # health-checks it before reporting success, and nothing on the
            # runner could otherwise derive the address of a customer's box.
            VarSpec("PROMPTWORKSPACE_PREVIEW_URL", "Public preview URL", "preview_url"),
            # The seeded server sends `frame-ancestors <origin>`; a variable
            # rather than a baked-in file so a web-app origin change is one API
            # call, not a commit to every repository ever created.
            VarSpec("PROMPTWORKSPACE_WEB_ORIGIN", "PromptWorkspace web origin", "web_origin"),
            VarSpec("PROMPTWORKSPACE_PROJECT_ID", "PromptWorkspace project id", "project_id"),
            VarSpec("PROMPTWORKSPACE_ENVIRONMENT", "Deployment environment", "environment"),
        ),
        # Every runtime scaffold here sets frame-ancestors from PROMPTWORKSPACE_WEB_ORIGIN,
        # so this is the same strong claim next-vercel makes. Whether it holds
        # is still narrowed by the server-side header probe: a reverse proxy
        # in front of the host can add a framing header we never see here.
        embeddable=True,
        health_path="/healthz",
        # Named by a human rather than minted: the address a customer's own
        # server answers on is not discoverable from either side.
        url_kind="platform",
        platform_url_source="project_value:public_url",
        notes=(
            "The host must already run Docker Engine with the Compose plugin, "
            "and the SSH user must be able to use it.",
            "Each project needs its own published port and its own URL on that "
            "host; both are named on this project's deployment template, not on "
            "the workspace connection.",
            "Serve the preview URL over HTTPS. The Preview tab is an HTTPS page, "
            "and a browser will not frame an http:// application inside it.",
            "The image is built by GitHub Actions and streamed to the host over "
            "the same SSH connection — there is no container registry to "
            "configure and no second credential on the host.",
            "The SSH key sealed into this repository is shell access to that "
            "host for anyone who can push here. Give it a dedicated, "
            "unprivileged user, and use a host that runs previews only.",
        ),
    ),
]

_BY_ID: dict[str, DeploymentTemplate] = {t.id: t for t in BUILTIN_TEMPLATES}


def get_template(template_id: str) -> DeploymentTemplate | None:
    return _BY_ID.get(template_id)


def is_composed_scaffold(template_id: str) -> bool:
    """True when this template's scaffold varies with the project's plan — the
    `base/` layout described in the module docstring."""
    template = get_template(template_id)
    if template is None:
        return False
    return (_TEMPLATES_DIR / template.scaffold_dir / "base").is_dir()


def _files_under(root: Path) -> list[tuple[str, str, bool]]:
    """Every file below `root`, as (repo path relative to `root`, content,
    executable).

    Paths are resolved and re-checked against `root` before being read. A
    scaffold is committed verbatim into a customer's repository, so a `..`
    escaping the template directory would be a file-disclosure bug, not a
    cosmetic one — and this stays correct even if template directories later
    come from somewhere less trusted than the package itself.
    """
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
        files.append(
            (
                "/".join(parts),
                resolved.read_text(encoding="utf-8"),
                resolved.stat().st_mode & 0o100 != 0,
            )
        )
    return files


def _apply_fragments(content: str, fragments: list[str]) -> str:
    """Replace the marker line with `fragments`, or drop the marker line when
    there are none.

    Line-oriented and whitespace-preserving: the marker's own indentation is
    not reused, because each fragment is a hand-written block that already
    carries the indentation its position requires.
    """
    out: list[str] = []
    for line in content.splitlines():
        if line.strip() == _FRAGMENT_MARKER:
            for fragment in fragments:
                out.extend(fragment.rstrip("\n").splitlines())
            continue
        out.append(line)
    return "\n".join(out) + "\n"


def template_files(
    template_id: str, profile: StackProfile | None = None
) -> list[tuple[str, str, bool]]:
    """Every file in a template's scaffold, as (repo path, content,
    executable), sorted for a deterministic commit.

    `profile` selects among a composed scaffold's variants and fragments (see
    the module docstring). It is ignored by a flat template, and defaults to
    `plan_profile.DEFAULT_PROFILE` — which is what the templates *listing*
    passes, so the picker previews a real scaffold without needing a project.

    Deterministic in both layouts: the same template and the same profile
    produce the same tree, byte for byte, which is what makes a seeded
    pipeline reviewable and a template bug reproducible.
    """
    template = get_template(template_id)
    if template is None:
        return []
    root = (_TEMPLATES_DIR / template.scaffold_dir).resolve()
    if not root.is_dir():
        return []

    base = root / "base"
    if not base.is_dir():
        return _files_under(root)

    profile = profile or DEFAULT_PROFILE
    files = _files_under(base)

    # Exactly one runtime variant, and silently none when the profile names a
    # runtime this template has no scaffold for. A composed template must not
    # fail repository creation over a plan that mentioned an unsupported
    # language — the same contract `build_seed_files` keeps for a partially
    # planned project.
    variant = (root / "runtimes" / profile.runtime).resolve()
    if variant.is_relative_to(root) and variant.is_dir():
        files += _files_under(variant)

    fragments: list[str] = []
    for service in profile.services:
        fragment = (root / "services" / f"{service}.yaml").resolve()
        if fragment.is_relative_to(root) and fragment.is_file():
            fragments.append(fragment.read_text(encoding="utf-8"))

    files = [
        (path, _apply_fragments(content, fragments) if _FRAGMENT_MARKER in content else content, ex)
        for path, content, ex in files
    ]
    return sorted(files)


def render_deployment_doc(
    template: DeploymentTemplate,
    *,
    project_name: str,
    preview_url: str | None,
    profile: StackProfile | None = None,
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
        "it, then records the result as a GitHub Deployment. PromptWorkspace reads "
        "that deployment over the repository's webhook and shows the live "
        "application in the project's Preview tab, so business stakeholders "
        "can review real progress without a development environment.",
        "",
        "PromptWorkspace does not build or host anything itself — this repository's "
        "own CI does the work, using credentials stored as repository secrets. "
        "The workflow is an ordinary file: edit it freely.",
        "",
    ]
    if preview_url:
        lines += ["## Live preview", "", f"<{preview_url}>", ""]

    if profile is not None:
        services = ", ".join(profile.services) if profile.services else "none"
        lines += [
            "## What this project's plan decided",
            "",
            "This template ships more than one hand-written scaffold and picks "
            "between them by reading the project's technical plan. For this "
            f"repository it seeded the **{profile.runtime}** runtime, with "
            f"these backing services: **{services}**.",
            "",
            "That reading is a keyword scan, not a judgement, and it only ever "
            "chose among files written by hand — nothing here was generated. "
            "If it guessed wrong, change the `Dockerfile` and `compose.yaml`: "
            "they are yours now, and re-selecting the template would not "
            "revisit them.",
            "",
        ]

    if template.required_secrets:
        lines += [
            "## Repository secrets",
            "",
            "Written by PromptWorkspace at repository creation. Rotate them by "
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
