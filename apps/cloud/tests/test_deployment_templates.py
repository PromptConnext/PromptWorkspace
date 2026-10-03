"""The Deployment Template registry's contract (ADR 0021).

Mirrors tests/test_policy_templates.py in spirit: these assert the *shape*
every template must satisfy, so a fifth template added later cannot quietly
break the promise that adding one is a directory plus a registry entry.

Several of these enforce things the ADR merely states — the `ws:` namespacing
convention, the pinned-action CI convention, the no-inline-secrets rule.
Documented conventions rot; asserted ones do not.
"""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.deployments.registry import (
    BUILTIN_TEMPLATES,
    DELIVERY_KINDS,
    PREVIEW_ENVIRONMENT,
    get_template,
    render_deployment_doc,
    template_files,
)
from app.integrations.deploy_providers import get_provider
from app.main import create_app
from app.models.schemas import Project

ALICE = {"X-User-Id": "alice"}


def _files(template_id: str) -> dict[str, str]:
    return {path: content for path, content, _ in template_files(template_id)}


def _code_lines(workflow: str) -> list[str]:
    """Workflow lines with comments dropped.

    The rules below are about what a workflow *does*. A comment warning a
    future editor never to use `pull_request_target` is the opposite of a
    violation, and matching on it would punish the documentation."""
    return [line for line in workflow.splitlines() if not line.lstrip().startswith("#")]


def test_every_builtin_id_is_a_bare_slug():
    """The `ws:<uuid>` namespace is reserved for future workspace-owned
    templates. A built-in that grew a colon would collide with it, and the
    collision would only surface once org templates shipped."""
    for template in BUILTIN_TEMPLATES:
        assert ":" not in template.id, template.id
        assert re.fullmatch(r"[a-z0-9][a-z0-9-]*", template.id), template.id


def test_ids_are_unique():
    ids = [t.id for t in BUILTIN_TEMPLATES]
    assert len(ids) == len(set(ids))


def test_every_template_ships_a_scaffold_and_a_workflow():
    for template in BUILTIN_TEMPLATES:
        files = _files(template.id)
        assert files, f"{template.id} seeds no files"
        assert template.workflow_path in files, f"{template.id} has no workflow"


def test_every_declared_provider_exists():
    for template in BUILTIN_TEMPLATES:
        assert get_provider(template.provider) is not None, template.provider


def test_every_declared_secret_is_actually_read_by_the_workflow():
    """Catches the drift where a template declares a secret nothing consumes
    — which would provision a credential into a customer repo for no reason,
    and quietly widen the blast radius of a leak."""
    for template in BUILTIN_TEMPLATES:
        files = _files(template.id)
        workflow = files[template.workflow_path]
        # Secrets must be read by the workflow and nowhere else: a secret
        # named in a committed static file would be the leak itself.
        for spec in template.required_secrets:
            assert spec.name in workflow, f"{template.id} declares unused secret {spec.name}"
        # Variables may be consumed anywhere in the scaffold — a header
        # config or a build file is as legitimate as the workflow.
        everything = "\n".join(files.values())
        for spec in template.required_vars:
            assert spec.name in everything, f"{template.id} declares unused var {spec.name}"


def test_workflows_pin_every_action_to_a_full_sha():
    """The repo's own CI convention (.github/workflows/desktop-build.yml)
    pins every action to a 40-character commit SHA. Generated workflows land
    in customer repositories where nobody reviews them, so a floating `@v4`
    tag there is a supply-chain hole no reviewer would ever catch."""
    for template in BUILTIN_TEMPLATES:
        workflow = _files(template.id)[template.workflow_path]
        for ref in re.findall(r"uses:\s*(\S+)", workflow):
            assert "@" in ref, ref
            assert re.fullmatch(r"[0-9a-f]{40}", ref.split("@", 1)[1]), ref


def test_workflows_never_interpolate_a_secret_inline():
    """A `${{ secrets.X }}` outside an `env:` block is substituted into the
    command text itself, where it can be reshaped by the shell and land in a
    log. Every seeded workflow passes secrets through env, matching the
    discipline the repo's own workflows already follow."""
    for template in BUILTIN_TEMPLATES:
        workflow = _files(template.id)[template.workflow_path]
        for line in _code_lines(workflow):
            if "secrets." not in line:
                continue
            # The only permitted shape is `NAME: ${{ secrets.X }}`, i.e. a
            # mapping entry — which is what an env: block is made of.
            assert re.match(r"\s*[A-Z_][A-Z0-9_]*:\s*\$\{\{\s*secrets\.", line), line


def test_pull_request_jobs_have_no_secret_access():
    """A fork's pull request must never be able to read a deploy credential.
    The check job is what guarantees that, by not referencing secrets at all
    — and `pull_request_target` would hand it the credential anyway."""
    for template in BUILTIN_TEMPLATES:
        assert "pull_request_target" not in "\n".join(
            _code_lines(_files(template.id)[template.workflow_path])
        )


def test_workflows_declare_the_preview_environment():
    for template in BUILTIN_TEMPLATES:
        workflow = _files(template.id)[template.workflow_path]
        assert "deployments: write" in workflow
        assert "PROMPTWORKSPACE_ENVIRONMENT" in workflow
    assert PREVIEW_ENVIRONMENT == "preview"


def test_template_files_never_escape_the_template_directory():
    """Scaffold files are committed verbatim into a customer repository, so a
    path escaping the template root would be a file-disclosure bug."""
    for template in BUILTIN_TEMPLATES:
        for path, _content, _exe in template_files(template.id):
            assert not path.startswith("/")
            assert ".." not in path.split("/")


def test_tmpl_suffix_is_stripped():
    """Workflow files are stored as `<name>.tmpl` so they cannot take effect
    inside this repository, and must arrive in the customer's repo without
    that suffix."""
    for template in BUILTIN_TEMPLATES:
        for path, _content, _exe in template_files(template.id):
            assert not path.endswith(".tmpl"), path


def test_unknown_template_resolves_to_nothing():
    assert get_template("nope") is None
    assert template_files("nope") == []


def test_deployment_doc_names_the_credential_blast_radius():
    template = BUILTIN_TEMPLATES[0]
    doc = render_deployment_doc(
        template, project_name="Rocket Ship", preview_url="https://example.test/p/"
    )
    assert "Rocket Ship" in doc
    assert "https://example.test/p/" in doc
    # The one thing docs/deployment.md must not omit: whoever can push here
    # can use the deploy credential.
    assert "push" in doc.lower()
    for spec in template.required_secrets:
        assert spec.name in doc


def test_deployment_doc_omits_the_preview_section_without_a_url():
    doc = render_deployment_doc(BUILTIN_TEMPLATES[0], project_name="P", preview_url=None)
    assert "Live preview" not in doc


def test_list_endpoint_ships_the_workflow_inline():
    """The picker previews what a template will commit; making that a second
    round-trip per template is the mistake app/api/policies.py already
    records for policy bodies."""
    app = create_app()
    with TestClient(app) as client:
        res = client.get("/deployment-templates", headers=ALICE)
        assert res.status_code == 200, res.text
        rows = res.json()
        assert len(rows) == len(BUILTIN_TEMPLATES)
        row = rows[0]
        assert row["workflow_preview"].strip()
        assert row["scaffold_paths"]
        assert row["provider_label"]


def test_list_endpoint_accepts_the_future_workspace_id_param():
    app = create_app()
    with TestClient(app) as client:
        res = client.get("/deployment-templates?workspace_id=ws-1", headers=ALICE)
        assert res.status_code == 200


def test_project_defaults_to_no_deployment():
    """Both fields nullable, so every project created before this feature
    stays valid."""
    project = Project(name="P", workspace_id="w", owner_id="u")
    assert project.deployment_config is None
    assert project.deployment_state is None


def test_every_builtin_declares_a_known_delivery_kind():
    for template in BUILTIN_TEMPLATES:
        assert template.delivery_kind in DELIVERY_KINDS, template.id


def test_static_r2_still_presents_as_an_embedded_url():
    # ADR 0023 phase 1: behaviour must be byte-identical for existing projects.
    assert get_template("static-r2").delivery_kind == "embedded_url"


def test_delivery_kind_is_on_the_templates_endpoint(client):
    rows = client.get("/deployment-templates", headers={"X-User-Id": "alice"}).json()
    assert {r["id"]: r["delivery_kind"] for r in rows}["static-r2"] == "embedded_url"
