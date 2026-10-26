#!/usr/bin/env python3
"""Every migration after the baseline must be additive (plan 0034).

Applying migrations automatically on start is only safe when a migration cannot
break the code that is still running. This scans apps/cloud/migrations/*.sql
(numeric prefix above 2) for statements that remove or reshape existing
objects and exits 1 listing file and kind.

Comments, single-quoted strings and dollar-quoted *literals* are ignored. A
dollar-quoted body that belongs to a function, procedure or DO block is real
SQL and is scanned.

Waiver: a line `-- migration-gate: allow-destructive <reason>` (reason of at
least 10 characters) anywhere in the file.

Never edit an applied migration to satisfy this rule: the ledger stores a
checksum per file. Put a legacy file in LEGACY_ALLOWED instead.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

DEFAULT_DIR = Path(__file__).resolve().parent.parent.parent / "apps" / "cloud" / "migrations"

# filename -> reason. Empty: no existing migration trips the rule.
LEGACY_ALLOWED: dict[str, str] = {}

WAIVER = re.compile(r"^[ \t]*--[ \t]*migration-gate:[ \t]*allow-destructive[ \t]+(\S.{9,}?)[ \t]*$", re.M)

KINDS: list[tuple[str, re.Pattern[str]]] = [
    ("drop table", re.compile(r"\bdrop\s+table\b")),
    ("drop column", re.compile(r"\bdrop\s+column\b")),
    ("drop schema", re.compile(r"\bdrop\s+schema\b")),
    ("drop type", re.compile(r"\bdrop\s+type\b")),
    ("drop function", re.compile(r"\bdrop\s+function\b")),
    ("truncate", re.compile(r"\btruncate\b(?!\s*\()")),
    ("rename", re.compile(r"\brename\b")),
    ("alter column type", re.compile(r"\balter\s+column\s+\S+\s+(?:set\s+data\s+)?type\b")),
]

_DOLLAR = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
_CODE_HEAD = re.compile(r"\b(function|procedure|do)\b")


def _strip(sql: str) -> str:
    """Lowercased SQL with comments and literals blanked out."""
    out: list[str] = []
    i, n = 0, len(sql)
    stmt_start = 0  # index in `out` joined text is awkward; track head text instead
    head: list[str] = []  # code since the last ';' at this level
    while i < n:
        c = sql[i]
        if sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
            continue
        if sql.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if sql.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif sql.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            out.append(" ")
            head.append(" ")
            continue
        if c == "'":
            i += 1
            while i < n:
                if sql[i] == "'":
                    if sql.startswith("''", i):
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append(" '' ")
            head.append(" '' ")
            continue
        if c == '"':
            j = sql.find('"', i + 1)
            j = n - 1 if j < 0 else j
            out.append(' "x" ')
            head.append(' "x" ')
            i = j + 1
            continue
        if c == "$":
            m = _DOLLAR.match(sql, i)
            if m:
                tag = m.group(0)
                end = sql.find(tag, m.end())
                body_end = n if end < 0 else end
                body = sql[m.end() : body_end]
                if _CODE_HEAD.search("".join(head).lower()):
                    out.append(" ; " + _strip(body) + " ; ")
                else:
                    out.append(" '' ")
                i = n if end < 0 else end + len(tag)
                continue
        if c == ";":
            head = []
        else:
            head.append(c)
        out.append(c)
        i += 1
    del stmt_start
    return "".join(out).lower()


def find_destructive(sql: str, honour_waiver: bool = True) -> list[str]:
    """Statement kinds in `sql` that are not additive; [] if clean or waived."""
    if honour_waiver and WAIVER.search(sql):
        return []
    text = _strip(sql)
    # `create trigger ... before truncate on t` names an event, not a truncation.
    text = re.sub(r"\b(?:before|after|or)\s+truncate\b", " ", text)
    return [kind for kind, pattern in KINDS if pattern.search(text)]


def _number(path: Path) -> int | None:
    m = re.match(r"(\d+)_", path.name)
    return int(m.group(1)) if m else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="migrations directory")
    args = parser.parse_args(argv)

    failures: list[str] = []
    for path in sorted(args.dir.glob("*.sql")):
        number = _number(path)
        if number is None or number <= 2 or path.name in LEGACY_ALLOWED:
            continue
        for kind in find_destructive(path.read_text(encoding="utf-8")):
            failures.append(f"{path.name}: {kind}")
    if failures:
        print("Non-additive migrations (add `-- migration-gate: allow-destructive <reason>`")
        print("only for a reviewed, deliberate removal):")
        for line in failures:
            print(f"  {line}")
        return 1
    print("migrations after 0002 are additive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
