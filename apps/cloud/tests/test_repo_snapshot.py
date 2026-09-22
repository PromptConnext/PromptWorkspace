"""The deterministic repository snapshot (plan 0027 M1).

Everything here is a pure function of a path list, plus one async function
that sequences reads through the fake GitHub client. The security-relevant
case is the first group: a secret-shaped file must never be listed, excerpted
or fetched at all — a filter that only kept it out of the excerpts would still
leak its *name* into a prompt and its content into a fetch log.
"""

from __future__ import annotations

import asyncio

import pytest

from app.imports.snapshot import (
    EXCERPT_FILE_CHARS,
    EXCERPT_TOTAL_CHARS,
    MAX_PATHS,
    build_snapshot,
    detect_stack,
    excerpt_paths,
    filter_paths,
    indexable_code_paths,
    is_secret_path,
    summarize_tree,
)
from app.integrations.github import FakeGithubClient

REPO = "acme/storyapp"


@pytest.mark.parametrize(
    "path",
    [
        ".env",
        ".env.production",
        "config/.env.local",
        "deploy/prod.env",
        "certs/server.pem",
        "certs/server.key",
        "keys/id_rsa",
        "keys/id_ed25519.pub",
        ".npmrc",
        "infra/terraform.tfstate",
        "infra/prod.tfvars",
        "config/credentials.json",
        "ops/service-account-prod.json",
        "SECRETS.yaml",
    ],
)
def test_secret_shaped_files_are_excluded(path: str):
    assert is_secret_path(path)
    assert filter_paths([path, "src/app.py"]) == ["src/app.py"]


@pytest.mark.parametrize(
    "path",
    [
        "node_modules/react/index.js",
        "web/node_modules/x/y.js",
        "dist/bundle.js",
        ".venv/lib/site.py",
        "vendor/github.com/pkg/errors/errors.go",
        "app/__pycache__/main.cpython-312.pyc",
        "public/logo.png",
        "fonts/inter.woff2",
    ],
)
def test_vendored_build_and_binary_paths_are_excluded(path: str):
    assert filter_paths([path]) == []


def test_ordinary_source_survives_the_filter():
    paths = ["src/env/config.ts", "README.md", "app/keyboard.py", ".github/workflows/ci.yml"]
    assert filter_paths(paths) == sorted(paths)


def test_tree_summary_counts_two_levels_and_root_files():
    summary = summarize_tree(["README.md", "src/a.py", "src/api/b.py", "src/api/c.py"])
    lines = summary.splitlines()
    assert "(root) 1 file" in lines
    assert "src/ 3 files" in lines
    assert "  src/api/ 2 files" in lines


def test_tree_summary_is_capped():
    paths = [f"d{i:04d}/f.py" for i in range(50)]
    summary = summarize_tree(paths, max_dirs=10)
    assert summary.splitlines()[-1] == "... (40 more directories)"


def test_stack_comes_from_root_manifests_first():
    stack = detect_stack(["package.json", "src/index.ts", "src/b.ts", "scripts/x.py"])
    assert stack.runtime == "node"
    assert stack.manifests == ["package.json"]
    assert stack.languages[0] == "TypeScript"


def test_nested_manifest_does_not_decide_the_runtime():
    stack = detect_stack(["tools/package.json", "main.go", "go.mod"])
    assert stack.runtime == "go"
    assert stack.manifests == ["go.mod"]


def test_stack_falls_back_to_the_dominant_language():
    assert detect_stack(["lib/a.rb", "lib/b.rb"]).runtime == "ruby"
    assert detect_stack(["notes.txt"]).runtime is None


def test_excerpts_follow_priority_order_and_stay_at_root():
    paths = [
        ".github/workflows/ci.yml",
        "Dockerfile",
        "package.json",
        "README.md",
        "fixtures/package.json",
    ]
    assert excerpt_paths(paths) == [
        "README.md",
        "package.json",
        "Dockerfile",
        ".github/workflows/ci.yml",
    ]


def _fake_repo(files: dict[str, str], extra_paths: list[str] = ()) -> FakeGithubClient:
    fake = FakeGithubClient()
    fake.branch_heads[REPO] = "abc123"
    fake.trees[REPO] = [*files, *extra_paths]
    for path, content in files.items():
        fake.set_file(REPO, path, "abc123", content)
    return fake


def test_build_snapshot_pins_the_head_and_never_fetches_a_secret():
    fake = _fake_repo(
        {"README.md": "# Story app", "package.json": '{"name": "storyapp"}'},
        extra_paths=[".env", "certs/prod.key", "src/index.ts"],
    )
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    assert snapshot.commit_sha == "abc123"
    assert snapshot.default_branch == "main"
    assert [e.path for e in snapshot.excerpts] == ["README.md", "package.json"]
    assert snapshot.stack.runtime == "node"
    assert ".env" not in snapshot.paths
    assert "certs/prod.key" not in snapshot.paths
    assert ".env" not in snapshot.tree_summary
    fetched = {path for _repo, path, _sha in fake.fetched_files}
    assert fetched == {"README.md", "package.json"}
    assert all(sha == "abc123" for _repo, _path, sha in fake.fetched_files)


def test_build_snapshot_caps_each_excerpt_and_the_total():
    big = "x" * (EXCERPT_FILE_CHARS * 2)
    files = {
        "README.md": big,
        "AGENTS.md": big,
        "CLAUDE.md": big,
        "package.json": big,
        "pyproject.toml": big,
    }
    snapshot = asyncio.run(build_snapshot(_fake_repo(files), "tok", REPO, "main"))

    assert all(len(e.content) <= EXCERPT_FILE_CHARS for e in snapshot.excerpts)
    assert all(e.truncated for e in snapshot.excerpts)
    assert sum(len(e.content) for e in snapshot.excerpts) <= EXCERPT_TOTAL_CHARS


def test_build_snapshot_reports_a_truncated_tree_and_caps_paths():
    fake = _fake_repo({}, extra_paths=[f"src/m{i:05d}.py" for i in range(MAX_PATHS + 50)])
    fake.tree_truncated = True
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    assert snapshot.tree_truncated is True
    assert snapshot.file_count == MAX_PATHS + 50
    assert len(snapshot.paths) == MAX_PATHS


def test_indexable_code_paths_drops_lockfiles_and_caps():
    paths = ["package-lock.json", "yarn.lock", "app.min.js", "src/a.ts", "src/b.ts", ".env"]
    assert indexable_code_paths(paths, limit=10) == ["src/a.ts", "src/b.ts"]
    assert indexable_code_paths(paths, limit=1) == ["src/a.ts"]
