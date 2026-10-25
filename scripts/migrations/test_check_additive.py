"""Tests for the additive-migration rule.

Run: python3 -m unittest scripts/migrations/test_check_additive.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check_additive as ca  # noqa: E402

REPO = HERE.parent.parent


class FindDestructive(unittest.TestCase):
    def test_drop_column_in_real_sql_is_flagged(self):
        self.assertEqual(ca.find_destructive("alter table t drop column c;"), ["drop column"])

    def test_drop_column_in_a_line_comment_is_ignored(self):
        self.assertEqual(ca.find_destructive("-- alter table t drop column c;\nselect 1;"), [])

    def test_drop_column_in_a_block_comment_is_ignored(self):
        self.assertEqual(ca.find_destructive("/* alter table t\n drop column c */ select 1;"), [])

    def test_drop_column_inside_a_string_literal_is_ignored(self):
        self.assertEqual(ca.find_destructive("comment on table t is 'we drop column c later';"), [])
        self.assertEqual(
            ca.find_destructive("comment on table t is $$ drop table x; $$;"),
            [],
        )
        self.assertEqual(ca.find_destructive("select 'it''s drop table x';"), [])

    def test_drop_column_inside_a_function_body_is_flagged(self):
        sql = "create function f() returns void language plpgsql as $$ begin\n" \
              "alter table t drop column c; end $$;"
        self.assertEqual(ca.find_destructive(sql), ["drop column"])
        tagged = "create or replace function f() returns void as $body$ truncate t; $body$;"
        self.assertEqual(ca.find_destructive(tagged), ["truncate"])

    def test_drop_constraint_and_drop_not_null_are_allowed(self):
        sql = (
            "alter table t drop constraint c;\n"
            "alter table t alter column a drop not null;\n"
            "alter table t alter column a drop default;\n"
            "drop index i; drop trigger tr on t; drop policy p on t;"
        )
        self.assertEqual(ca.find_destructive(sql), [])

    def test_create_or_replace_function_is_allowed(self):
        sql = "create or replace function f() returns int language sql as $$ select 1 $$;"
        self.assertEqual(ca.find_destructive(sql), [])

    def test_allow_marker_with_reason_waives(self):
        sql = "-- migration-gate: allow-destructive column is unused since 0012\ndrop table t;"
        self.assertEqual(ca.find_destructive(sql), [])

    def test_allow_marker_without_a_reason_does_not(self):
        for marker in (
            "-- migration-gate: allow-destructive",
            "-- migration-gate: allow-destructive short",
        ):
            self.assertEqual(ca.find_destructive(marker + "\ndrop table t;"), ["drop table"])

    def test_rename_and_alter_type_are_flagged(self):
        sql = (
            "alter table t rename to u;\n"
            "alter table u rename column a to b;\n"
            "alter table u alter column b type bigint;\n"
            "alter table u alter column b set data type text;\n"
            "drop schema s; drop type y; drop function f(); drop table z; truncate z;"
        )
        self.assertEqual(
            sorted(set(ca.find_destructive(sql))),
            sorted(
                {
                    "rename",
                    "alter column type",
                    "drop schema",
                    "drop type",
                    "drop function",
                    "drop table",
                    "truncate",
                }
            ),
        )

    def test_truncate_trigger_event_is_not_a_truncation(self):
        sql = "create trigger x before truncate on t for each statement execute function f();"
        self.assertEqual(ca.find_destructive(sql), [])
        self.assertEqual(ca.find_destructive("create trigger x before update or truncate on t"
                                             " for each statement execute function f();"), [])

    def test_date_trunc_is_not_truncate(self):
        self.assertEqual(ca.find_destructive("select date_trunc('day', now());"), [])
        self.assertEqual(ca.find_destructive("select truncate(1.5);"), [])


class Cli(unittest.TestCase):
    def run_cli(self, directory: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(HERE / "check_additive.py"), "--dir", str(directory)],
            capture_output=True,
            text=True,
        )

    def test_cli_lists_file_and_kind_and_exits_1(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "0003_bad.sql").write_text("alter table t drop column c;")
            (Path(d) / "0004_ok.sql").write_text("alter table t add column c int;")
            (Path(d) / "0002_baseline.sql").write_text("drop table t;")  # baseline exempt
            r = self.run_cli(Path(d))
        self.assertEqual(r.returncode, 1)
        self.assertIn("0003_bad.sql", r.stdout + r.stderr)
        self.assertIn("drop column", r.stdout + r.stderr)
        self.assertNotIn("0004_ok.sql", r.stdout + r.stderr)
        self.assertNotIn("0002_baseline.sql", r.stdout + r.stderr)

    def test_all_repository_migrations_above_0002_pass(self):
        r = self.run_cli(REPO / "apps" / "cloud" / "migrations")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_legacy_allowed_entries_still_exist_and_still_trip(self):
        migrations = REPO / "apps" / "cloud" / "migrations"
        for name, reason in ca.LEGACY_ALLOWED.items():
            self.assertTrue(reason.strip(), name)
            path = migrations / name
            self.assertTrue(path.exists(), f"{name} no longer exists; drop it from LEGACY_ALLOWED")
            self.assertTrue(
                ca.find_destructive(path.read_text(), honour_waiver=False),
                f"{name} no longer trips the rule; drop it from LEGACY_ALLOWED",
            )


if __name__ == "__main__":
    unittest.main()
