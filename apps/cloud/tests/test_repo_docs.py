from app.integrations.repo_docs import DOC_PATHS, changed_files, classify_docs, git_blob_sha
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
