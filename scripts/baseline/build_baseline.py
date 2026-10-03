#!/usr/bin/env python3
"""Generate the two-file migration baseline (plan company-structure-zero-deploy, P2.1).

Reads the 36 migrations at tag `pre-promptworkspace-rename` with `git show`
(never the working tree, which no longer has them), passes each file through
the single-pass token map in scripts/rename/patterns.py (the same map the
rest of the rename used), and writes:

  apps/cloud/migrations/0001_pw_schema_migrations_ledger.sql
      the mapped 0024 (the ledger table), so the runner's bootstrap
      invariant "ledger first" holds by numbering alone, followed by a
      labelled post-squash hardening block (RLS on, revoke from anon and
      authenticated) that the 36-file chain never had.
  apps/cloud/migrations/0002_pw_baseline.sql
      the mapped 0001-0023 and 0025-0036 in numeric order, under a
      `requires-vars=embed_dim` header. 0023's own top-level begin;/commit;
      are removed so the runner wraps the whole file in one transaction;
      its `\\if :{?embed_dim}` guard is kept. No other edits.

With --intermediate DIR it also writes each mapped file on its own (same
filename as at the tag). scripts/baseline/verify_squash.sh applies those, in
order, to build the reference database the baseline is diffed against.

Usage (from the PromptWorkspace root):
    python scripts/baseline/build_baseline.py [--tag TAG] [--out DIR] [--intermediate DIR]
    python scripts/baseline/build_baseline.py --check   # exit 1 if the checked-in files differ
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TAG_DEFAULT = "pre-promptworkspace-rename"
SOURCE_DIR = "apps/cloud/migrations"
OUT_DIR_DEFAULT = REPO_ROOT / SOURCE_DIR
LEDGER_SOURCE_NUMBER = 24
SELF_TX_SOURCE_NUMBER = 23
EXPECTED_SOURCE_COUNT = 36
LEDGER_OUT = "0001_pw_schema_migrations_ledger.sql"
BASELINE_OUT = "0002_pw_baseline.sql"

# Appended to the mapped 0024 in 0001. Not in the 36-file chain: there the
# ledger had neither RLS nor a revoke, and hosted Supabase's default privileges
# can expose a public table to anon over PostgREST. The runner connects as the
# table owner (or a superuser), which RLS and these revokes do not restrict.
LEDGER_HARDENING = (
    "\n"
    "-- ---------------------------------------------------------------------------\n"
    "-- POST-SQUASH HARDENING (added by scripts/baseline/build_baseline.py; not in\n"
    "-- the 36-file chain). The ledger is migration tooling, read and written only\n"
    "-- over a direct Postgres connection by its owner, which RLS does not apply\n"
    "-- to. RLS with no policies plus the revoke keeps it unreachable through the\n"
    "-- Data API even if default privileges grant it to anon/authenticated.\n"
    "-- scripts/baseline/verify_squash.sh asserts both on the baseline database.\n"
    "-- ---------------------------------------------------------------------------\n"
    "\n"
    "alter table pw_schema_migrations enable row level security;\n"
    "revoke all on pw_schema_migrations from anon, authenticated;\n"
)
NUM_RE = re.compile(r"^(\d+)_.*\.sql$")
# Same patterns as apps/cloud/scripts/migrate.py (SELF_TX_BEGIN_RE,
# TOP_LEVEL_COMMIT_RE): a line the runner would treat as a top-level
# transaction statement.
BEGIN_LINE_RE = re.compile(r"^[ \t]*begin[ \t]*;[ \t]*$", re.MULTILINE | re.IGNORECASE)
COMMIT_LINE_RE = re.compile(r"^[ \t]*commit[ \t]*;[ \t]*$", re.MULTILINE | re.IGNORECASE)


def load_token_map() -> Callable[[str], str]:
    """The rename's own text -> text function, `rename_text` from
    scripts/rename/patterns.py. Imported, never re-implemented, so the
    baseline and the rest of the tree can't disagree on a token."""
    path = REPO_ROOT / "scripts" / "rename" / "patterns.py"
    spec = importlib.util.spec_from_file_location("pw_rename_patterns", path)
    if spec is None or spec.loader is None or not path.exists():
        raise SystemExit(f"token map not found: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.rename_text


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=REPO_ROOT, check=True, capture_output=True, text=True
    ).stdout


def read_sources(tag: str) -> list[tuple[int, str, str]]:
    """(number, filename, text) for every migration at `tag`, numerically sorted."""
    names = git("ls-tree", "--name-only", f"{tag}:{SOURCE_DIR}").split()
    sources = []
    for name in names:
        match = NUM_RE.match(name)
        if match:
            sources.append((int(match.group(1)), name, git("show", f"{tag}:{SOURCE_DIR}/{name}")))
    sources.sort()
    numbers = [n for n, _, _ in sources]
    if numbers != list(range(1, EXPECTED_SOURCE_COUNT + 1)):
        raise SystemExit(
            f"expected migrations 0001..{EXPECTED_SOURCE_COUNT:04d} at {tag}, got {numbers}"
        )
    return sources


def strip_self_transaction(filename: str, text: str) -> str:
    """Remove the one top-level begin; and the one top-level commit;, leaving
    a comment in their place so the edit is visible in the baseline."""
    if len(BEGIN_LINE_RE.findall(text)) != 1 or len(COMMIT_LINE_RE.findall(text)) != 1:
        raise SystemExit(f"{filename}: expected exactly one top-level begin; and commit;")
    note = "-- [build_baseline.py] top-level {} removed: the runner wraps this whole file."
    text = BEGIN_LINE_RE.sub(note.format("begin;"), text)
    return COMMIT_LINE_RE.sub(note.format("commit;"), text)


def build(tag: str, token_map: Callable[[str], str]) -> tuple[dict[str, str], dict[str, str]]:
    """Returns ({output filename: text}, {source filename: mapped text})."""
    sha = git("rev-parse", f"{tag}^{{commit}}").strip()
    sources = read_sources(tag)
    mapped = {name: token_map(text) for _, name, text in sources}

    for number, name, _ in sources:
        has_tx = bool(BEGIN_LINE_RE.search(mapped[name]) or COMMIT_LINE_RE.search(mapped[name]))
        if has_tx and number != SELF_TX_SOURCE_NUMBER:
            raise SystemExit(f"{name}: unexpected top-level begin;/commit; (only 0023 has one)")

    provenance = f"tag {tag} (commit {sha})"
    ledger_name = next(name for n, name, _ in sources if n == LEDGER_SOURCE_NUMBER)
    ledger = (
        f"-- GENERATED by scripts/baseline/build_baseline.py from {SOURCE_DIR}/{ledger_name}\n"
        f"-- at {provenance}, token-mapped. Do not edit; regenerate.\n"
        "-- scripts/migrate.py applies it first on a fresh database (LEDGER_MIGRATION_NUMBER).\n"
        "--\n"
        f"{mapped[ledger_name]}"
        f"{LEDGER_HARDENING}"
    )

    parts = [
        "-- 0002 — PromptWorkspace baseline schema\n"
        "--\n"
        "-- migration-runner: requires-vars=embed_dim\n"
        "--\n"
        "-- GENERATED by scripts/baseline/build_baseline.py — do not edit; regenerate.\n"
        f"-- Source: {SOURCE_DIR}/0001-0036 at\n"
        f"-- {provenance},\n"
        "-- each passed through the rename token map (scripts/rename/patterns.py) and\n"
        "-- concatenated in numeric order. 0024 (the ledger) is\n"
        f"-- {LEDGER_OUT} instead. 0023's own top-level\n"
        "-- begin;/commit; are removed, so this file is not self-transactional:\n"
        "-- scripts/migrate.py runs it under psql --single-transaction. 0023's\n"
        "-- \\if :{?embed_dim} guard is kept for plain-psql runs. Per-file history and\n"
        "-- the old file names live only at that tag. Proven equivalent to the 36-file\n"
        "-- chain by scripts/baseline/verify_squash.sh.\n"
        "--\n"
        "--     python scripts/migrate.py apply --var embed_dim=<N>\n"
    ]
    for number, name, _ in sources:
        if number == LEDGER_SOURCE_NUMBER:
            continue
        text = mapped[name]
        if number == SELF_TX_SOURCE_NUMBER:
            text = strip_self_transaction(name, text)
        if not text.endswith("\n"):
            text += "\n"
        bar = "-" * 76
        parts.append(f"\n-- {bar}\n-- {name} (at {tag})\n-- {bar}\n\n{text}")
    return {LEDGER_OUT: ledger, BASELINE_OUT: "".join(parts)}, mapped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tag", default=TAG_DEFAULT)
    parser.add_argument("--out", type=Path, default=OUT_DIR_DEFAULT)
    parser.add_argument("--intermediate", type=Path, help="also write each mapped source here")
    parser.add_argument("--check", action="store_true", help="compare with --out, don't write")
    args = parser.parse_args(argv)

    outputs, mapped = build(args.tag, load_token_map())

    if args.check:
        stale = [n for n, t in outputs.items() if not (args.out / n).exists()
                 or (args.out / n).read_text() != t]
        others = sorted(p.name for p in args.out.glob("*.sql") if p.name not in outputs)
        for name in stale:
            print(f"stale: {args.out / name}", file=sys.stderr)
        for name in others:
            print(f"unexpected: {args.out / name}", file=sys.stderr)
        return 1 if stale or others else 0

    args.out.mkdir(parents=True, exist_ok=True)
    for name, text in outputs.items():
        (args.out / name).write_text(text)
        print(f"wrote {args.out / name}")
    if args.intermediate:
        args.intermediate.mkdir(parents=True, exist_ok=True)
        for name, text in mapped.items():
            (args.intermediate / name).write_text(text)
        print(f"wrote {len(mapped)} mapped source files to {args.intermediate}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
