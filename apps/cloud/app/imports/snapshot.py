"""A deterministic read of an imported repository (plan 0027 M1).

Before this, the platform never looked at the code of a repository a user
imported: the stages were generated as if the project started from nothing,
and the seed commit wrote over whatever sat at the same paths. The snapshot is
the first half of the fix — what the repository *is*, read without a model —
and the codebase baseline (app/api/repo_analysis.py) is the second, a model's
prose over this material.

Pure apart from the injected GitHub client, in the same spirit as
app/integrations/repo_seed.py: the filters and the summary are plain functions
of a path list, so they are tested without a network, and the one async
function only sequences reads.

**Nothing secret-shaped is ever fetched.** `.env*`, private keys, certificates
and credential files are dropped from the path list before anything else looks
at it, so they are not listed, not summarised, not excerpted and not stored —
the model reading the snapshot never sees one, and neither does
`pz_repo_analyses`. Repository content is still untrusted prompt input after
that filter; the prompt that reads it treats it as data (app/generation/
prompts.py::codebase_baseline_prompt), which is a separate defence against a
separate problem.
"""

from __future__ import annotations

import fnmatch
import posixpath
from collections import Counter

from app.integrations.github import GithubWriteError
from app.models.schemas import RepoExcerpt, RepoSnapshot, RepoStack

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
)

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
MAX_SUMMARY_DIRS = 200
EXCERPT_FILE_CHARS = 8_000
EXCERPT_TOTAL_CHARS = 30_000
# The most `code_file` jobs one repository sweep enqueues (plan 0027 M5) — an
# imported monorepo must not flood the embed queue every other project shares.
CODE_INDEX_MAX_FILES = 500


def is_secret_path(path: str) -> bool:
    name = posixpath.basename(path).lower()
    return any(fnmatch.fnmatchcase(name, glob) for glob in _SECRET_GLOBS)


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


async def build_snapshot(github_client, token: str, repo: str, branch: str) -> RepoSnapshot:
    """Pin the branch head, list its tree, and read the fixed-list files.

    A file that fails to fetch is left out rather than failing the snapshot —
    one unreadable README must not block planning — but listing failures
    propagate as `GithubWriteError`, since without a tree there is nothing to
    describe.
    """
    head_sha = await github_client.get_branch_head(token, repo, branch)
    raw_paths, truncated = await github_client.get_tree(token, repo, head_sha)
    paths = filter_paths(raw_paths)

    excerpts: list[RepoExcerpt] = []
    remaining = EXCERPT_TOTAL_CHARS
    for path in excerpt_paths(paths):
        if remaining <= 0:
            break
        try:
            content = await github_client.fetch_file_content(token, repo, path, head_sha)
        except GithubWriteError:
            continue
        limit = min(EXCERPT_FILE_CHARS, remaining)
        clipped = content[:limit]
        remaining -= len(clipped)
        excerpts.append(
            RepoExcerpt(path=path, content=clipped, truncated=len(clipped) < len(content))
        )

    return RepoSnapshot(
        commit_sha=head_sha,
        default_branch=branch,
        file_count=len(paths),
        tree_truncated=truncated,
        tree_summary=summarize_tree(paths),
        stack=detect_stack(paths),
        excerpts=excerpts,
        paths=paths[:MAX_PATHS],
    )


def indexable_code_paths(paths: list[str], limit: int) -> list[str]:
    """Paths worth a `code_file` embed job (plan 0027 M5): the snapshot's own
    filter, minus lockfiles and minified bundles that chunk into noise, capped
    so a very large import cannot flood the embed queue."""
    selected = [
        p
        for p in filter_paths(paths)
        if not p.endswith((".lock", "-lock.json", "-lock.yaml", ".min.js", ".min.css", ".map"))
    ]
    return selected[:limit]
