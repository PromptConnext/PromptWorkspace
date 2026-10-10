"""Which of a repository's seeded planning documents are out of date.

The seed (`repo_seed.build_seed_files`) writes derived views of the stage
documents into the repository. Once those documents can be edited after the
repository exists, the views drift. This module answers "which files differ"
without fetching any file: GitHub's tree listing already carries each blob's
git sha, and a git blob sha is a pure function of the content, so it can be
computed locally from the rebuilt seed file and compared.

While a sync pull request is open, every document is compared with that
pull request's branch as well (`classify_with_pull_request`): a view the
branch already carries reads `in_pull_request`, and a view the default branch
matches but the branch does not (a document edited back after a sync) reads
`out_of_date`, so the next sync reverts it in the pull request.

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


def classify_with_pull_request(
    seed_files: list[SeedFile], main_blobs: dict[str, str], pr_blobs: dict[str, str]
) -> list[DocState]:
    """One entry per rebuilt document view while a sync pull request is open.
    `main_blobs` and `pr_blobs` map paths to blob shas on the default branch
    and on the pull request's branch. `current` needs both to match, since
    merging the pull request must leave the view right; `in_pull_request` is a
    match on the branch only; `missing` means the file is on neither."""
    states: list[DocState] = []
    for seed_file in seed_files:
        if seed_file.path not in DOC_PATHS:
            continue
        sha = git_blob_sha(seed_file.content)
        matches_main = main_blobs.get(seed_file.path) == sha
        matches_pr = pr_blobs.get(seed_file.path) == sha
        if matches_main and matches_pr:
            state = "current"
        elif matches_pr:
            state = "in_pull_request"
        elif seed_file.path not in main_blobs and seed_file.path not in pr_blobs:
            state = "missing"
        else:
            state = "out_of_date"
        states.append(DocState(seed_file.path, state))
    return states


def changed_files(seed_files: list[SeedFile], states: list[DocState]) -> list[SeedFile]:
    """What a sync must commit: views missing from, or different on, both the
    default branch and the open sync pull request's branch."""
    wanted = {s.path for s in states if s.state in ("out_of_date", "missing")}
    return [f for f in seed_files if f.path in wanted]


def files_differing_from(seed_files: list[SeedFile], blobs: dict[str, str]) -> list[SeedFile]:
    """Every document view whose content differs from the tree `blobs`
    describes: for the default branch, what the sync pull request's
    description lists."""
    return [
        f
        for f in seed_files
        if f.path in DOC_PATHS and blobs.get(f.path) != git_blob_sha(f.content)
    ]


def reverting_files(changed: list[SeedFile], main_blobs: dict[str, str]) -> list[SeedFile]:
    """The views among `changed` that equal the default branch: committing
    them takes a change back out of the open sync pull request."""
    return [f for f in changed if main_blobs.get(f.path) == git_blob_sha(f.content)]
