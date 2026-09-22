"""The composed scaffold: reading a stack profile off a project's technical
plan and *selecting* hand-written files with it (ADR 0026).

Two properties carry the whole design, and both are pinned here: the selection
is deterministic, so the seed commit for a given plan is reproducible; and it
only ever chooses among files this repository wrote, so free text a business
user typed in the Planner can never become part of a pipeline that holds a
deploy credential (ADR 0024 decision 1).
"""

from __future__ import annotations

from app.deployments.plan_profile import DEFAULT_PROFILE, StackProfile, derive_stack_profile
from app.deployments.registry import is_composed_scaffold, template_files
from app.integrations.repo_seed import build_deployment_files
from app.models.schemas import DeploymentConfig, Project

TEMPLATE = "docker-compose"


def _project() -> Project:
    return Project(
        name="Rocket",
        workspace_id="ws-1",
        owner_id="alice",
        deployment_config=DeploymentConfig(template_id=TEMPLATE),
    )


def _paths(plan: str | None) -> set[str]:
    return {f.path for f in build_deployment_files(_project(), None, plan)}


def _content(plan: str | None, path: str) -> str:
    return next(f.content for f in build_deployment_files(_project(), None, plan) if f.path == path)


# --------------------------------------------------------------------------- #
# Reading the plan
# --------------------------------------------------------------------------- #
def test_a_python_plan_reads_as_python():
    plan = "The service is a FastAPI application served by uvicorn, in Python."
    assert derive_stack_profile(plan).runtime == "python"


def test_a_passing_mention_does_not_outweigh_the_stack_the_plan_describes():
    # Scored by keyword count rather than first match on purpose: a Python
    # plan that mentions JavaScript once must not seed a Node image.
    plan = (
        "A Django backend in Python. Python workers handle imports. "
        "The admin screens ship a little JavaScript."
    )
    assert derive_stack_profile(plan).runtime == "python"


def test_a_plan_that_names_no_stack_falls_back_rather_than_failing():
    assert derive_stack_profile("A tool for booking meeting rooms.") == DEFAULT_PROFILE
    assert derive_stack_profile(None) == DEFAULT_PROFILE
    assert derive_stack_profile("") == DEFAULT_PROFILE


def test_backing_services_come_from_the_plan_in_a_fixed_order():
    plan = "A Golang service. It caches sessions in Redis and stores bookings in PostgreSQL."
    profile = derive_stack_profile(plan)
    assert profile.runtime == "go"
    # Fixed order, not the order the plan happened to mention them in: the
    # seed commit has to be reproducible.
    assert profile.services == ("postgres", "redis")


def test_word_boundaries_keep_incidental_words_from_scoring():
    # "going" is not Go, and "nodes" in a diagram description is not Node.
    profile = derive_stack_profile("Traffic going between nodes of the diagram.")
    assert profile == DEFAULT_PROFILE


def test_an_imported_repos_manifests_override_the_plans_runtime():
    """Plan 0027: a `package.json` at the root is better evidence than a plan
    that mentions Python. Services still come from the plan."""
    plan = "A Python service with FastAPI, storing bookings in PostgreSQL."
    profile = derive_stack_profile(plan, detected_runtime="node")
    assert profile == StackProfile(runtime="node", services=("postgres",))
    assert derive_stack_profile(None, detected_runtime="go").runtime == "go"


def test_a_detected_runtime_without_a_scaffold_is_ignored():
    plan = "A Python service with FastAPI."
    assert derive_stack_profile(plan, detected_runtime="rust").runtime == "python"
    assert derive_stack_profile(None, detected_runtime="rust") == DEFAULT_PROFILE


# --------------------------------------------------------------------------- #
# Selecting the files
# --------------------------------------------------------------------------- #
def test_the_template_has_a_composed_scaffold_and_the_others_do_not():
    assert is_composed_scaffold(TEMPLATE) is True
    assert is_composed_scaffold("next-vercel") is False
    assert is_composed_scaffold("static-r2") is False


def test_a_python_plan_seeds_the_python_scaffold_and_nothing_from_the_others():
    paths = _paths("A FastAPI application in Python.")
    assert {"main.py", "requirements.txt", "Dockerfile", "compose.yaml"} <= paths
    assert "server.js" not in paths
    assert "main.go" not in paths
    assert "python:3.13-slim" in _content("A FastAPI application in Python.", "Dockerfile")


def test_a_go_plan_seeds_the_go_scaffold():
    plan = "A Go service using net/http."
    paths = _paths(plan)
    assert {"main.go", "go.mod"} <= paths
    assert "package.json" not in paths
    assert "golang" in _content(plan, "Dockerfile")


def test_an_unplanned_project_still_seeds_a_working_scaffold():
    # Repository creation must never fail on a partially planned project, so
    # an absent plan seeds the default runtime rather than nothing.
    paths = _paths(None)
    assert {"Dockerfile", "compose.yaml", "server.js"} <= paths


def test_a_plan_naming_a_database_seeds_the_postgres_service():
    compose = _content("A Node API backed by PostgreSQL.", "compose.yaml")
    assert "postgres:17-alpine" in compose
    assert "redis:7-alpine" not in compose
    # The marker is consumed, never committed.
    assert "# pz:services" not in compose


def test_a_plan_naming_both_services_seeds_both_in_one_valid_block():
    compose = _content("A Node API on PostgreSQL, with Redis for its job queue.", "compose.yaml")
    assert "postgres:17-alpine" in compose
    assert "redis:7-alpine" in compose
    # Every service fragment is a single indented block under `services:`, so
    # the order they are appended in can never break the document.
    assert all(
        line.startswith(("  ", "\t")) or not line.strip()
        for line in compose.split("services:", 1)[1].splitlines()
    )


def test_a_plan_naming_no_service_leaves_the_marker_line_out():
    compose = _content("A small Node service.", "compose.yaml")
    assert "# pz:services" not in compose
    assert "postgres:17-alpine" not in compose


def test_the_same_plan_always_seeds_the_same_tree():
    plan = "A Python service with PostgreSQL."
    project = _project()
    first = [(f.path, f.content) for f in build_deployment_files(project, None, plan)]
    second = [(f.path, f.content) for f in build_deployment_files(project, None, plan)]
    assert first == second
    # Sorted, so the seed commit's tree is stable and a template bug is
    # reproducible from the template id and the plan alone.
    scaffold = [path for path, _ in first if path != "docs/deployment.md"]
    assert scaffold == sorted(scaffold)


def test_an_unsupported_runtime_seeds_the_base_files_rather_than_failing():
    # A profile can only come from the scanner today, but the selection must
    # degrade rather than raise if a runtime is ever named without a scaffold.
    files = template_files(TEMPLATE, StackProfile(runtime="haskell"))
    paths = {path for path, _, _ in files}
    assert "compose.yaml" in paths
    assert "Dockerfile" not in paths


def test_the_deployment_doc_records_what_the_plan_decided():
    doc = _content("A Python service with PostgreSQL.", "docs/deployment.md")
    assert "python" in doc
    assert "postgres" in doc
    # And says plainly that nothing was generated — the distinction this whole
    # mechanism rests on.
    assert "nothing here was generated" in doc


def test_a_flat_templates_doc_says_nothing_about_a_plan():
    project = Project(
        name="Rocket",
        workspace_id="ws-1",
        owner_id="alice",
        deployment_config=DeploymentConfig(template_id="next-vercel"),
    )
    doc = next(
        f.content
        for f in build_deployment_files(project, None, "A Python service.")
        if f.path == "docs/deployment.md"
    )
    assert "What this project's plan decided" not in doc
