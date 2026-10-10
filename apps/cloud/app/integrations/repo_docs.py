"""Which of a repository's seeded planning documents are out of date.

The seed (`repo_seed.build_seed_files`) writes derived views of the stage
documents into the repository. Once those documents can be edited after the
repository exists, the views drift. This module answers "which files differ"
without fetching any file: GitHub's tree listing already carries each blob's
git sha, and a git blob sha is a pure function of the content, so it can be
computed locally from the rebuilt seed file and compared.

Only document views are ever in scope. The deployment template's files
(`.github/workflows/*`, `site/`, `docs/deployment.md`) are owned by the
template and never offered for sync.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

from app.integrations.repo_seed import SeedFile

DOC_PATHS: frozenset[str] = frozenset(
    {
        "AGENTS.md",
        "README.md",
        "docs/scope.md",
        "docs/architecture.md",
        "docs/tasks.md",
        "docs/conventions.md",
        "docs/policy-scope.md",
        ".specify/memory/constitution.md",
    }
)


def git_blob_sha(content: str) -> str:
    """The sha git gives a file with this content: sha1 over `blob <bytes>\\0`
    plus the UTF-8 bytes. (sha1 is git's object id, not a security control.)"""
    data = content.encode("utf-8")
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()  # noqa: S324


@dataclass(frozen=True)
class DocState:
    path: str
    state: Literal["current", "out_of_date", "missing"]


def classify_docs(seed_files: list[SeedFile], tree_blobs: dict[str, str]) -> list[DocState]:
    """One entry per rebuilt document view, in seed order. `tree_blobs` maps a
    repository path to its blob sha at the default branch head."""
    states: list[DocState] = []
    for seed_file in seed_files:
        if seed_file.path not in DOC_PATHS:
            continue
        current_sha = tree_blobs.get(seed_file.path)
        if current_sha is None:
            states.append(DocState(seed_file.path, "missing"))
        elif current_sha == git_blob_sha(seed_file.content):
            states.append(DocState(seed_file.path, "current"))
        else:
            states.append(DocState(seed_file.path, "out_of_date"))
    return states


def changed_files(seed_files: list[SeedFile], states: list[DocState]) -> list[SeedFile]:
    wanted = {s.path for s in states if s.state != "current"}
    return [f for f in seed_files if f.path in wanted]
