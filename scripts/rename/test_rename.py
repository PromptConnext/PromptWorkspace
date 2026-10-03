"""Fixture tests for the token map and the gate.

Run: python3 -m pytest -q scripts/rename/test_rename.py
 or: python3 -m unittest scripts/rename/test_rename.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check import load_allowlist  # noqa: E402
from patterns import PROTECTED, rename_text, residual_hits  # noqa: E402

FIXTURES = [
    ("idx_pz_tasks_project", "idx_pw_tasks_project"),
    ("pz_tasks", "pw_tasks"),
    ("xpz_y", "xpz_y"),
    ("PZ_WEB_ORIGIN", "PROMPTWORKSPACE_WEB_ORIGIN"),
    ("APP_PZ_X", "APP_PROMPTWORKSPACE_X"),
    ("XPZ_Y", "XPZ_Y"),
    ("@promptconnext/pz-cloud", "@promptworkspace/cloud-client"),
    ("github.com/PromptConnext/PromptWorkspace", "github.com/PromptConnext/PromptWorkspace"),
    (
        "github.com/PromptConnext/promptconnext-corp-web",
        "github.com/PromptConnext/promptconnext-corp-web",
    ),
    ("git@github.com:PromptConnext/PromptWorkspace.git", "git@github.com:PromptConnext/PromptWorkspace.git"),
    ("promptconnext-corp-web", "promptconnext-corp-web"),
    ("promptconnext-projects", "promptconnext-projects"),
    ("[PromptConnext/promptconnext-corp-web]", "[PromptConnext/promptconnext-corp-web]"),
    ('"publisher": "promptconnext"', '"publisher": "promptconnext"'),
    ("promptconnext.promptconnext-vscode", "promptconnext.promptworkspace"),
    ("promptconnext.promptworkspace", "promptconnext.promptworkspace"),
    ("promptconnext.promptworkspaceX", "promptworkspace.promptworkspaceX"),
    ("promptconnext.commitScanLimit", "promptworkspace.commitScanLimit"),
    ("https://promptconnext.com", "https://promptconnext.com"),
    ("https://promptconnext.com/pricing", "https://promptconnext.com/pricing"),
    ("https://api.workspace.promptconnext.com", "https://api.workspace.promptconnext.com"),
    ("https://promptconnext.truthledgers.com", "https://promptconnext.truthledgers.com"),
    ("no-reply@promptconnext.com", "no-reply@promptconnext.com"),
    ("© 2026 PromptConnext", "© 2026 PromptConnext"),
    ("Copyright (c) 2026 PromptConnext. All rights reserved.", "Copyright (c) 2026 PromptConnext. All rights reserved."),
    ("hosted by PromptConnext", "hosted by PromptConnext"),
    ("managed by PromptConnext — nothing to connect", "managed by PromptConnext — nothing to connect"),
    ("seeded by PromptConnext Cloud", "seeded by PromptWorkspace Cloud"),
    ("hosted by PromptConnext Cloud", "hosted by PromptWorkspace Cloud"),
    ("written by PromptConnext", "written by PromptWorkspace"),
    ('PRE_BASELINE_TABLE_PREFIX = "pz_"', 'PRE_BASELINE_TABLE_PREFIX = "pz_"'),
    ('OTHER_PREFIX = "pz_"', 'OTHER_PREFIX = "pw_"'),
    ("PromptConnext workspace", "PromptWorkspace workspace"),
    ("PROMPTCONNEXT_CLOUD_API_URL", "PROMPTWORKSPACE_CLOUD_API_URL"),
    ("window.__PROMPTCONNEXT_TOKEN__", "window.__PROMPTWORKSPACE_TOKEN__"),
    ("promptconnext://auth/callback", "promptworkspace://auth/callback"),
    ("dev.ideva.promptconnext", "com.promptconnext.promptworkspace"),
    ("com.promptconnext.promptworkspace", "com.promptconnext.promptworkspace"),
    ("@promptconnext/mcp", "@promptworkspace/mcp"),
    ("promptconnext-mcp", "promptworkspace-mcp"),
    ("promptconnext-vscode-0.2.1.vsix", "promptworkspace-0.2.1.vsix"),
    ("packages/pz-cloud", "packages/cloud-client"),
    ("outputs.pz_cloud", "outputs.cloud_client"),
    ("pz-documents", "pw-documents"),
    ("./pz-preview.js", "./pw-preview.js"),
    ("PromptZone", "PromptWorkspace"),
    ("docs/promptzone", "docs/promptworkspace"),
    ("PROMPTZONE_DOCS_DIR", "PROMPTWORKSPACE_DOCS_DIR"),
    ("pz_is_member(ws)", "pw_is_member(ws)"),
    ("Promptconnext", "Promptworkspace"),
    ("see promptzone-product-roadmap.md", "see promptzone-product-roadmap.md"),
    ("PZ-1 closes", "PZ-1 closes"),
]


class RenameTextTest(unittest.TestCase):
    def test_fixtures(self) -> None:
        for src, want in FIXTURES:
            with self.subTest(src=src):
                self.assertEqual(rename_text(src), want)

    def test_single_pass_no_cascade(self) -> None:
        # The replacement of one token is never re-scanned by another rule.
        # Outputs that still contain "promptconnext" are not re-mapped.
        self.assertEqual(rename_text("dev.ideva.promptconnext"), "com.promptconnext.promptworkspace")
        self.assertEqual(
            rename_text("vscode://promptconnext.promptconnext-vscode/auth"),
            "vscode://promptconnext.promptworkspace/auth",
        )

    def test_mixed_line(self) -> None:
        line = "see https://promptconnext.com and table pz_tasks in PromptConnext"
        self.assertEqual(
            rename_text(line),
            "see https://promptconnext.com and table pw_tasks in PromptWorkspace",
        )

    def test_idempotent(self) -> None:
        for src, _ in FIXTURES:
            once = rename_text(src)
            with self.subTest(src=src):
                self.assertEqual(rename_text(once), once)

    def test_multiline_company_span(self) -> None:
        text = "a signed VSIX supplied by\nPromptConnext — you may install"
        self.assertEqual(rename_text(text), text)


class GateTest(unittest.TestCase):
    allow = load_allowlist()

    def test_renamed_fixtures_pass_the_gate(self) -> None:
        for src, _ in FIXTURES:
            with self.subTest(src=src):
                self.assertEqual(residual_hits(rename_text(src), self.allow), [])

    def test_gate_flags_every_unrenamed_change(self) -> None:
        for src, want in FIXTURES:
            if src != want:
                with self.subTest(src=src):
                    self.assertNotEqual(residual_hits(src, self.allow), [])

    def test_allowlisted_span_does_not_hide_stray_token(self) -> None:
        hits = residual_hits("https://promptconnext.com pz_tasks", self.allow)
        self.assertEqual(hits, [(1, "pz_")])

    def test_line_numbers(self) -> None:
        self.assertEqual(residual_hits("ok\nok\nPZ_X", self.allow), [(3, "PZ_")])

    def test_allowlist_covers_every_protected_span(self) -> None:
        listed = {
            line
            for line in Path(__file__).resolve().parents[1]
            .joinpath("rename-allowlist-patterns.txt")
            .read_text(encoding="utf-8")
            .splitlines()
        }
        for p in PROTECTED:
            if p.startswith(r"com\.promptconnext\."):
                continue  # allowlisted as the full Tauri id span
            with self.subTest(pattern=p):
                self.assertIn(p, listed)


if __name__ == "__main__":
    unittest.main()
