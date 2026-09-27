# Plan 0028 — Say what an imported codebase already does

**Date:** 2026-09-27 · **Status:** Proposed · **Builds on:** [plan 0027](0027-brownfield-repo-import.md) (M1–M3) · **ADR:** [0017](../decisions/0017-cloud-creates-project-repo-at-tech-review-exit.md) (2026-09-22 amendment), [0027](../decisions/0027-what-is-free.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Plan 0027 made an imported repository a planning input, but the input describes the repository's *shape* and not its *progress*. The snapshot reads a fixed list of files — the README, `AGENTS.md`, `CLAUDE.md`, an existing constitution, manifests, Dockerfiles, compose files and CI workflows — and no ordinary source file at all. The baseline the model writes from it therefore knows the stack, the directory layout and the conventions, and has nothing to go on when asked what the software already does. The `tasks` stage then breaks the plan down into work without any record of what exists, so a PRD that describes a feature the code already has can produce a task to build it again. The line plan 0027 added to the `plan` and `tasks` prompts ("plan changes against it … do not re-scaffold") stops the model from re-creating the project; it cannot stop it from re-creating a feature it was never told about.

This plan closes that gap in the cheapest place: the snapshot and the baseline. The snapshot gains a deterministic **source outline** — for up to 60 source files, the declaration lines (functions, classes, routes, types, tables) and the TODO/stub markers, each with its line number and the file's length — and a one-line **test summary**. The baseline template gains a **Current State** section, directly after Purpose, with two evidence-backed lists: *Implemented* and *Partial or Stubbed*, each entry citing a path. And the `plan` and `tasks` driver prompts gain one conditional line: nothing listed under Implemented is built again; it is changed or extended only where the specification asks, naming the path it touches.

Current State sits second in the template on purpose. The stages read the baseline through `_truncate_with_marker`, which keeps the head — 6,000 characters for `constitution` and `tasks`, 12,000 for `specify` and `plan` — so a section placed after Stack, Architecture and Conventions would be the first thing the `tasks` cap cut, and `tasks` is the stage that needs it most.

What this plan deliberately does not do: it adds no model call, no new table, no migration and no route. The outline is built without a model, in the same pure-function style as the rest of `app/imports/snapshot.py`, and the only model cost is a longer input to the one baseline run that already exists — up to 24,000 more characters, charged to the same ADR 0027 daily budget. It does not read issues, pull requests or commit history, and it does not reconcile generated tasks against the code after the fact or create tasks already marked done; those are the two larger options this plan was chosen over, and either can build on the Current State section later. It does not change the web client: the Planner's `CodebaseAnalysisPanel` already renders the baseline as Markdown, so the new section appears with no UI change, and the new snapshot fields reach the browser as extra JSON the TypeScript type simply does not name.

**Goal:** An imported project's codebase baseline states, with cited paths, what the code already implements and what is stubbed, and the `plan`/`tasks` stages stop generating work to build what is listed as implemented.

**Architecture:** `build_snapshot` fetches a round-robin selection of source files (entry points first, tests excluded, spread across top-level and second-level directories), redacts each, and keeps only signature and marker lines as a `RepoExcerpt` in a new `RepoSnapshot.source_outlines`; it also stores `RepoSnapshot.test_summary`. `codebase_baseline_user_content` feeds both to the existing baseline run inside the existing untrusted block; the template's new Current State section tells the model what to write; `driver_prompt` gains one line for `plan` and `tasks` on imported projects.

**Tech Stack:** Python ≥ 3.10, FastAPI, Pydantic v2, pytest; `apps/cloud` only.

**Spec:** this document (the design section above) and [plan 0027](0027-brownfield-repo-import.md) M1–M3, whose invariants it must keep.

## Global Constraints

- Scope is `apps/cloud` only. No change under `apps/web`, `apps/vscode`, `apps/mcp`, `apps/engine` or `packages/`.
- No new migration, table, column or route. `RepoSnapshot` is stored as jsonb in `pz_repo_analyses.snapshot`; new fields must default so rows written before this plan still validate.
- A secret-shaped path is never fetched (`is_excluded_path` runs before selection), and every fetched source file goes through `redact_secrets` **before** outlining.
- Every regular expression added must be linear in its input; each line is clipped to 200 characters before matching.
- New caps, exactly: `OUTLINE_MAX_FILES = 60`, `OUTLINE_FILE_CHARS = 1_500`, `OUTLINE_TOTAL_CHARS = 24_000`, `OUTLINE_FETCH_CONCURRENCY = 8`, `_OUTLINE_LINE_CHARS = 200`.
- Members get `source_outlines: []`, exactly as they get `excerpts: []` — outlines are verbatim source lines.
- A from-scratch project's prompts stay byte-identical (`test_scratch_project_prompts_are_unchanged` must keep passing).
- `app/deployments/stack_judge.py` reads `snapshot.excerpts` only and must not start reading outlines.
- Lint: `ruff check .` clean, line length 100. Commit style: `feat(cloud): …`, `test(cloud): …`, `docs(plans): …`.
- Run everything from `apps/cloud` with its virtualenv active (`source .venv/bin/activate`).

## Review Focus

1. **A monorepo whose source all sits under `packages/`** — a reader expects every package represented in the outline, not the first 60 files of `packages/a`. Pinned in Task 1 (`test_outline_paths_spreads_a_monorepo_across_packages`).
2. **A file of generated or minified code that passes the path filter** (one 200,000-character line, or 100,000 short lines) — expected to produce a bounded outline quickly, not a stalled analysis. Pinned in Task 1 (`test_outline_source_is_bounded_on_pathological_input`).
3. **An inline credential on a line the outline keeps** (`const API_KEY = "sk-…"  // TODO rotate`) — expected never to reach the stored snapshot or the prompt. Pinned in Task 2 (`test_build_snapshot_redacts_source_before_outlining`).
4. **An analysis stored before this plan** (no `source_outlines`, no `test_summary`, baseline without a Current State section) — expected to load, show and keep gating and feeding the stages exactly as before. Pinned in Task 2 (`test_a_snapshot_stored_before_outlines_still_validates`) and Task 4 (the conditional wording, `test_plan_and_tasks_are_told_not_to_rebuild_what_exists`).
5. **A long baseline whose later sections exceed the `tasks` stage's 6,000-character cap** — expected to still carry Current State into the `tasks` prompt. Pinned in Task 4 (`test_current_state_survives_the_tasks_cap`).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/cloud/app/imports/snapshot.py` | Modify | `is_test_path`, `outline_paths`, `outline_source`, `summarize_tests` (pure); `build_snapshot` fetches and stores outlines and the test summary |
| `apps/cloud/app/models/schemas.py` | Modify (`RepoSnapshot`, ~line 1271) | Two defaulted fields: `source_outlines`, `test_summary` |
| `apps/cloud/app/api/repo_analysis.py` | Modify (`_out`, ~line 68) | Withhold `source_outlines` from members alongside `excerpts` |
| `apps/cloud/app/generation/templates/codebase-baseline-template.md` | Modify | New `## Current State` section after Purpose |
| `apps/cloud/app/generation/prompts.py` | Modify | Baseline prompt/user content carry outlines and tests; `driver_prompt` line for `plan`/`tasks` |
| `apps/cloud/tests/test_repo_snapshot.py` | Modify | Pure-function and `build_snapshot` tests |
| `apps/cloud/tests/test_repo_analysis_api.py` | Modify | API member view, baseline prompt content, stage prompt line, cap survival |

---

### Task 1: Pure outline functions in the snapshot module

**Files:**
- Modify: `apps/cloud/app/imports/snapshot.py` (constants after `CODE_INDEX_MAX_FILES`; functions after `excerpt_paths`)
- Test: `apps/cloud/tests/test_repo_snapshot.py`

**Interfaces:**
- Consumes: `_LANGUAGE_BY_EXTENSION` (existing, same module).
- Produces:
  - `OUTLINE_MAX_FILES: int = 60`, `OUTLINE_FILE_CHARS: int = 1_500`, `OUTLINE_TOTAL_CHARS: int = 24_000`, `OUTLINE_FETCH_CONCURRENCY: int = 8`
  - `is_test_path(path: str) -> bool`
  - `outline_paths(paths: list[str], limit: int = OUTLINE_MAX_FILES) -> list[str]`
  - `outline_source(content: str) -> str` — `""` when nothing is kept, else `"[N lines]\n<lineno>: <text>\n…"`
  - `summarize_tests(paths: list[str]) -> str`

- [ ] **Step 1: Write the failing tests**

Add to the import block of `tests/test_repo_snapshot.py`:

```python
from app.imports.snapshot import (
    CODE_INDEX_MAX_FILES,
    EXCERPT_FILE_CHARS,
    EXCERPT_TOTAL_CHARS,
    MAX_PATHS,
    OUTLINE_MAX_FILES,
    build_snapshot,
    detect_stack,
    excerpt_paths,
    filter_paths,
    indexable_code_paths,
    is_secret_path,
    is_test_path,
    outline_paths,
    outline_source,
    redact_secrets,
    summarize_tests,
    summarize_tree,
)
```

Append:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_repo_snapshot.py -v`
Expected: collection error, `ImportError: cannot import name 'OUTLINE_MAX_FILES' from 'app.imports.snapshot'`.

- [ ] **Step 3: Implement**

In `app/imports/snapshot.py`, after `CODE_INDEX_MAX_FILES = 500`:

```python
# Source outlines (plan 0028): the declaration and TODO/stub lines of a
# spread-out selection of source files, so the baseline can say what the code
# already does rather than only how it is laid out. Fetched with bounded
# concurrency — 60 sequential GitHub reads would add seconds to every analysis.
OUTLINE_MAX_FILES = 60
OUTLINE_FILE_CHARS = 1_500
OUTLINE_TOTAL_CHARS = 24_000
OUTLINE_FETCH_CONCURRENCY = 8
# Every line is clipped before it is matched, which is what keeps a minified
# bundle that slipped past the filter from making any expression below slow.
_OUTLINE_LINE_CHARS = 200

_TEST_DIRS = frozenset({"test", "tests", "__tests__", "spec", "specs", "e2e"})
_OUTLINE_SKIP_SUFFIXES = (".min.js", ".min.css", ".map", ".d.ts")
# A file with one of these stems is where a module says what it exposes —
# outlined before its siblings.
_OUTLINE_ENTRY_STEMS = frozenset(
    {
        "main", "index", "app", "server", "cli", "__main__", "manage", "urls",
        "routes", "router", "api", "models", "schema", "schemas", "handlers",
        "views", "controllers",
    }
)  # fmt: skip

# A declaration: matched with `.match` against a stripped, clipped line. One
# optional prefix per keyword, each ending in a word, so no two whitespace
# runs can compete for the same characters.
_OUTLINE_SIGNATURE = re.compile(
    r"(?:export\s+(?:default\s+)?)?(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?"
    r"(?:(?:def|class|function|interface|type|enum|struct|trait|impl|func|fun|fn|module"
    r"|public|private|protected|internal|create\s+(?:table|view|function))\b"
    r"|const\s+\w+\s*=\s*(?:async\s*)?\(|@[\w.]+\()",
    re.IGNORECASE,
)
# A stub or unfinished-work marker. Case-sensitive on purpose: a to-do app is
# full of `todo` identifiers, and none of them is a TODO.
_OUTLINE_MARKER = re.compile(
    r"\b(?:TODO|FIXME|XXX|HACK)\b|NotImplemented|unimplemented!|todo!\(|[Nn]ot implemented"
)
```

After `excerpt_paths`:

```python
def is_test_path(path: str) -> bool:
    parts = path.lower().split("/")
    if any(part in _TEST_DIRS for part in parts[:-1]):
        return True
    name = parts[-1]
    stem = name.split(".", 1)[0]
    return (
        stem.startswith("test_")
        or stem.endswith(("_test", "_spec"))
        or stem == "conftest"
        or ".test." in name
        or ".spec." in name
    )


def _outline_group(path: str) -> str:
    """The bucket a path competes in for the outline cap: its first two
    directories when it has them, so `packages/a` and `packages/b` of a
    monorepo each get a share instead of `packages/` getting one."""
    parts = path.split("/")
    if len(parts) == 1:
        return "(root)"
    if len(parts) >= 3:
        return "/".join(parts[:2])
    return parts[0]


def _outline_rank(path: str) -> tuple[bool, int, str]:
    stem = posixpath.basename(path).split(".", 1)[0].lower()
    return (stem not in _OUTLINE_ENTRY_STEMS, path.count("/"), path)


def outline_paths(paths: list[str], limit: int = OUTLINE_MAX_FILES) -> list[str]:
    """Source files to outline, round-robin across `_outline_group` buckets,
    entry points and shallow files first within each. Deterministic in its
    input *set*: the order `paths` arrives in does not matter."""
    groups: dict[str, list[str]] = {}
    for path in paths:
        name = posixpath.basename(path).lower()
        if posixpath.splitext(name)[1] not in _LANGUAGE_BY_EXTENSION:
            continue
        if name.endswith(_OUTLINE_SKIP_SUFFIXES) or is_test_path(path):
            continue
        groups.setdefault(_outline_group(path), []).append(path)
    queues = [sorted(groups[key], key=_outline_rank) for key in sorted(groups)]
    chosen: list[str] = []
    depth = 0
    while len(chosen) < limit and any(depth < len(queue) for queue in queues):
        for queue in queues:
            if depth < len(queue) and len(chosen) < limit:
                chosen.append(queue[depth])
        depth += 1
    return chosen


def outline_source(content: str) -> str:
    """The declaration and marker lines of one source file, numbered, under a
    `[N lines]` header — the file's length is itself a signal (a 12-line
    module with one `def` is a stub). `""` when nothing is worth keeping, so
    the caller can drop the file rather than store an empty outline. Redact
    before calling: a kept line is stored and prompted verbatim."""
    lines = content.splitlines()
    kept = []
    for number, raw in enumerate(lines, start=1):
        line = raw[:_OUTLINE_LINE_CHARS].strip()
        if line and (_OUTLINE_SIGNATURE.match(line) or _OUTLINE_MARKER.search(line)):
            kept.append(f"{number}: {line}")
    if not kept:
        return ""
    return f"[{len(lines)} lines]\n" + "\n".join(kept)


def summarize_tests(paths: list[str]) -> str:
    """How many source-language test files there are, by top-level
    directory — enough for the baseline to say which parts are covered."""
    tests = [
        p
        for p in paths
        if is_test_path(p) and posixpath.splitext(p)[1].lower() in _LANGUAGE_BY_EXTENSION
    ]
    if not tests:
        return "no test files found"
    by_dir = Counter(p.split("/", 1)[0] + "/" if "/" in p else "(root)" for p in tests)
    listed = ", ".join(f"{d} {n}" for d, n in sorted(by_dir.items()))
    return f"{len(tests)} test file{'s' if len(tests) != 1 else ''}: {listed}"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_repo_snapshot.py -v && ruff check app/imports/snapshot.py tests/test_repo_snapshot.py`
Expected: all PASS; ruff reports no errors. If `test_outline_source_does_not_flag_an_ordinary_todo_variable` fails, the marker expression has gained `re.IGNORECASE` — take it off.

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/imports/snapshot.py apps/cloud/tests/test_repo_snapshot.py
git commit -m "feat(cloud): outline source files and summarise tests for the repo snapshot"
```

---

### Task 2: Store outlines and the test summary on the snapshot

**Files:**
- Modify: `apps/cloud/app/models/schemas.py` (`RepoSnapshot`, after `paths`)
- Modify: `apps/cloud/app/imports/snapshot.py` (`import asyncio`; `build_snapshot`; new `_outline_sources`)
- Test: `apps/cloud/tests/test_repo_snapshot.py`

**Interfaces:**
- Consumes: `outline_paths`, `outline_source`, `summarize_tests`, the `OUTLINE_*` constants (Task 1); `redact_secrets`, `GithubWriteError`, `RepoExcerpt` (existing).
- Produces: `RepoSnapshot.source_outlines: list[RepoExcerpt]` (default `[]`), `RepoSnapshot.test_summary: str` (default `""`). `build_snapshot` fills both; the order of `source_outlines` equals `outline_paths(paths)` order with empty and failed files dropped.

- [ ] **Step 1: Write the failing tests**

Update the existing `test_build_snapshot_pins_the_head_and_never_fetches_a_secret` — `src/index.ts` is now fetched for its outline, and that is the point; the secret-path assertions stay:

```python
    fetched = {path for _repo, path, _sha in fake.fetched_files}
    assert fetched == {"README.md", "package.json", "src/index.ts"}
    assert all(sha == "abc123" for _repo, _path, sha in fake.fetched_files)
```

Add `from app.integrations.github import FakeGithubClient, GithubWriteError` and `from app.models.schemas import RepoSnapshot` to the imports, then append:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_repo_snapshot.py -v`
Expected: FAIL — `AttributeError: 'RepoSnapshot' object has no attribute 'source_outlines'` (or a validation error), and the updated fetched-set assertion fails with `src/index.ts` missing.

- [ ] **Step 3: Implement**

In `app/models/schemas.py`, inside `RepoSnapshot` after `paths`:

```python
    # Declaration and TODO/stub lines of up to 60 source files (plan 0028),
    # redacted, one RepoExcerpt per file whose outline is non-empty. Verbatim
    # source lines, so withheld from members exactly as `excerpts` is.
    source_outlines: list[RepoExcerpt] = Field(default_factory=list)
    # "N test files: tests/ 12, src/ 3" or "no test files found". Empty on a
    # snapshot stored before plan 0028.
    test_summary: str = ""
```

In `app/imports/snapshot.py`, add `import asyncio` to the imports, add this function before `build_snapshot`:

```python
async def _outline_sources(github_client, token: str, repo: str, sha: str, paths: list[str]):
    """Fetch `outline_paths(paths)` at most `OUTLINE_FETCH_CONCURRENCY` at a
    time and outline each. `gather` keeps input order, so the result is as
    deterministic as the selection; the total cap is spent in that order. A
    file that fails to fetch, or has nothing to outline, is left out."""
    semaphore = asyncio.Semaphore(OUTLINE_FETCH_CONCURRENCY)

    async def read(path: str) -> tuple[str, str | None]:
        async with semaphore:
            try:
                return path, await github_client.fetch_file_content(token, repo, path, sha)
            except GithubWriteError:
                return path, None

    results = await asyncio.gather(*(read(p) for p in outline_paths(paths)))
    outlines: list[RepoExcerpt] = []
    remaining = OUTLINE_TOTAL_CHARS
    for path, content in results:
        if remaining <= 0:
            break
        if content is None:
            continue
        outline = outline_source(redact_secrets(content))
        if not outline:
            continue
        clipped = outline[: min(OUTLINE_FILE_CHARS, remaining)]
        remaining -= len(clipped)
        outlines.append(
            RepoExcerpt(path=path, content=clipped, truncated=len(clipped) < len(outline))
        )
    return outlines
```

In `build_snapshot`, before the `return`:

```python
    source_outlines = await _outline_sources(github_client, token, repo, head_sha, paths)
```

and add to the `RepoSnapshot(...)` call:

```python
        source_outlines=source_outlines,
        test_summary=summarize_tests(paths),
```

Extend `build_snapshot`'s docstring with one sentence: "Then outlines a spread of source files (plan 0028) the same way: a failed fetch drops that file only."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_repo_snapshot.py tests/test_repo_import.py -v && ruff check app tests`
Expected: all PASS. `test_repo_import.py` is included because `create_repository` reads snapshots too; it must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/models/schemas.py apps/cloud/app/imports/snapshot.py apps/cloud/tests/test_repo_snapshot.py
git commit -m "feat(cloud): store source outlines and a test summary on the repo snapshot"
```

---

### Task 3: The baseline reads the outlines and writes a Current State section

**Files:**
- Modify: `apps/cloud/app/api/repo_analysis.py` (`_out`)
- Modify: `apps/cloud/app/generation/templates/codebase-baseline-template.md`
- Modify: `apps/cloud/app/generation/prompts.py` (`codebase_baseline_prompt`, `codebase_baseline_user_content`)
- Test: `apps/cloud/tests/test_repo_analysis_api.py`

**Interfaces:**
- Consumes: `RepoSnapshot.source_outlines`, `RepoSnapshot.test_summary` (Task 2).
- Produces: the user content of a baseline run contains `[tests]` followed by the summary and one `[outline:<path>]` block per outline, all inside the existing untrusted block; the template's second `##` heading is `## Current State`, with `### Implemented` and `### Partial or Stubbed` beneath it. Task 4 relies on those two sub-heading names verbatim.

- [ ] **Step 1: Write the failing tests**

In `tests/test_repo_analysis_api.py`, change `_imported_project` so `src/server.js` has real content (add after the `package.json` `set_file`):

```python
    fake.set_file(
        REPO,
        "src/server.js",
        HEAD,
        "app.get('/stories', listStories)\nfunction listStories(req, res) {}\n"
        "// TODO: pagination\n",
    )
```

Replace the body of `test_get_shows_excerpts_to_admins_only` with:

```python
def test_get_shows_excerpts_and_outlines_to_admins_only(client: TestClient):
    _, pid = _imported_project(client)
    _analyze(client, pid)

    admin = client.get(f"/projects/{pid}/repo-analysis", headers=ALICE).json()
    member = client.get(f"/projects/{pid}/repo-analysis", headers=BOB).json()
    assert [e["path"] for e in admin["snapshot"]["excerpts"]] == ["README.md", "package.json"]
    assert [o["path"] for o in admin["snapshot"]["source_outlines"]] == ["src/server.js"]
    assert member["snapshot"]["excerpts"] == []
    assert member["snapshot"]["source_outlines"] == []
    # Everything else in the snapshot is the same for both.
    withheld = {"excerpts", "source_outlines"}
    assert {k: v for k, v in member["snapshot"].items() if k not in withheld} == {
        k: v for k, v in admin["snapshot"].items() if k not in withheld
    }
    assert member["baseline"] == admin["baseline"]
```

Append:

```python
def test_baseline_run_reads_outlines_and_asks_for_current_state(client: TestClient):
    _, pid = _imported_project(client)
    _analyze(client, pid)
    system_prompt, user_content = client.app.state.generation_provider.calls[-1]

    assert "## Current State" in system_prompt
    assert "### Implemented" in system_prompt
    assert "### Partial or Stubbed" in system_prompt
    assert system_prompt.index("## Current State") < system_prompt.index("## Stack")
    # Outlines and the test summary sit inside the one untrusted block.
    inside = user_content.split(UNTRUSTED_OPEN, 1)[1].split(UNTRUSTED_CLOSE, 1)[0]
    assert "[outline:src/server.js]" in inside
    assert "3: // TODO: pagination" in inside
    assert "[tests]\nno test files found" in inside
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_repo_analysis_api.py -v -k "outlines or current_state"`
Expected: FAIL — the member still receives `source_outlines`, and `## Current State` is not in the system prompt.

- [ ] **Step 3: Implement**

`app/api/repo_analysis.py`, in `_out` — replace the excerpt-withholding line and update the docstring:

```python
    """`include_excerpts=False` empties `snapshot.excerpts` and
    `snapshot.source_outlines` and nothing else: both are verbatim file
    contents, which only the admins who ran the analysis see — members get
    the same shape with empty lists."""
    ...
    if not include_excerpts:
        snapshot = snapshot.model_copy(update={"excerpts": [], "source_outlines": []})
```

`app/generation/templates/codebase-baseline-template.md` — insert between the Purpose section and `## Stack`:

```markdown
## Current State

<!-- What the code already does. Planning reads this section to avoid
generating work for things that exist, so be concrete and cite evidence: base
every entry on the source outlines, the directory layout and the test summary,
and end each bullet with at least one path. Group by user-visible capability
or subsystem, not by file. -->

### Implemented

<!-- One bullet per capability with real code behind it — routes, handlers,
models, jobs, screens: "- Story listing API — src/server.js, src/routes/stories.js".
A declaration alone is weak evidence; prefer capabilities several outlined
lines agree on. Note when a capability has no tests. -->

### Partial or Stubbed

<!-- One bullet per capability that is declared but unfinished: TODO/FIXME
markers, NotImplementedError / unimplemented!, very short files, handlers
with nothing behind them. Quote the marker and cite path:line. Write "None
evident from the snapshot" when there are none. -->
```

`app/generation/prompts.py`, in `codebase_baseline_prompt`, replace the second list entry with:

```python
            "You are given a snapshot of an existing software repository: its directory "
            "summary, the stack detected from its manifests, a test summary, excerpts of a "
            "fixed list of files, and outlines of its source files (declaration and "
            "TODO/stub lines, numbered, under each file's length). Write a baseline document "
            "describing the codebase as it is today, so that later planning describes "
            "changes to this code instead of a fresh build — including what it already "
            "does, which planning uses to avoid rebuilding it.",
```

In `codebase_baseline_user_content`, add the test summary after the directory summary, and the outlines after the excerpts loop:

```python
    parts = [
        f"[repo_snapshot] {snapshot.file_count} files"
        + (" (tree listing truncated by GitHub)" if snapshot.tree_truncated else ""),
        f"runtime: {stack.runtime or 'unknown'}",
        f"manifests: {', '.join(stack.manifests) or 'none found'}",
        f"languages: {', '.join(stack.languages) or 'none detected'}",
        "",
        "[directories]",
        snapshot.tree_summary or "(empty)",
        "",
        "[tests]",
        snapshot.test_summary or "(not recorded)",
    ]
    for excerpt in snapshot.excerpts:
        suffix = "\n...[truncated]" if excerpt.truncated else ""
        parts += ["", f"[file:{excerpt.path}]", excerpt.content + suffix]
    for outline in snapshot.source_outlines:
        suffix = "\n...[truncated]" if outline.truncated else ""
        parts += ["", f"[outline:{outline.path}]", outline.content + suffix]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_repo_analysis_api.py tests/test_repo_snapshot.py -v && ruff check app tests`
Expected: all PASS, including the untouched `test_repository_content_reaches_the_model_delimited_and_without_secrets` and `test_secret_values_in_excerpts_are_redacted_before_storage`.

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/api/repo_analysis.py apps/cloud/app/generation/templates/codebase-baseline-template.md apps/cloud/app/generation/prompts.py apps/cloud/tests/test_repo_analysis_api.py
git commit -m "feat(cloud): ask the codebase baseline for a cited Current State section"
```

---

### Task 4: Plan and tasks stop rebuilding what exists

**Files:**
- Modify: `apps/cloud/app/generation/prompts.py` (`driver_prompt`)
- Test: `apps/cloud/tests/test_repo_analysis_api.py`
- Modify: `docs/plans/0028-current-state-in-the-codebase-baseline.md` (status line)

**Interfaces:**
- Consumes: the `### Implemented` / `### Partial or Stubbed` heading names (Task 3).
- Produces: for `existing_codebase=True` and `kind in ("plan", "tasks")`, the system prompt contains the sentence beginning `"When [codebase_baseline] has a Current State section"`. Every other prompt is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_repo_analysis_api.py`:

```python
def test_plan_and_tasks_are_told_not_to_rebuild_what_exists(client: TestClient):
    _, pid = _imported_project(client)
    _analyze(client, pid)
    provider: RecordingProvider = client.app.state.generation_provider

    for stage in ("constitution", "specify", "plan", "tasks"):
        assert _generate(client, pid, stage).status_code == 200
        system_prompt, _ = provider.calls[-1]
        told = "has a Current State section" in system_prompt
        assert told == (stage in ("plan", "tasks")), stage


def test_current_state_survives_the_tasks_cap(client: TestClient):
    _, pid = _imported_project(client)
    _analyze(client, pid)
    baseline = (
        "# Codebase Baseline: storyapp\n\n## Purpose\n\nStories.\n\n"
        "## Current State\n\n### Implemented\n\n- Story listing API — src/server.js\n\n"
        "### Partial or Stubbed\n\n- Pagination — src/server.js:3 TODO\n\n"
        "## Stack\n\n" + "Express details. " * 1_000
    )
    res = client.patch(f"/projects/{pid}/repo-analysis", json={"baseline": baseline}, headers=ALICE)
    assert res.status_code == 200, res.text

    assert _generate(client, pid, "tasks").status_code == 200
    _, user_content = client.app.state.generation_provider.calls[-1]
    assert "- Story listing API — src/server.js" in user_content
    assert "- Pagination — src/server.js:3 TODO" in user_content
```

In the existing `test_scratch_project_prompts_are_unchanged`, add inside the loop:

```python
        assert "Current State" not in system_prompt, stage
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_repo_analysis_api.py -v -k "rebuild or survives or scratch"`
Expected: `test_plan_and_tasks_are_told_not_to_rebuild_what_exists` FAILS (`told` is False for `plan`); the other two PASS already. `test_current_state_survives_the_tasks_cap` passing now is expected — it pins the placement Task 3 chose, and would fail if a later edit moved the section below Stack.

- [ ] **Step 3: Implement**

In `driver_prompt`, extend the existing `plan`/`tasks` branch:

```python
    if existing_codebase and kind in ("plan", "tasks"):
        lines.append(
            "An existing codebase is described in [codebase_baseline]; plan changes against "
            "it, reuse its modules and conventions, and do not re-scaffold the project."
        )
        lines.append(
            "When [codebase_baseline] has a Current State section, treat what it lists under "
            "Implemented as already built: never plan or create a task to build it again — "
            "change or extend it only where the specification requires, and name the existing "
            "path the work touches. Finish an item listed under Partial or Stubbed only when "
            "the specification needs it."
        )
```

The "When … has" wording is what keeps an analysis stored before this plan — whose baseline has no such section — generating exactly as it did.

- [ ] **Step 4: Run the full cloud suite**

Run: `pytest && ruff check .`
Expected: all PASS (the `network` marker stays deselected by default; `contract`/`rls`/`eval` skip without their environment). Then run `pytest -m contract -k repo_analyses` if `PZ_CONTRACT_SUPABASE_URL` is set, to confirm the two new snapshot fields round-trip through jsonb on the Supabase adapter; otherwise note it skipped.

- [ ] **Step 5: Update this plan's status, refresh the graph, commit**

Change the status line at the top of this file to `**Status:** Implemented 2026-MM-DD (cloud; no web change).` with the real date, then:

```bash
cd /Users/kittisak/REPO/ideva/PromptConnext && graphify update .
git add apps/cloud/app/generation/prompts.py apps/cloud/tests/test_repo_analysis_api.py docs/plans/0028-current-state-in-the-codebase-baseline.md
git commit -m "feat(cloud): keep plan and tasks from rebuilding what an import already has"
```

---

## Verification

`cd apps/cloud && pytest && ruff check .` covers the whole change. `tests/test_repo_snapshot.py` pins the selection (tests and non-source excluded, entry points first, a monorepo spread across packages, the cap, order independence), the outline (kept lines and numbering, SQL and non-JS languages, no false TODO in a to-do app, bounded time on pathological input), the test summary, and `build_snapshot`'s fetch, redaction-before-outline, caps, per-file failure and old-row validation. `tests/test_repo_analysis_api.py` pins the member view, the baseline prompt's new material inside the untrusted block and the template order, the one new stage line and where it appears, and that Current State survives the `tasks` cap.

A manual check is worth one run before release, since no test can judge the model's prose: import a real repository of moderate size on a local cloud (`DATA_BACKEND=memory`, `MANAGED_MODEL_ENABLED=true`), run the analysis, and read the Current State section against the code. Then write a PRD that asks for one feature the code has and one it lacks, and confirm the generated `tasks.md` has a task for the second and none that builds the first.

## Known edges

The outline sees declarations, not behaviour: a handler whose body is a placeholder but carries no marker reads as implemented. The `[N lines]` header and the template's "prefer capabilities several outlined lines agree on" narrow that, and an admin can correct the baseline by hand through the existing `PATCH`, which is what the gate already relies on. Sixty files is a sample in a large repository; the round-robin spreads it, but a capability that lives only in the 61st file is invisible, and the baseline says "not evident" rather than "absent" for exactly this reason. Analyses stored before this plan have no outlines and no Current State until an admin re-analyzes, which costs budget; nothing forces it, and the stage line's conditional wording makes the old baseline behave as before. Plan 0027's N6 is unchanged: redaction covers what this plan stores and prompts, not the code index's embedded chunks.
