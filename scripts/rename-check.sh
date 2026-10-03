#!/usr/bin/env bash
# Rename gate + its fixture tests. Same patterns as the map (scripts/rename/patterns.py).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
python3 -m unittest -q scripts/rename/test_rename.py
python3 scripts/rename/check.py
