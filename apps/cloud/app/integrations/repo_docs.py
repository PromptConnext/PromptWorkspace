"""Which of a repository's seeded planning documents are out of date.

The seed (`repo_seed.build_seed_files`) writes derived views of the stage
documents into the repository. Once those documents can be edited after the
repository exists, the views drift. This module answers "which files differ"
without fetching any file: GitHub's tree listing already carries each blob's
git sha, and a git blob sha is a pure function of the content, so it can be
computed locally from the rebuilt seed file and compared.

While a sync pull request is open, a document whose rebuilt view is already
on that pull request's branch reads `in_pull_request`: it differs from the
default branch, but syncing it again would add nothing.

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


DocStateName = Literal["current", "out_of_date", "missing", "in_pull_request"]


@dataclass(frozen=True)
class DocState:
    path: str
    state: DocStateName


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


def mark_in_pull_request(
    seed_files: list[SeedFile], states: list[DocState], pr_blobs: dict[str, str]
) -> list[DocState]:
    """Re-read every document that differs from the default branch against the
    open sync pull request's branch (`pr_blobs`, path -> blob sha): one whose
    rebuilt view is already there is `in_pull_request`."""
    content = {f.path: f.content for f in seed_files}
    return [
        DocState(s.path, "in_pull_request")
        if s.state != "current" and pr_blobs.get(s.path) == git_blob_sha(content[s.path])
        else s
        for s in states
    ]


def changed_files(seed_files: list[SeedFile], states: list[DocState]) -> list[SeedFile]:
    """What a sync must commit: views missing from, or different on, both the
    default branch and the open sync pull request's branch."""
    wanted = {s.path for s in states if s.state in ("out_of_date", "missing")}
    return [f for f in seed_files if f.path in wanted]


def differing_files(seed_files: list[SeedFile], states: list[DocState]) -> list[SeedFile]:
    """Every view that differs from the default branch, whether or not the
    open sync pull request already carries it: what that pull request's
    description lists."""
    wanted = {s.path for s in states if s.state != "current"}
    return [f for f in seed_files if f.path in wanted]
