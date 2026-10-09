"""The deterministic repository snapshot (plan 0027 M1).

Everything here is a pure function of a path list, plus one async function
that sequences reads through the fake GitHub client. The security-relevant
case is the first group: a secret-shaped file must never be listed, excerpted
or fetched at all — a filter that only kept it out of the excerpts would still
leak its *name* into a prompt and its content into a fetch log.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.imports.snapshot import (
    CODE_INDEX_MAX_FILES,
    EXCERPT_FILE_CHARS,
    EXCERPT_TOTAL_CHARS,
    MAX_PATHS,
    MAX_SKIPPED,
    OCCURRENCE_FILES_PER_TOKEN,
    OCCURRENCE_MAX_TOKENS,
    OUTLINE_MAX_FILES,
    build_snapshot,
    detect_stack,
    excerpt_paths,
    filter_paths,
    indexable_code_paths,
    is_secret_path,
    is_test_path,
    occurrences_text,
    outline_paths,
    outline_source,
    quoted_strings,
    redact_secrets,
    repo_occurrences,
    summarize_tests,
    summarize_tree,
)
from app.integrations.github import FakeGithubClient, GithubWriteError
from app.models.schemas import RepoSnapshot

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
        # Security review of plan 0027.
        ".envrc",
        "infra/prod.tfvars.json",
        "keys/putty.ppk",
        "apple/AuthKey_ABC123.p8",
        "krb/service.keytab",
        "vpn/office.ovpn",
        "kubeconfig",
        ".kube/config",
        "home/ops/.kube/config",
        ".docker/config.json",
        ".pgpass",
        "wp-config.php",
        "config/database.yml",
        "src/main/resources/application.properties",
        "src/main/resources/application-prod.properties",
        "appsettings.json",
        "Api/appsettings.Development.json",
        "local.settings.json",
        "serviceAccountKey.json",
        "firebase/myapp-firebase-adminsdk-x1y2z.json",
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
    assert fetched == {"README.md", "package.json", "src/index.ts"}
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


@pytest.mark.parametrize(
    "path", ["config.ts", "src/config/index.js", "database.yml", "docs/kube/config.md"]
)
def test_innocent_names_next_to_the_multi_segment_globs_survive(path: str):
    assert not is_secret_path(path)


@pytest.mark.parametrize(
    ("text", "leaked"),
    [
        ("DB_PASSWORD=hunter2", "hunter2"),
        ("password: 'hunter2'", "hunter2"),
        ('"apiKey": "k-123456"', "k-123456"),
        ("STRIPE_SECRET = sk_live_abc", "sk_live_abc"),
        ("private_key: -----BEGIN", "-----BEGIN"),
        ("AWS_CREDENTIALS=abc123", "abc123"),
        ("clone with ghp_" + "a" * 36, "ghp_" + "a" * 36),
        ("token github_pat_" + "b" * 40, "github_pat_" + "b" * 40),
        ("id AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"),
        ("openai sk-" + "c" * 32, "sk-" + "c" * 32),
        ("slack xoxb-123456789012-abc", "xoxb-123456789012-abc"),
        ("slack xoxp-123456789012-abc", "xoxp-123456789012-abc"),
        # Verification review of plan 0027 (N2).
        ("DATABASE_URL=postgres://admin:s3cr3t@db.internal/app", "s3cr3t"),
        ("see https://deploy:hunter2@git.example.com/repo.git", "hunter2"),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3\n-----END RSA PRIVATE KEY-----",
            "MIIEpAIBAAKCAQEA0Z3",
        ),
        (
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n(no end marker)",
            "b3BlbnNzaC1rZXk",
        ),
        ("oauth gho_" + "d" * 36, "gho_" + "d" * 36),
        ("user token ghu_" + "e" * 36, "ghu_" + "e" * 36),
        ("server ghs_" + "f" * 36, "ghs_" + "f" * 36),
        ("refresh ghr_" + "g" * 36, "ghr_" + "g" * 36),
        ("stripe sk_live_" + "h" * 24, "sk_live_" + "h" * 24),
        ("stripe sk_test_" + "i" * 24, "sk_test_" + "i" * 24),
        ("maps AIza" + "j" * 35, "AIza" + "j" * 35),
        ("sts ASIAABCDEFGHIJKLMNOP", "ASIAABCDEFGHIJKLMNOP"),
        ("slack xoxa-123456789012-abc", "xoxa-123456789012-abc"),
        ("slack xoxr-123456789012-abc", "xoxr-123456789012-abc"),
        (
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
        ),
        ('password = "correct horse battery staple"', "horse battery staple"),
        ("client_secret: 'two words here'", "words here"),
        ('DB_PASSWORD="unterminated value with spaces', "value with spaces"),
    ],
)
def test_secret_values_are_redacted(text: str, leaked: str):
    redacted = redact_secrets(text)
    assert leaked not in redacted
    assert "***" in redacted


def test_redaction_leaves_ordinary_text_alone():
    text = "# App\n\nBuilt with scikit-learn and sk-learn docs; run `npm start`."
    assert redact_secrets(text) == text


def test_build_snapshot_redacts_excerpts():
    fake = _fake_repo({"README.md": "# App\n\nexport API_KEY=abcdef123\n"})
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))
    assert snapshot.excerpts[0].content == "# App\n\nexport API_KEY=***\n"


def test_indexable_code_paths_spends_the_cap_on_source_first():
    docs = [f"a-docs/page{i:04d}.md" for i in range(CODE_INDEX_MAX_FILES)]
    selected = indexable_code_paths([*docs, "src/server.ts", "src/db.py"], CODE_INDEX_MAX_FILES)
    assert selected[:2] == ["src/db.py", "src/server.ts"]
    assert len(selected) == CODE_INDEX_MAX_FILES


def test_quoted_values_keep_their_quotes_and_nothing_else():
    assert redact_secrets('password = "a b c" # note') == 'password = "***" # note'
    assert redact_secrets("postgres://admin:pw@db/x") == "postgres://admin:***@db/x"


@pytest.mark.parametrize(
    "text",
    [
        "x" * 200_000,
        "pass" * 50_000,
        "token" * 40_000 + "=",
        "a://" * 50_000,
        "ab:" * 60_000 + "@",
        "-----BEGIN PRIVATE KEY-----" * 8_000,
        "Bearer " * 30_000,
        'password="' * 30_000,
        "ghp_" * 50_000,
    ],
    ids=["word-run", "keyword-run", "keyword-run-then-eq", "scheme-run", "userinfo-run",
         "pem-begins", "bearer-run", "open-quotes", "prefix-run"],
)
def test_redaction_is_linear_on_pathological_input(text: str):
    """Measured ~0.1s at most for each of these; a quadratic expression takes
    minutes on the same input, so the bound is generous without being blind."""
    started = time.perf_counter()
    redact_secrets(text)
    assert time.perf_counter() - started < 2.0


# --------------------------------------------------------------------------- #
# Source outlines (plan 0028)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "path",
    [
        "tests/test_api.py",
        "src/__tests__/App.tsx",
        "src/app.test.ts",
        "src/app.spec.js",
        "pkg/server_test.go",
        "conftest.py",
        "e2e/login.ts",
    ],
)
def test_test_paths_are_recognised(path: str):
    assert is_test_path(path)


@pytest.mark.parametrize("path", ["src/testing_utils.py", "src/contest.ts", "app/latest.py"])
def test_names_that_merely_contain_test_are_not_tests(path: str):
    assert not is_test_path(path)


def test_outline_paths_prefers_entry_points_and_skips_tests_and_non_source():
    paths = [
        "README.md",
        "src/zeta.ts",
        "src/index.ts",
        "src/app.test.ts",
        "src/types.d.ts",
        "public/bundle.min.js",
        "docs/guide.md",
    ]
    assert outline_paths(paths) == ["src/index.ts", "src/zeta.ts"]


def test_outline_paths_spreads_a_monorepo_across_packages():
    paths = [f"packages/a/src/m{i:03d}.ts" for i in range(200)] + [
        "packages/b/src/index.ts",
        "packages/c/main.py",
    ]
    chosen = outline_paths(paths, limit=10)
    assert len(chosen) == 10
    assert "packages/b/src/index.ts" in chosen
    assert "packages/c/main.py" in chosen


def test_outline_paths_is_capped_and_deterministic():
    paths = [f"src/mod{i:04d}.py" for i in range(500)]
    first = outline_paths(paths)
    assert len(first) == OUTLINE_MAX_FILES
    assert outline_paths(list(reversed(paths))) == first


def test_outline_source_keeps_signatures_and_markers_with_line_numbers():
    source = "\n".join(
        [
            "import express from 'express'",
            "",
            "export async function createStory(req, res) {",
            "  const x = 1",
            "  // TODO: validate the title",
            "}",
            "@app.get('/stories')",
            "def list_stories():",
            "    raise NotImplementedError",
            "class StoryRepo:",
        ]
    )
    assert outline_source(source) == "\n".join(
        [
            "[10 lines]",
            "3: export async function createStory(req, res) {",
            "5: // TODO: validate the title",
            "7: @app.get('/stories')",
            "8: def list_stories():",
            "9: raise NotImplementedError",
            "10: class StoryRepo:",
        ]
    )


def test_outline_source_reads_sql_tables_and_other_languages():
    source = "CREATE TABLE stories (id uuid);\nfunc Serve() {}\npub fn run() {}\nfun main() {}"
    kept = outline_source(source).splitlines()[1:]
    assert [line.split(": ", 1)[0] for line in kept] == ["1", "2", "3", "4"]


def test_outline_source_is_empty_for_a_file_with_no_declarations():
    assert outline_source("x = 1\ny = 2\n") == ""


def test_outline_source_does_not_flag_an_ordinary_todo_variable():
    assert outline_source("const todo = load()\nrender(todoList)\n") == ""


@pytest.mark.parametrize(
    "content",
    [
        "def f(" + "a" * 200_000,
        "x = 1\n" * 100_000,
        "@" + "a." * 100_000,
        "export " + " " * 100_000 + "function f() {}",
    ],
)
def test_outline_source_is_bounded_on_pathological_input(content: str):
    started = time.perf_counter()
    outline = outline_source(content)
    assert time.perf_counter() - started < 2.0
    assert all(len(line) <= 220 for line in outline.splitlines())


def test_summarize_tests_counts_test_files_by_top_level_directory():
    paths = ["tests/test_a.py", "tests/test_b.py", "src/app.test.ts", "src/app.ts", "README.md"]
    assert summarize_tests(paths) == "3 test files: src/ 1, tests/ 2"


def test_summarize_tests_says_when_there_are_none():
    assert summarize_tests(["src/app.ts", "README.md"]) == "no test files found"


def test_build_snapshot_outlines_source_files_and_summarises_tests():
    fake = _fake_repo(
        {
            "package.json": "{}",
            "src/index.ts": "export function start() {}\n// TODO: graceful shutdown\n",
            "src/util.ts": "const a = 1\n",
            "tests/start.test.ts": "describe('x', () => {})\n",
        }
    )
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    assert [o.path for o in snapshot.source_outlines] == ["src/index.ts"]
    assert snapshot.source_outlines[0].content == (
        "[2 lines]\n1: export function start() {}\n2: // TODO: graceful shutdown"
    )
    assert snapshot.test_summary == "1 test file: tests/ 1"
    # Outlines are not excerpts: the stack judge reads excerpts only.
    assert "src/index.ts" not in [e.path for e in snapshot.excerpts]


def test_build_snapshot_redacts_source_before_outlining():
    key = "sk-" + "a" * 40
    fake = _fake_repo({"src/config.ts": f'const API_KEY = "{key}"  // TODO rotate\n'})
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    stored = snapshot.source_outlines[0].content
    assert key not in stored
    assert 'API_KEY = "***"' in stored


def test_build_snapshot_caps_each_outline_and_the_total():
    body = "\n".join(f"def f{i}(): pass" for i in range(2_000))
    fake = _fake_repo({f"src/m{i:02d}/main.py": body for i in range(40)})
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    assert all(len(o.content) <= 1_500 for o in snapshot.source_outlines)
    assert all(o.truncated for o in snapshot.source_outlines)
    assert sum(len(o.content) for o in snapshot.source_outlines) <= 24_000


def test_build_snapshot_skips_a_source_file_that_fails_to_fetch():
    fake = _fake_repo({"src/a.py": "def a(): pass\n", "src/b.py": "def b(): pass\n"})
    real_fetch = fake.fetch_file_content

    async def flaky(token, repo, path, sha):
        if path == "src/a.py":
            raise GithubWriteError("boom", status_code=502)
        return await real_fetch(token, repo, path, sha)

    fake.fetch_file_content = flaky
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))
    assert [o.path for o in snapshot.source_outlines] == ["src/b.py"]


def test_build_snapshot_of_a_repository_with_no_source():
    snapshot = asyncio.run(build_snapshot(_fake_repo({"README.md": "# Docs"}), "tok", REPO, "main"))
    assert snapshot.source_outlines == []
    assert snapshot.test_summary == "no test files found"


def test_a_snapshot_stored_before_outlines_still_validates():
    old = {"commit_sha": "abc123", "default_branch": "main", "excerpts": [], "paths": []}
    snapshot = RepoSnapshot.model_validate(old)
    assert snapshot.source_outlines == []
    assert snapshot.test_summary == ""


# --- which files the analysis skipped (task 4.5, finding #6) -----------------


def test_52_of_53_files_read_lists_the_skipped_file_and_why():
    sources = [f"src/m{i:02d}.ts" for i in range(52)]
    fake = _fake_repo({}, extra_paths=[*sources, "certs/server.pem"])
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    assert snapshot.file_count == 52
    assert snapshot.skipped_count == 1
    assert [(s.path, s.reason) for s in snapshot.skipped] == [("certs/server.pem", "secret")]
    # Naming a skipped secret-shaped file is not reading it.
    assert "certs/server.pem" not in {path for _repo, path, _sha in fake.fetched_files}


def test_skipped_files_say_why_and_a_vendored_directory_is_one_entry():
    fake = _fake_repo(
        {},
        extra_paths=[
            "src/index.ts",
            "public/logo.png",
            ".env",
            "node_modules/react/index.js",
            "node_modules/react/package.json",
            "web/dist/app.js",
        ],
    )
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    assert snapshot.file_count == 1
    assert snapshot.skipped_count == 5
    assert [(s.path, s.reason) for s in snapshot.skipped] == [
        (".env", "secret"),
        ("node_modules/", "vendored"),
        ("public/logo.png", "binary"),
        ("web/dist/", "vendored"),
    ]


def test_the_skipped_list_is_capped_but_the_count_is_not():
    images = [f"img/{i:04d}.png" for i in range(MAX_SKIPPED + 25)]
    fake = _fake_repo({}, extra_paths=["src/index.ts", *images])
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    assert len(snapshot.skipped) == MAX_SKIPPED
    assert snapshot.skipped_count == MAX_SKIPPED + 25


# --- env template names (task 4.3, finding #56) --------------------------------


def test_env_template_names_are_listed_without_contents():
    fake = _fake_repo(
        {"README.md": "# Story app"},
        extra_paths=[
            ".env",
            ".env.local",
            ".env.example",
            "web/.env.sample",
            "api/.env.template",
            "node_modules/pkg/.env.example",
            "src/index.ts",
        ],
    )
    fake.set_file(REPO, ".env.example", "abc123", "API_KEY=sk-live-should-never-be-read")
    snapshot = asyncio.run(build_snapshot(fake, "tok", REPO, "main"))

    # The names are listed, so a task can extend the file instead of adding it.
    for name in (".env.example", "web/.env.sample", "api/.env.template"):
        assert name in snapshot.paths
    # A real secret file is still neither listed nor read.
    assert ".env" not in snapshot.paths
    assert ".env.local" not in snapshot.paths
    assert "node_modules/pkg/.env.example" not in snapshot.paths
    # ...and no template's content is ever fetched, excerpted or outlined.
    fetched = {path for _repo, path, _sha in fake.fetched_files}
    assert not any(".env" in path for path in fetched)
    stored = snapshot.model_dump_json()
    assert "sk-live-should-never-be-read" not in stored
    # A listed name is not a skipped one; the real secrets still are.
    assert {s.path for s in snapshot.skipped} == {".env", ".env.local", "node_modules/"}
    assert snapshot.file_count == 5
    # Nor is a template embedded with the code: names only.
    assert ".env.example" not in indexable_code_paths(snapshot.paths, CODE_INDEX_MAX_FILES)


# --- where the specification's strings live (task 4.2, finding #54) ------------


def test_quoted_strings_are_distinct_in_order_and_skip_paths_and_apostrophes():
    spec = (
        'Rename every "ASSET GROW" to \u201cMarketing Studio\u201d. The `assetgrow` keys move; '
        "the user's data and the team's settings stay. Edit `src/App.tsx` and 'Asset Grow'. "
        'Also "asset grow" again, and "ok".'
    )
    assert quoted_strings(spec) == ["ASSET GROW", "Marketing Studio", "assetgrow"]
    assert quoted_strings(spec, limit=2) == ["ASSET GROW", "Marketing Studio"]


def test_the_segment_lists_the_files_that_contain_a_quoted_spec_string():
    files = {
        "index.html": "<title>ASSET GROW</title><meta content='ASSET GROW'>",
        "src/App.tsx": "<b>Asset Grow</b>",
        "src/lib/exporters.ts": "https://assetgrow.app/share",
        "src/lib/format.ts": "export const x = 1",
        ".env.example": "BRAND=ASSET GROW",
        "certs/server.pem": "ASSET GROW",
    }
    fake = _fake_repo(files)
    paths = [p for p in files if p != "certs/server.pem"]

    occurrences = asyncio.run(
        repo_occurrences(
            fake, "tok", REPO, "abc123", paths, ["ASSET GROW", "assetgrow", "Not There"]
        )
    )
    text = occurrences_text(occurrences)

    assert text.splitlines() == [
        '"ASSET GROW" is in 2 files: index.html (2), src/App.tsx (1)',
        '"assetgrow" is in 1 files: src/lib/exporters.ts (1)',
    ]
    # Read through the code-index filter: never a secret or an env template.
    fetched = {path for _repo, path, _sha in fake.fetched_files}
    assert ".env.example" not in fetched
    assert "certs/server.pem" not in fetched
    assert all(sha == "abc123" for _repo, _path, sha in fake.fetched_files)


def test_occurrences_are_capped_per_string_and_in_strings():
    files = {f"src/m{i:02d}.ts": "ACME" for i in range(OCCURRENCE_FILES_PER_TOKEN + 3)}
    files["src/brands.ts"] = " ".join(f"brand{i}" for i in range(OCCURRENCE_MAX_TOKENS + 2))
    strings = ["ACME", *(f"brand{i}" for i in range(OCCURRENCE_MAX_TOKENS + 2))]
    occurrences = asyncio.run(
        repo_occurrences(_fake_repo(files), "tok", REPO, "abc123", list(files), strings)
    )
    assert len(occurrences) == OCCURRENCE_MAX_TOKENS
    first = occurrences_text(occurrences).splitlines()[0]
    assert first.startswith(f'"ACME" is in {OCCURRENCE_FILES_PER_TOKEN + 3} files: ')
    assert first.endswith(", and 3 more files")


def test_no_quoted_strings_fetch_nothing():
    fake = _fake_repo({"src/a.ts": "x"})
    assert asyncio.run(repo_occurrences(fake, "tok", REPO, "abc123", ["src/a.ts"], [])) == []
    assert fake.fetched_files == []
