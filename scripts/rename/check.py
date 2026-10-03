#!/usr/bin/env python3
"""Rename gate: fail if any token-map left-hand side survives in the tree.

Searches every tracked text file (minus the dated historical docs, the lockfile
and the rename tooling) for the exact alternation ``rename.py`` rewrites, after
blanking out the token spans listed in ``scripts/rename-allowlist-patterns.txt``.
Allowlist entries match spans, not lines, so a line holding both an allowed
``promptconnext.com`` and a stray ``pz_`` still fails. Exits 1 on any hit.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from patterns import residual_hits  # noqa: E402
from rename import HISTORICAL, TOOLING, read_text, tracked_files  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST_FILE = ROOT / "scripts" / "rename-allowlist-patterns.txt"
EXCLUDE = re.compile("|".join(HISTORICAL + TOOLING))


def load_allowlist(path: Path = ALLOWLIST_FILE) -> re.Pattern[str]:
    entries = [
        line.rstrip("\n")
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    return re.compile("|".join(f"(?:{e})" for e in entries))


def main() -> int:
    allow = load_allowlist()
    hits = 0
    for rel in tracked_files(ROOT):
        if EXCLUDE.search(rel):
            continue
        for _, token in residual_hits(rel, allow):
            print(f"{rel}: path contains {token!r}")
            hits += 1
        path = ROOT / rel
        if not path.is_file():
            continue
        text = read_text(path)
        if text is None:
            continue
        lines = text.splitlines()
        for line_no, token in residual_hits(text, allow):
            print(f"{rel}:{line_no}: {token!r}: {lines[line_no - 1].strip()[:160]}")
            hits += 1
    if hits:
        print(f"rename-check: {hits} non-allowlisted hit(s)", file=sys.stderr)
        return 1
    print("rename-check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
