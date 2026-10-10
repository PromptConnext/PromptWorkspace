"""FakeGithubClient models branches, per-commit file snapshots and pull
requests, so the docs-sync routes can be tested against what a real
repository would list rather than a hand-maintained path list."""

from __future__ import annotations

import asyncio

import pytest

from app.integrations.github import (
    FakeGithubClient,
    GithubBranchMovedError,
    GithubRefUpdateRejectedError,
    GithubWriteError,
)
from app.integrations.repo_docs import git_blob_sha
from app.integrations.repo_seed import SeedFile

REPO = "acme/app"


def _blobs(entries: list[dict]) -> dict[str, str]:
    return {e["path"]: e["sha"] for e in entries if e["type"] == "blob"}


def test_a_seed_commit_is_listed_with_git_blob_shas():
    fake = FakeGithubClient()

    async def run():
        await fake.create_commit_with_files(
            "tok",
            REPO,
            "main",
            [SeedFile("AGENTS.md", "a"), SeedFile("docs/scope.md", "b")],
            "seed",
        )
        head = await fake.get_branch_head("tok", REPO, "main")
        return await fake.get_tree_entries("tok", REPO, head)

    entries, truncated = asyncio.run(run())

    assert truncated is False
    assert _blobs(entries) == {
        "AGENTS.md": git_blob_sha("a"),
        "docs/scope.md": git_blob_sha("b"),
    }
    assert {"path": "docs", "type": "tree", "sha": "fake-tree:docs"} in entries


def test_a_commit_onto_a_new_branch_leaves_the_default_branch_alone():
    fake = FakeGithubClient()

    async def run():
        seed = await fake.create_commit_with_files(
            "tok", REPO, "main", [SeedFile("AGENTS.md", "a")], "seed"
        )
        await fake.create_branch("tok", REPO, "pw/sync-docs-1", seed)
        assert await fake.get_branch_head("tok", REPO, "pw/sync-docs-1") == seed
        synced = await fake.create_commit_with_files(
            "tok", REPO, "pw/sync-docs-1", [SeedFile("AGENTS.md", "new")], "sync"
        )
        main_head = await fake.get_branch_head("tok", REPO, "main")
        main_entries, _ = await fake.get_tree_entries("tok", REPO, main_head)
        branch_entries, _ = await fake.get_tree_entries("tok", REPO, synced)
        return seed, synced, main_head, main_entries, branch_entries

    seed, synced, main_head, main_entries, branch_entries = asyncio.run(run())

    assert main_head == seed
    assert fake.branch_refs[(REPO, "pw/sync-docs-1")] == synced
    assert _blobs(main_entries) == {"AGENTS.md": git_blob_sha("a")}
    assert _blobs(branch_entries) == {"AGENTS.md": git_blob_sha("new")}
    assert fake.commits[-1]["branch"] == "pw/sync-docs-1"


def test_creating_an_existing_branch_raises():
    fake = FakeGithubClient()
    asyncio.run(fake.create_branch("tok", REPO, "pw/sync-docs-1", "fake-head-0"))

    with pytest.raises(GithubBranchMovedError):
        asyncio.run(fake.create_branch("tok", REPO, "pw/sync-docs-1", "fake-head-0"))


def test_pull_requests_are_numbered_and_found_by_prefix():
    fake = FakeGithubClient()

    async def run():
        first = await fake.create_pull_request("tok", REPO, "feature/x", "main", "t1", "b1")
        second = await fake.create_pull_request("tok", REPO, "pw/sync-docs-1", "main", "t2", "b2")
        found = await fake.find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")
        missing = await fake.find_open_pull_request("tok", REPO, "release/", "main")
        other_base = await fake.find_open_pull_request("tok", REPO, "pw/sync-docs-", "develop")
        await fake.update_pull_request("tok", REPO, 2, "b2 updated")
        assert other_base is None
        return first, second, found, missing

    first, second, found, missing = asyncio.run(run())

    assert first["number"] == 1 and second["number"] == 2
    assert second == {
        "number": 2,
        "html_url": f"https://github.com/{REPO}/pull/2",
        "head": "pw/sync-docs-1",
    }
    assert found == second
    assert missing is None
    assert fake.pull_requests[1]["body"] == "b2 updated"
    assert fake.pull_requests[1]["state"] == "open"
    assert fake.pull_requests[1]["base"] == "main"


def test_fail_pr_status_raises_with_that_status():
    fake = FakeGithubClient()
    fake.fail_pr_status = 403

    with pytest.raises(GithubWriteError) as excinfo:
        asyncio.run(fake.create_pull_request("tok", REPO, "pw/sync-docs-1", "main", "t", "b"))
    assert excinfo.value.status_code == 403
    assert fake.pull_requests == []


def test_a_fork_pull_request_is_not_found():
    fake = FakeGithubClient()
    asyncio.run(fake.create_pull_request("tok", REPO, "pw/sync-docs-1", "main", "t", "b"))
    fake.pull_requests[0]["head_repo"] = "mallory/app"

    assert asyncio.run(fake.find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")) is None


def test_a_commit_to_an_unknown_branch_is_404():
    fake = FakeGithubClient()

    with pytest.raises(GithubWriteError) as excinfo:
        asyncio.run(
            fake.create_commit_with_files(
                "tok", REPO, "pw/sync-docs-1", [SeedFile("AGENTS.md", "a")], "sync"
            )
        )
    assert excinfo.value.status_code == 404
    assert fake.commits == []


def test_branch_protection_applies_to_the_default_branch_only():
    fake = FakeGithubClient()
    fake.protected_branches.add(REPO)

    async def run():
        await fake.create_branch("tok", REPO, "pw/sync-docs-1", "fake-head-0")
        return await fake.create_commit_with_files(
            "tok", REPO, "pw/sync-docs-1", [SeedFile("AGENTS.md", "a")], "sync"
        )

    assert asyncio.run(run()) == fake.branch_refs[(REPO, "pw/sync-docs-1")]
    with pytest.raises(GithubRefUpdateRejectedError):
        asyncio.run(
            fake.create_commit_with_files("tok", REPO, "main", [SeedFile("AGENTS.md", "a")], "s")
        )
