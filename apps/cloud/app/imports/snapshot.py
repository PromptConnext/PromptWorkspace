"""A deterministic read of an imported repository (plan 0027 M1).

Before this, the platform never looked at the code of a repository a user
imported: the stages were generated as if the project started from nothing,
and the seed commit wrote over whatever sat at the same paths. The snapshot is
the first half of the fix — what the repository *is*, read without a model —
and the codebase baseline (app/api/repo_analysis.py) is the second, a model's
prose over this material.

Pure apart from the injected GitHub client, in the same spirit as
app/integrations/repo_seed.py: the filters and the summary are plain functions
of a path list, so they are tested without a network, and the two async
functions only sequence reads — `build_snapshot` one file at a time,
`_outline_sources` (plan 0028) with bounded concurrency.

**Nothing secret-shaped is ever fetched.** `.env*`, private keys, certificates
and credential files are dropped from the path list before anything else looks
at it, so they are not listed, not summarised, not excerpted and not stored —
the model reading the snapshot never sees one, and neither does
`pw_repo_analyses`. Repository content is still untrusted prompt input after
that filter; the prompt that reads it treats it as data (app/generation/
prompts.py::codebase_baseline_prompt), which is a separate defence against a
separate problem. And a file that passes the filter can still quote a key
inline, so every excerpt and every source outline goes through
`redact_secrets` before it is stored.
"""

from __future__ import annotations

import asyncio
import fnmatch
import posixpath
import re
from collections import Counter

from app.integrations.github import GithubWriteError
from app.models.schemas import RepoExcerpt, RepoSkippedFile, RepoSnapshot, RepoStack

# Any path with one of these as a directory segment is vendored, generated or
# tool state — never the code a plan should be written against.
_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "bower_components",
        "vendor",
        "dist",
        "build",
        "out",
        "target",
        "coverage",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".turbo",
        ".cache",
        ".venv",
        "venv",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".gradle",
        ".idea",
        ".terraform",
    }
)

_BINARY_EXTENSIONS = frozenset(
    {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svgz", ".tiff",
        ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
        ".jar", ".war", ".class", ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a",
        ".woff", ".woff2", ".ttf", ".otf", ".eot",
        ".mp3", ".mp4", ".mov", ".avi", ".wav", ".ogg", ".webm",
        ".pyc", ".pyo", ".wasm", ".sqlite", ".db", ".psd", ".sketch", ".fig",
    }
)  # fmt: skip

# Basename globs for files that hold, or are shaped like, credentials. Matched
# case-insensitively. Broad on purpose — a false positive costs one file the
# model does not read; a false negative puts a key in a prompt and a database
# row.
_SECRET_GLOBS = (
    ".env",
    ".env.*",
    "*.env",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "*.crt",
    "*.cer",
    "*.der",
    "*.gpg",
    "*.asc",
    "*.tfstate",
    "*.tfstate.*",
    "*.tfvars",
    "*.tfvars.json",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".htpasswd",
    ".git-credentials",
    "credentials",
    "credentials.json",
    "secrets.*",
    "*secret*.json",
    "*secret*.yml",
    "*secret*.yaml",
    "service-account*.json",
    ".envrc",
    "*.ppk",
    "*.p8",
    "*.keytab",
    "*.ovpn",
    "kubeconfig",
    ".pgpass",
    "wp-config.php",
    "application*.properties",
    "appsettings*.json",
    "local.settings.json",
    "serviceaccountkey.json",
    "*firebase-adminsdk*.json",
)

# Globs matched against the whole lowercased path rather than the basename —
# for files whose name alone is innocent (`config`, `database.yml`) and whose
# directory is what makes them a credential store. Each also matches at any
# depth.
_SECRET_PATH_GLOBS = (
    ".kube/config",
    ".docker/config.json",
    "config/database.yml",
)

# Values redacted out of an excerpt before it is stored or put in a prompt
# (plan 0027): the path filter above keeps credential *files* out, but a
# README or a workflow can still quote a key inline. Four shapes, each
# replaced with `***`: a private-key PEM block, the password in a URL's
# userinfo, the value of an assignment whose key names a secret (the whole
# quoted string when it is quoted, spaces and all), and a token whose prefix
# announces one. A false positive costs a dependency version in a prompt; a
# false negative stores a live key.
#
# Every expression is linear in the text: nothing unbounded is matched before
# a fixed keyword or prefix, repeats that could restart at every position are
# anchored to a word start or bounded, and a quoted value stops at its line.
# A minified bundle or a base64 blob cannot make any of them quadratic.
_PEM_BLOCK = re.compile(
    r"-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY-----"
    r"(?:(?!-----END)[\s\S])*"
    r"(?:-----END[A-Z0-9 ]{0,40}PRIVATE KEY-----|\Z)"
)
_URL_CREDENTIAL = re.compile(
    r"(?<![\w+.-])([A-Za-z][\w+.-]{0,31}://[^\s:/@]{1,256}:)[^\s@/]{1,256}@"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)((?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key|credential)"
    r"[\w.-]{0,64}[\"']?[ \t]*[:=][ \t]*)"
    r"(?:(\")[^\"\n]*\"?|(')[^'\n]*'?|[^\s\"',;]+)"
)
_SECRET_TOKEN = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|sk_(?:live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{35}"
    r"|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})"
    r"|(?<![\w-])sk-[A-Za-z0-9_-]{16,}"
)
_BEARER = re.compile(r"(?i)\b(bearer[ \t]+)[A-Za-z0-9._~+/-]{8,}=*")
REDACTED = "***"

# Root-level manifests, in the order the runtime is decided from: the first
# present wins. The runtime names that plan_profile.py can scaffold for come
# first within their language so `runtime` feeds `derive_stack_profile`
# directly.
_MANIFEST_RUNTIME: tuple[tuple[str, str], ...] = (
    ("package.json", "node"),
    ("pyproject.toml", "python"),
    ("requirements.txt", "python"),
    ("setup.py", "python"),
    ("Pipfile", "python"),
    ("go.mod", "go"),
    ("Cargo.toml", "rust"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("build.gradle.kts", "java"),
    ("Gemfile", "ruby"),
    ("composer.json", "php"),
)

_LANGUAGE_BY_EXTENSION = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go",
    ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby", ".php": "PHP",
    ".cs": "C#", ".swift": "Swift", ".dart": "Dart", ".scala": "Scala",
    ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++", ".vue": "Vue", ".svelte": "Svelte",
    ".sql": "SQL", ".sh": "Shell",
}  # fmt: skip

# Files worth reading in full (up to the per-file cap), in priority order: the
# total budget is spent top-down, so what a repo says about itself comes before
# its manifests, and both before its CI configuration.
_EXCERPT_GLOBS = (
    "README*",
    "AGENTS.md",
    "CLAUDE.md",
    ".specify/memory/constitution.md",
    "package.json",
    "pyproject.toml",
    "requirements*.txt",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle*",
    "Gemfile",
    "composer.json",
    "Dockerfile",
    "docker-compose*.yml",
    "docker-compose*.yaml",
    "compose.yml",
    "compose.yaml",
    ".github/workflows/*",
)

MAX_PATHS = 2_000
# Entries in a snapshot's `skipped` list; `skipped_count` stays exact.
MAX_SKIPPED = 50
MAX_SUMMARY_DIRS = 200
EXCERPT_FILE_CHARS = 8_000
EXCERPT_TOTAL_CHARS = 30_000
# The most `code_file` jobs one repository sweep enqueues (plan 0027 M5) — an
# imported monorepo must not flood the embed queue every other project shares.
CODE_INDEX_MAX_FILES = 500

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


def is_secret_path(path: str) -> bool:
    lowered = path.lower()
    name = posixpath.basename(lowered)
    if any(fnmatch.fnmatchcase(name, glob) for glob in _SECRET_GLOBS):
        return True
    return any(
        lowered == glob or lowered.endswith(f"/{glob}") for glob in _SECRET_PATH_GLOBS
    )


def redact_secrets(text: str) -> str:
    """`text` with secret-shaped values replaced by `***`. The PEM block
    goes first, so the assignment rule never sees half a key."""
    text = _PEM_BLOCK.sub(REDACTED, text)
    text = _URL_CREDENTIAL.sub(lambda m: f"{m.group(1)}{REDACTED}@", text)

    def assignment(m: re.Match) -> str:
        quote = m.group(2) or m.group(3) or ""
        return f"{m.group(1)}{quote}{REDACTED}{quote}"

    text = _SECRET_ASSIGNMENT.sub(assignment, text)
    text = _BEARER.sub(lambda m: m.group(1) + REDACTED, text)
    return _SECRET_TOKEN.sub(REDACTED, text)


def is_excluded_path(path: str) -> bool:
    """Vendored/build directory, binary file, or secret-shaped file."""
    parts = path.split("/")
    if any(part in _EXCLUDED_DIRS for part in parts[:-1]):
        return True
    if posixpath.splitext(parts[-1])[1].lower() in _BINARY_EXTENSIONS:
        return True
    return is_secret_path(path)


def filter_paths(paths: list[str]) -> list[str]:
    return sorted(p for p in paths if p and not is_excluded_path(p))


def skipped_files(
    paths: list[str], limit: int = MAX_SKIPPED
) -> tuple[list[RepoSkippedFile], int]:
    """What the filter above left out of the analysis and why (finding #6),
    as (entries sorted by path and capped at `limit`, total files skipped).

    A vendored or build directory is one entry (`node_modules/`), not one per
    file inside it. Naming a secret-shaped file here is not reading it: the
    name is already in the repository's own listing, and its content is never
    fetched."""
    entries: dict[str, str] = {}
    count = 0
    for path in paths:
        if not path or not is_excluded_path(path):
            continue
        count += 1
        parts = path.split("/")
        vendored = next(
            (i for i, part in enumerate(parts[:-1]) if part in _EXCLUDED_DIRS), None
        )
        if vendored is not None:
            entries["/".join(parts[: vendored + 1]) + "/"] = "vendored"
        elif is_secret_path(path):
            entries[path] = "secret"
        else:
            entries[path] = "binary"
    listed = [RepoSkippedFile(path=p, reason=entries[p]) for p in sorted(entries)[:limit]]
    return listed, count


def summarize_tree(paths: list[str], max_dirs: int = MAX_SUMMARY_DIRS) -> str:
    """One line per directory, two levels deep, with a file count that
    includes everything below it — enough to see a repository's shape
    without listing it. Root files are counted on their own line."""
    counts: Counter[str] = Counter()
    for path in paths:
        parts = path.split("/")
        if len(parts) == 1:
            counts["(root)"] += 1
            continue
        counts[parts[0] + "/"] += 1
        if len(parts) > 2:
            counts["/".join(parts[:2]) + "/"] += 1
    lines = []
    for index, (directory, count) in enumerate(sorted(counts.items())):
        if index >= max_dirs:
            lines.append(f"... ({len(counts) - max_dirs} more directories)")
            break
        indent = "  " if directory.count("/") == 2 else ""
        lines.append(f"{indent}{directory} {count} file{'s' if count != 1 else ''}")
    return "\n".join(lines)


def detect_stack(paths: list[str]) -> RepoStack:
    root = {p for p in paths if "/" not in p}
    manifests = [name for name, _ in _MANIFEST_RUNTIME if name in root]
    runtime = next((rt for name, rt in _MANIFEST_RUNTIME if name in root), None)
    languages = Counter(
        _LANGUAGE_BY_EXTENSION[ext]
        for ext in (posixpath.splitext(p)[1].lower() for p in paths)
        if ext in _LANGUAGE_BY_EXTENSION
    )
    ranked = [lang for lang, _ in languages.most_common(5)]
    if runtime is None and ranked:
        runtime = ranked[0].lower()
    return RepoStack(runtime=runtime, manifests=manifests, languages=ranked)


def excerpt_paths(paths: list[str]) -> list[str]:
    """The fixed-list files present in `paths`, in `_EXCERPT_GLOBS` priority
    order. Globs without a slash match root-level files only — a nested
    `package.json` in a fixture directory says little about the project."""
    chosen: list[str] = []
    for glob in _EXCERPT_GLOBS:
        for path in paths:
            if path in chosen:
                continue
            if "/" not in glob and "/" in path:
                continue
            if fnmatch.fnmatchcase(path, glob):
                chosen.append(path)
    return chosen


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


async def build_snapshot(github_client, token: str, repo: str, branch: str) -> RepoSnapshot:
    """Pin the branch head, list its tree, and read the fixed-list files.

    A file that fails to fetch is left out rather than failing the snapshot —
    one unreadable README must not block planning — but listing failures
    propagate as `GithubWriteError`, since without a tree there is nothing to
    describe. Then outlines a spread of source files (plan 0028) the same way:
    a failed fetch drops that file only.
    """
    head_sha = await github_client.get_branch_head(token, repo, branch)
    raw_paths, truncated = await github_client.get_tree(token, repo, head_sha)
    paths = filter_paths(raw_paths)
    skipped, skipped_count = skipped_files(raw_paths)

    excerpts: list[RepoExcerpt] = []
    remaining = EXCERPT_TOTAL_CHARS
    for path in excerpt_paths(paths):
        if remaining <= 0:
            break
        try:
            content = await github_client.fetch_file_content(token, repo, path, head_sha)
        except GithubWriteError:
            continue
        content = redact_secrets(content)
        limit = min(EXCERPT_FILE_CHARS, remaining)
        clipped = content[:limit]
        remaining -= len(clipped)
        excerpts.append(
            RepoExcerpt(path=path, content=clipped, truncated=len(clipped) < len(content))
        )

    source_outlines = await _outline_sources(github_client, token, repo, head_sha, paths)

    return RepoSnapshot(
        commit_sha=head_sha,
        default_branch=branch,
        file_count=len(paths),
        tree_truncated=truncated,
        tree_summary=summarize_tree(paths),
        stack=detect_stack(paths),
        excerpts=excerpts,
        paths=paths[:MAX_PATHS],
        source_outlines=source_outlines,
        test_summary=summarize_tests(paths),
        skipped=skipped,
        skipped_count=skipped_count,
    )


def indexable_code_paths(paths: list[str], limit: int) -> list[str]:
    """Paths worth a `code_file` embed job (plan 0027 M5): the snapshot's own
    filter, minus lockfiles and minified bundles that chunk into noise, capped
    so a very large import cannot flood the embed queue. Source files come
    first, so the cap is spent on code rather than on whatever sorts ahead of
    it alphabetically (a `docs/` tree, fixtures, generated JSON)."""
    selected = [
        p
        for p in filter_paths(paths)
        if not p.endswith((".lock", "-lock.json", "-lock.yaml", ".min.js", ".min.css", ".map"))
    ]
    selected.sort(key=lambda p: posixpath.splitext(p)[1].lower() not in _LANGUAGE_BY_EXTENSION)
    return selected[:limit]
