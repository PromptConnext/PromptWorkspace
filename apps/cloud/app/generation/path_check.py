"""Check the file paths a generated tasks document names against the repository
it plans changes to (imported projects only).

A model planning against a baseline invents plausible paths for behaviour that
exists under another name (`src/lib/metaTags.ts` for a title that lives in
`index.html`, `i18n/th.json` for an app with no i18n layer). The prompt asks for
real paths or an explicit `(new)`; this is the deterministic backstop that tells
the author which tasks still name a file that is neither in the repository nor
marked as new. It only reports: what a path was *meant* to be is the author's
call, so nothing is rewritten.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

_TASK_LINE_RE = re.compile(r"^\s*[-*] \[[ xX]?\] (T\d+)\b(.*)$")
# A backticked token, and an immediately following "(new)" marker.
_TOKEN_RE = re.compile(r"`([^`\n]+)`(\s*\(new\))?", re.IGNORECASE)
_FILE_NAME_RE = re.compile(
    r"[\w.@\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|html|css|scss|yml|yaml|py|toml|sh|sql|txt|svg)",
    re.IGNORECASE,
)
_NOT_A_PATH = re.compile(r"[\s*<>{}\[\]$|]|://")


@dataclass(frozen=True)
class UnknownPath:
    ref: str
    path: str


def _looks_like_path(token: str) -> bool:
    if _NOT_A_PATH.search(token):
        return False
    return "/" in token or bool(_FILE_NAME_RE.fullmatch(token))


def _normalise(token: str) -> str:
    token = token.strip().rstrip(".,;:)")
    while token.startswith("./"):
        token = token[2:]
    return token.rstrip("/")


def unknown_task_paths(
    tasks_md: str, known_paths: Iterable[str], *, listing_complete: bool
) -> list[UnknownPath]:
    """Paths named on task lines that are not in `known_paths` (the repository's
    files, or a directory containing some) and not followed by `(new)`.

    `listing_complete` is False when the repository's file list was capped: a
    path absent from a partial list proves nothing, so nothing is reported."""
    if not listing_complete:
        return []
    files = {p.lstrip("./") for p in known_paths}
    directories = {"/".join(p.split("/")[:i]) for p in files for i in range(1, p.count("/") + 1)}

    found: list[UnknownPath] = []
    seen: set[tuple[str, str]] = set()
    for line in tasks_md.splitlines():
        task = _TASK_LINE_RE.match(line)
        if not task:
            continue
        ref = task.group(1)
        for match in _TOKEN_RE.finditer(task.group(2)):
            token, is_new = match.group(1), bool(match.group(2))
            if is_new or not _looks_like_path(token):
                continue
            path = _normalise(token)
            if not path or path in files or path in directories:
                continue
            if (ref, path) not in seen:
                seen.add((ref, path))
                found.append(UnknownPath(ref=ref, path=path))
    return found
