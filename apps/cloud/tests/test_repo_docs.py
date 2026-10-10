from app.integrations.repo_docs import (
    DOC_PATHS,
    changed_files,
    classify_docs,
    classify_with_pull_request,
    files_differing_from,
    git_blob_sha,
    reverting_files,
)
from app.integrations.repo_seed import SeedFile


def test_git_blob_sha_matches_git():
    # `printf 'hello\n' | git hash-object --stdin`
    assert git_blob_sha("hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"
    # git hashes bytes: a multibyte character counts as its UTF-8 length.
    # `printf 'ก' | git hash-object --stdin`
    assert git_blob_sha("ก") == "7fd735ce7bc5bc5be1f7592df7dad8fc56ace878"


def test_classify_current_out_of_date_and_missing():
    files = [
        SeedFile("AGENTS.md", "a"),
        SeedFile("docs/scope.md", "b"),
        SeedFile("docs/architecture.md", "c"),
    ]
    tree = {"AGENTS.md": git_blob_sha("a"), "docs/scope.md": git_blob_sha("OLD")}
    states = {s.path: s.state for s in classify_docs(files, tree)}
    assert states == {
        "AGENTS.md": "current",
        "docs/scope.md": "out_of_date",
        "docs/architecture.md": "missing",
    }


def test_deployment_files_are_never_in_the_set():
    files = [
        SeedFile(".github/workflows/deploy.yml", "x"),
        SeedFile("site/index.html", "y"),
        SeedFile("docs/deployment.md", "z"),
        SeedFile("AGENTS.md", "a"),
    ]
    paths = [s.path for s in classify_docs(files, {})]
    assert paths == ["AGENTS.md"]
    assert ".github/workflows/deploy.yml" not in DOC_PATHS
    assert "site/index.html" not in DOC_PATHS and "docs/deployment.md" not in DOC_PATHS


def test_changed_files_returns_only_what_differs():
    files = [SeedFile("AGENTS.md", "a"), SeedFile("docs/scope.md", "b")]
    states = classify_docs(files, {"AGENTS.md": git_blob_sha("a")})
    assert [f.path for f in changed_files(files, states)] == ["docs/scope.md"]


def test_with_an_open_pull_request_both_trees_decide_the_state():
    files = [
        SeedFile("AGENTS.md", "a"),
        SeedFile("docs/scope.md", "b"),
        SeedFile("docs/architecture.md", "c"),
        SeedFile("docs/tasks.md", "d"),
        SeedFile("README.md", "r"),
        SeedFile("docs/conventions.md", "k"),
    ]
    main = {
        "AGENTS.md": git_blob_sha("a"),
        "docs/scope.md": git_blob_sha("OLD"),
        "README.md": git_blob_sha("r"),
    }
    pr_branch = {
        "AGENTS.md": git_blob_sha("a"),
        "docs/scope.md": git_blob_sha("b"),
        "docs/architecture.md": git_blob_sha("c"),
        "docs/tasks.md": git_blob_sha("stale in the branch"),
        # Matches main, but the branch holds an older sync: a revert.
        "README.md": git_blob_sha("synced earlier"),
    }
    states = classify_with_pull_request(files, main, pr_branch)
    assert {s.path: s.state for s in states} == {
        "AGENTS.md": "current",
        "docs/scope.md": "in_pull_request",
        "docs/architecture.md": "in_pull_request",
        "docs/tasks.md": "out_of_date",
        "README.md": "out_of_date",
        "docs/conventions.md": "missing",
    }
    changed = changed_files(files, states)
    assert [f.path for f in changed] == ["docs/tasks.md", "README.md", "docs/conventions.md"]
    assert [f.path for f in reverting_files(changed, main)] == ["README.md"]
    assert [f.path for f in files_differing_from(files, main)] == [
        "docs/scope.md",
        "docs/architecture.md",
        "docs/tasks.md",
        "docs/conventions.md",
    ]
