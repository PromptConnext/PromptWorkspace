"""The composed scaffold's selection from a pinned TypeSafe judgment
(app/deployments/stack_judge.py).

The judgment only ever chooses among scaffolds the template ships, falls back
to the keyword scan per dimension, and is pinned so the preview and the seed
select the same files. No network: the client is a fake, and the HTTP client's
wire shape is checked through an httpx MockTransport.
"""

from __future__ import annotations

import asyncio
import json

import httpx

from app.deployments.plan_profile import derive_stack_profile
from app.deployments.stack_judge import (
    QUESTIONS,
    apply_judgment,
    fingerprint,
    judge,
    judgment_state,
)
from app.integrations.typesafe import FakeTypeSafeClient, HttpTypeSafeClient
from app.models.schemas import DeploymentConfig, RepoExcerpt, RepoSnapshot, RepoStack, StackJudgment
from tests.test_lifecycle import (
    ALICE,
    _client,
    _connect_docker_host,
    _create_repo,
    _project_in_tech_review,
    _wire_github,
)

# A Python backend whose plan also describes its TypeScript client: the case
# the keyword count gets wrong (node 3 hits, python 2).
MIXED_PLAN = (
    "# Architecture\n\nBackend in Python with FastAPI. The web client uses "
    "TypeScript, JavaScript and Next.js. We will NOT use Redis; no message queue."
)


def _judgment(runtime="python", confidence=0.9, postgres=0.1, redis=0.05) -> StackJudgment:
    return StackJudgment(
        input_sha256="x",
        model="fake-jev",
        runtime=runtime,
        runtime_confidence=confidence,
        services={"postgres": postgres, "redis": redis},
    )


def _answers(runtime="python", confidence=0.9, postgres=0.1, redis=0.05) -> dict:
    return {
        "runtime": {"type": "choice", "choice": runtime, "confidence": confidence},
        "postgres": {"type": "noul", "noul": postgres},
        "redis": {"type": "noul", "noul": redis},
    }


# --------------------------------------------------------------------------- #
# Policy: what a judgment is allowed to decide
# --------------------------------------------------------------------------- #


def test_the_keyword_scan_misreads_the_mixed_plan():
    """The reason this module exists, pinned so a keyword change that fixes
    it is noticed and this comparison is revisited."""
    keywords = derive_stack_profile(MIXED_PLAN)
    assert keywords.runtime == "node"
    assert "redis" in keywords.services


def test_a_confident_judgment_decides_runtime_and_services():
    profile = apply_judgment(_judgment(), MIXED_PLAN)
    assert profile.runtime == "python"
    assert profile.services == ()


def test_no_judgment_is_exactly_the_keyword_scan():
    assert apply_judgment(None, MIXED_PLAN, "go") == derive_stack_profile(MIXED_PLAN, "go")


def test_a_diffuse_runtime_distribution_falls_back_to_keywords():
    assert apply_judgment(_judgment(confidence=0.3), MIXED_PLAN).runtime == "node"


def test_other_is_never_a_selection():
    """A runtime with no scaffold falls back rather than being trusted —
    the same rule plan_profile applies to a detected runtime."""
    assert apply_judgment(_judgment(runtime="other"), "A Go service.").runtime == "go"
    assert apply_judgment(_judgment(runtime="rust"), MIXED_PLAN).runtime == "node"


def test_an_uncertain_service_falls_back_to_keywords_for_that_service_only():
    profile = apply_judgment(_judgment(postgres=0.95, redis=0.5), MIXED_PLAN)
    # postgres: decided by the judgment; redis: uncertain, so the scan's
    # (wrong, but deterministic) answer stands.
    assert profile.services == ("postgres", "redis")


def test_a_confident_judgment_overrides_an_imported_repos_manifests():
    """A root package.json for frontend tooling made a Django repo read as
    Node; a judgment that saw the manifests' contents decides instead."""
    assert apply_judgment(_judgment(), "A Django app.", "node").runtime == "python"
    assert apply_judgment(_judgment(confidence=0.2), "A Django app.", "node").runtime == "node"


# --------------------------------------------------------------------------- #
# State and fingerprint
# --------------------------------------------------------------------------- #


def test_no_evidence_asks_nothing():
    assert judgment_state(None) is None
    assert judgment_state("   ") is None


def test_an_imported_repo_contributes_only_its_manifests():
    snapshot = RepoSnapshot(
        commit_sha="abc",
        default_branch="main",
        stack=RepoStack(runtime="node", manifests=["package.json", "pyproject.toml"]),
        excerpts=[
            RepoExcerpt(path="README.md", content="hello"),
            RepoExcerpt(path="package.json", content='{"devDependencies": {"prettier": "3"}}'),
            RepoExcerpt(path="pyproject.toml", content="[project]\ndependencies=['django']"),
        ],
    )
    state = judgment_state("", snapshot)
    assert set(state["repository"]["manifest_contents"]) == {"package.json", "pyproject.toml"}


def test_the_fingerprint_follows_the_plan():
    def fp(plan):
        return fingerprint(judgment_state(plan), plan)

    a = fp("A Python service.")
    assert a == fp("A Python service.")
    assert a != fp("A Go service.")


def test_an_edit_past_the_state_cap_still_changes_the_fingerprint():
    long = "A Python service. " + "x" * 40_000
    assert judgment_state(long) == judgment_state(long + " Redis.")
    assert fingerprint(judgment_state(long), long) != fingerprint(
        judgment_state(long + " Redis."), long + " Redis."
    )


# --------------------------------------------------------------------------- #
# Asking
# --------------------------------------------------------------------------- #


def test_judge_records_the_raw_answers():
    state = judgment_state(MIXED_PLAN)
    judgment = asyncio.run(judge(FakeTypeSafeClient(_answers()), state, "sha"))
    assert judgment.runtime == "python"
    assert judgment.services == {"postgres": 0.1, "redis": 0.05}
    assert judgment.input_sha256 == "sha"


def test_judge_returns_none_on_failure_or_missing_answers():
    state = judgment_state(MIXED_PLAN)
    assert asyncio.run(judge(FakeTypeSafeClient(fail=True), state, "sha")) is None
    partial = {"runtime": _answers()["runtime"]}
    assert asyncio.run(judge(FakeTypeSafeClient(partial), state, "sha")) is None


def test_judge_rejects_probabilities_outside_zero_to_one():
    state = judgment_state(MIXED_PLAN)
    for bad in (float("nan"), 1.5, -0.1):
        client = FakeTypeSafeClient(_answers(redis=bad))
        assert asyncio.run(judge(client, state, "sha")) is None


def test_the_http_client_speaks_the_systemone_shape():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"model": "jev", "answers": _answers()})

    client = HttpTypeSafeClient(
        "ts-key",
        "https://api.typesafe.ai/v1/",
        "jev-latest",
        transport=httpx.MockTransport(handler),
    )
    judgment = asyncio.run(judge(client, judgment_state(MIXED_PLAN), "sha"))
    assert judgment is not None and judgment.model == "jev-latest"
    assert seen["url"] == "https://api.typesafe.ai/v1/systemone"
    assert seen["auth"] == "Bearer ts-key"
    assert seen["body"]["model"] == "jev-latest"
    assert set(seen["body"]["questions"]) == set(QUESTIONS)


def test_an_http_error_is_a_fallback_not_a_failure():
    client = HttpTypeSafeClient(
        "k", "https://t", "m", transport=httpx.MockTransport(lambda r: httpx.Response(529))
    )
    assert asyncio.run(judge(client, judgment_state(MIXED_PLAN), "sha")) is None


# --------------------------------------------------------------------------- #
# Pinning, end to end through the preview and the seed
# --------------------------------------------------------------------------- #


def _docker_compose_project(client, plan: str) -> str:
    ws, pid = _project_in_tech_review(client)
    client.app.state.repository.upsert_stage_document(pid, ws["id"], "plan", plan, "alice")
    _connect_docker_host(client, ws["id"])
    client.app.state.repository.update_project_deployment_config(
        pid,
        DeploymentConfig(
            template_id="docker-compose",
            provider_values={
                "app_slug": "rocket",
                "host_port": "8081",
                "public_url": "https://rocket.example.com",
            },
        ),
    )
    return pid


def test_the_preview_pins_what_the_seed_commits_and_the_model_is_asked_once():
    with _client() as client:
        fake = _wire_github(client)
        typesafe = FakeTypeSafeClient(_answers())
        client.app.state.typesafe_client = typesafe
        pid = _docker_compose_project(client, MIXED_PLAN)

        preview = client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE)
        assert preview.status_code == 200, preview.text
        pinned = client.app.state.repository.get_project(pid).deployment_config.stack_judgment
        assert pinned is not None and pinned.runtime == "python"

        assert _create_repo(client, pid).status_code == 200
        paths = set(fake.commits[0]["paths"])
        assert "main.py" in paths and "server.js" not in paths
        assert sorted(preview.json()["write"]) == sorted(fake.commits[0]["paths"])
        assert len(typesafe.calls) == 1


def test_without_a_client_the_seed_is_the_keyword_scan():
    with _client() as client:
        fake = _wire_github(client)
        assert client.app.state.typesafe_client is None
        pid = _docker_compose_project(client, MIXED_PLAN)

        assert _create_repo(client, pid).status_code == 200
        assert "server.js" in set(fake.commits[0]["paths"])
        assert client.app.state.repository.get_project(pid).deployment_config.stack_judgment is None


def test_a_changed_plan_is_asked_again():
    with _client() as client:
        _wire_github(client)
        typesafe = FakeTypeSafeClient(_answers())
        client.app.state.typesafe_client = typesafe
        pid = _docker_compose_project(client, MIXED_PLAN)

        client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE)
        client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE)
        assert len(typesafe.calls) == 1

        project = client.app.state.repository.get_project(pid)
        client.app.state.repository.upsert_stage_document(
            pid, project.workspace_id, "plan", MIXED_PLAN + "\nAdd PostgreSQL.", "alice"
        )
        client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE)
        assert len(typesafe.calls) == 2


def test_a_failed_preview_call_pins_keywords_so_the_seed_matches_it():
    with _client() as client:
        fake = _wire_github(client)
        typesafe = FakeTypeSafeClient(_answers(), fail=True)
        client.app.state.typesafe_client = typesafe
        pid = _docker_compose_project(client, MIXED_PLAN)

        preview = client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE).json()
        typesafe.fail = False  # the service recovers before the seed
        assert _create_repo(client, pid).status_code == 200

        assert sorted(preview["write"]) == sorted(fake.commits[0]["paths"])
        assert "server.js" in fake.commits[0]["paths"]  # keywords decided both times
        assert len(typesafe.calls) == 1


def test_a_config_change_during_the_call_is_not_overwritten():
    with _client() as client:
        _wire_github(client)
        pid = _docker_compose_project(client, MIXED_PLAN)
        repo = client.app.state.repository

        class PatchingClient(FakeTypeSafeClient):
            async def evaluate(self, state, questions):
                repo.update_project_deployment_config(
                    pid, DeploymentConfig(template_id="docker-compose", provider_values={})
                )
                return await super().evaluate(state, questions)

        client.app.state.typesafe_client = PatchingClient(_answers())
        client.get(f"/projects/{pid}/repository/seed-preview", headers=ALICE)

        config = repo.get_project(pid).deployment_config
        assert config.provider_values == {}  # the admin's change stands
        assert config.stack_judgment is None
