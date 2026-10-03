#!/usr/bin/env python3
"""Apply the PromptConnext -> PromptWorkspace token map to the tracked tree.

Usage (from the repo root)::

    python3 scripts/rename/rename.py            # rewrite contents, git mv paths
    python3 scripts/rename/rename.py --dry-run  # report only

Scope is ``git ls-files`` minus ``EXCLUDE`` (dated historical docs per D3, the
lockfile, vendored files, the rename tooling itself, and the migration paths the
baseline generator owns) and minus binary files. Paths are renamed with
``git mv`` through the same map, e.g. ``packages/pz-cloud`` ->
``packages/cloud-client``.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from patterns import rename_text  # noqa: E402

# Whole-file exclusions shared with check.py.
HISTORICAL = [
    r"^docs/(plans|decisions|reports|superpowers|overnight|research)/",
    r"^docs/product-vision-",
    r"^docs/promptzone-",
]
TOOLING = [
    r"^pnpm-lock\.yaml$",
    r"^scripts/rename/",
    r"^scripts/rename-allowlist-patterns\.txt$",
    r"^docs/rename-allowlist\.md$",
]
# Vendored byte-for-byte copies (their drift tests compare against upstream).
VENDORED = [r"^apps/vscode/src/git/git\.d\.ts$"]
# Owned by the baseline generator (P2): never token-mapped in place.
BASELINE_OWNED = [
    r"^apps/cloud/migrations/",
    r"^apps/cloud/scripts/",
    r"^apps/cloud/tests/test_migrate\.py$",
    r"^scripts/baseline/",
]
EXCLUDE = re.compile("|".join(HISTORICAL + TOOLING + VENDORED + BASELINE_OWNED))


def tracked_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True
    ).stdout.decode()
    return [p for p in out.split("\0") if p]


def read_text(path: Path) -> str | None:
    """Return the file's text, or None for binary / non-UTF-8 files."""
    data = path.read_bytes()
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    root = Path(
        subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True
        ).stdout.strip()
    )

    changed = moved = 0
    for rel in tracked_files(root):
        if EXCLUDE.search(rel):
            continue
        path = root / rel
        if not path.is_file():
            continue
        text = read_text(path)
        if text is not None:
            new = rename_text(text)
            if new != text:
                changed += 1
                if not args.dry_run:
                    path.write_text(new, encoding="utf-8")
        new_rel = rename_text(rel)
        if new_rel != rel:
            moved += 1
            print(f"mv {rel} -> {new_rel}")
            if not args.dry_run:
                (root / new_rel).parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(["git", "mv", rel, new_rel], cwd=root, check=True)
    print(f"{'would change' if args.dry_run else 'changed'} {changed} files, moved {moved} paths")
    return 0


if __name__ == "__main__":
    sys.exit(main())
