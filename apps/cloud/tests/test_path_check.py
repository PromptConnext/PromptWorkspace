"""The path check on a generated tasks document (imported projects).

A model planning against a baseline invents plausible paths; this reports the
ones that are neither in the repository nor marked `(new)`. It never rewrites.
"""

from __future__ import annotations

from app.generation.path_check import UnknownPath, unknown_task_paths

FILES = ["index.html", "server.ts", "src/App.tsx", "src/lib/store.tsx", "src/pages/Leads.tsx"]


def check(doc: str, files=FILES, complete: bool = True):
    return unknown_task_paths(doc, files, listing_complete=complete)


def test_a_path_in_the_repository_is_fine():
    assert check("- [ ] T001 Change the title in `index.html` and `src/App.tsx`") == []


def test_a_directory_that_exists_is_fine():
    assert check("- [ ] T001 Add a page under `src/pages/`") == []
    assert check("- [ ] T001 Add a page under `src/pages`") == []


def test_an_invented_path_is_reported_with_its_task():
    found = check("- [ ] T014 [US1] Update tags in `src/lib/metaTags.ts` and `index.html`")
    assert found == [UnknownPath(ref="T014", path="src/lib/metaTags.ts")]


def test_a_path_marked_new_is_fine_but_only_that_path():
    doc = "- [ ] T005 Add `src/lib/migration.ts` (new) and call it from `src/lib/gone.ts`"
    assert check(doc) == [UnknownPath(ref="T005", path="src/lib/gone.ts")]


def test_commands_globs_and_identifiers_are_not_paths():
    doc = (
        "- [ ] T001 Run `npm run lint` and `tsc --noEmit`, read `process.env` and "
        "`GEMINI_API_KEY`, touch `src/**/*.ts`, `src/<name>.ts` and `Date.now`"
    )
    assert check(doc) == []


def test_a_bare_root_file_name_counts_as_a_path():
    assert check("- [ ] T002 Edit `package.json`") == [UnknownPath(ref="T002", path="package.json")]


def test_leading_dot_slash_and_trailing_punctuation_are_ignored():
    assert check("- [ ] T001 Edit `./src/App.tsx`, then `src/lib/store.tsx`.") == []


def test_each_ref_path_pair_is_reported_once():
    doc = "- [ ] T003 Edit `nope/a.ts` and `nope/a.ts` again\n- [ ] T004 Edit `nope/a.ts`"
    assert check(doc) == [
        UnknownPath(ref="T003", path="nope/a.ts"),
        UnknownPath(ref="T004", path="nope/a.ts"),
    ]


def test_only_task_lines_are_read():
    doc = (
        "## Phase 1\n\nSee `nope/a.ts` in the intro.\n"
        "- [ ] T001 Do it\n  - AC: `nope/b.ts` exists"
    )
    assert check(doc) == []


def test_a_partial_file_list_proves_nothing():
    assert check("- [ ] T001 Edit `src/lib/metaTags.ts`", complete=False) == []
