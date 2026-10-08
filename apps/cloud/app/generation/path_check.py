"""Check the file paths a generated tasks document names against the repository
it plans changes to (imported projects only).

A model planning against a baseline invents plausible paths for behaviour that
exists under another name (`src/lib/metaTags.ts` for a title that lives in
`index.html`, `i18n/th.json` for an app with no i18n layer). The prompt asks for
real paths or an explicit `(new)` after the backticked path; this is the
deterministic backstop that tells the author which tasks still name a file that
is neither in the repository nor marked as new. It only reports: what a path was
*meant* to be is the author's call, so nothing is rewritten.

It errs toward silence. A warning the author learns to ignore is worse than a
missed one, so a token is only a path when its last segment has a file
extension, files the repository snapshot never lists (secret-shaped, binary,
vendored) are not judged, and a path one task creates may be edited by another.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from app.imports.snapshot import is_excluded_path

_TASK_LINE_RE = re.compile(r"^\s*[-*] \[[ xX]?\] (T\d+)\b(.*)$")
# A backticked token, and an immediately following new-file marker:
# `(new)`, `(new file)`, `, new` or `- new`.
_TOKEN_RE = re.compile(
    r"`([^`\n]+)`(\s*(?:\(\s*new(?:\s+file)?\s*\)|[,–—-]\s*new\b))?", re.IGNORECASE
)
_NOT_A_PATH = re.compile(r"[\s*<>{}\[\]$|\\]|://")
# `src/App.tsx:42`, `src/App.tsx:42:7`, `src/App.tsx#L10`
_LOCATION_SUFFIX = re.compile(r"(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$")
# A bare name (`package.json`) is only a path when it carries one of these, so
# `process.env` and `Date.now` are not mistaken for files.
_BARE_FILE_EXTENSIONS = frozenset(
    "ts tsx js jsx mjs cjs json md html css scss yml yaml py toml sh sql txt svg".split()
)
# Example/template files the repository really has but the snapshot withholds
# along with the secret-shaped `.env.*` family.
_ENV_TEMPLATES = frozenset({".env.example", ".env.sample", ".env.template"})


@dataclass(frozen=True)
class UnknownPath:
    ref: str
    path: str


def _normalise(token: str) -> str:
    token = _LOCATION_SUFFIX.sub("", token.strip().rstrip(".,;:)"))
    while token.startswith("./"):
        token = token[2:]
    return token.rstrip("/")


def _is_file_path(token: str) -> bool:
    """A repository-relative file path: no spaces or glob/placeholder characters,
    not absolute, and a last segment with an extension (so routes like
    `/api/leads`, MIME types and `@scope/package` names are not paths)."""
    if not token or token.startswith("/") or _NOT_A_PATH.search(token):
        return False
    last = token.rsplit("/", 1)[-1]
    stem, dot, extension = last.rpartition(".")
    if not (dot and stem):
        return False
    if "/" not in token:
        return extension.lower() in _BARE_FILE_EXTENSIONS
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,5}", extension))


def _strip_dot_slash(path: str) -> str:
    # A prefix, not a character set: `str.lstrip("./")` would turn
    # `.github/ci.yml` into `github/ci.yml`.
    return path[2:] if path.startswith("./") else path


def unknown_task_paths(
    tasks_md: str, known_paths: Iterable[str], *, listing_complete: bool
) -> list[UnknownPath]:
    """Paths named on task lines that are not in `known_paths` (the repository's
    files, or a directory containing some), not created by a task in this
    document (`(new)`), and not a file the snapshot never lists.

    `listing_complete` is False when the repository's file list was capped or
    truncated: a path absent from a partial list proves nothing, so nothing is
    reported."""
    if not listing_complete:
        return []
    files = {_strip_dot_slash(p) for p in known_paths}
    directories = {"/".join(p.split("/")[:i]) for p in files for i in range(1, p.count("/") + 1)}

    mentions: list[tuple[str, str, bool]] = []
    for line in tasks_md.splitlines():
        task = _TASK_LINE_RE.match(line)
        if not task:
            continue
        for match in _TOKEN_RE.finditer(task.group(2)):
            token = match.group(1)
            if not _is_file_path(_normalise(token)):
                continue
            mentions.append((task.group(1), _normalise(token), bool(match.group(2))))

    # A file one task creates may be edited by a later one without the marker.
    created = {path for _, path, is_new in mentions if is_new}

    found: list[UnknownPath] = []
    seen: set[tuple[str, str]] = set()
    for ref, path, is_new in mentions:
        if is_new or path in created or path in files or path in directories:
            continue
        if path in _ENV_TEMPLATES or is_excluded_path(path):
            continue
        if (ref, path) not in seen:
            seen.add((ref, path))
            found.append(UnknownPath(ref=ref, path=path))
    return found
