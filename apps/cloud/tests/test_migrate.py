"""Unit tests for scripts/migrate.py — everything here is pure-function
logic exercised without a live database. Live-database behaviour (actually
applying migrations, rolling back on failure, refusing a tampered checksum,
0023's required variable end to end, and — added for `status` — the
no-ledger/fully-migrated/partial/adopted/drifted cases plus a read-only
proof) was exercised by hand against a throwaway pgvector/pgvector:pg16
Docker container; see .claude/overnight/logs/mig-task-3-report.md and
.claude/overnight/logs/mig-task-5-report.md for those session transcripts —
deliberately not repeated here as automated tests, since this suite must
stay runnable with no live database and no new dependencies."""

from __future__ import annotations

from pathlib import Path

import pytest

from scripts import migrate


def write(tmp_path: Path, name: str, content: str) -> Path:
    path = tmp_path / name
    path.write_text(content)
    return path


# --- discovery / ordering ---------------------------------------------------


def test_discover_migrations_sorts_numerically_not_lexicographically(tmp_path):
    # Lexicographic sort would put 0010 before 0002; numeric sort must not.
    write(tmp_path, "0002_b.sql", "select 1;")
    write(tmp_path, "0010_j.sql", "select 1;")
    write(tmp_path, "0001_a.sql", "select 1;")

    migrations = migrate.discover_migrations(tmp_path)

    assert [m.filename for m in migrations] == ["0001_a.sql", "0002_b.sql", "0010_j.sql"]


def test_migration_number_rejects_files_with_no_numeric_prefix(tmp_path):
    bad = write(tmp_path, "not_numbered.sql", "select 1;")
    with pytest.raises(migrate.MigrationError):
        _ = migrate.Migration(bad).number


# --- checksum ----------------------------------------------------------------


def test_checksum_matches_hashlib_sha256_of_raw_bytes(tmp_path):
    import hashlib

    path = write(tmp_path, "0001_x.sql", "select 1;\n")
    expected = hashlib.sha256(path.read_bytes()).hexdigest()

    assert migrate.Migration(path).checksum() == expected


def test_checksum_changes_when_file_content_changes(tmp_path):
    path = write(tmp_path, "0001_x.sql", "select 1;\n")
    before = migrate.Migration(path).checksum()
    path.write_text("select 2;\n")
    after = migrate.Migration(path).checksum()

    assert before != after


# --- header parsing: required-vars convention ---------------------------------


def test_required_vars_absent_by_default(tmp_path):
    path = write(tmp_path, "0001_x.sql", "-- a plain migration\ncreate table t (id int);\n")
    assert migrate.Migration(path).required_vars() == []


def test_required_vars_parses_single_var(tmp_path):
    path = write(
        tmp_path,
        "0002_x.sql",
        "-- header\n-- migration-runner: requires-vars=embed_dim\nselect 1;\n",
    )
    assert migrate.Migration(path).required_vars() == ["embed_dim"]


def test_required_vars_parses_multiple_comma_separated(tmp_path):
    path = write(
        tmp_path,
        "0002_x.sql",
        "-- migration-runner: requires-vars=foo, bar ,baz\nselect 1;\n",
    )
    assert migrate.Migration(path).required_vars() == ["foo", "bar", "baz"]


def test_real_0023_declares_embed_dim():
    """Regression guard tying the real repo file to the convention this
    runner reads — if someone edits 0023's header and drops the
    declaration, this test fails instead of the runner silently applying a
    destructive migration with no guard."""
    path = migrate.MIGRATIONS_DIR_DEFAULT / "0023_configurable_embed_dim.sql"
    assert path.exists(), "expected apps/cloud/migrations/0023_configurable_embed_dim.sql to exist"
    assert migrate.Migration(path).required_vars() == ["embed_dim"]


# --- self-transactional detection + splicing ----------------------------------


def test_plain_migration_is_not_self_transactional(tmp_path):
    path = write(tmp_path, "0001_x.sql", "create table t (id int);\n")
    assert migrate.Migration(path).is_self_transactional() is False


def test_migration_with_begin_commit_is_self_transactional(tmp_path):
    path = write(tmp_path, "0002_x.sql", "begin;\ncreate table t (id int);\ncommit;\n")
    assert migrate.Migration(path).is_self_transactional() is True


def test_build_execution_script_appends_for_plain_migration_and_wants_single_tx(tmp_path):
    path = write(tmp_path, "0001_x.sql", "create table t (id int);\n")
    script, single_tx = migrate.build_execution_script(migrate.Migration(path))

    assert single_tx is True
    assert script.startswith("create table t (id int);")
    assert "insert into pz_schema_migrations" in script
    # ledger write must come after the migration's own SQL
    assert script.index("create table") < script.index("insert into pz_schema_migrations")


def test_build_execution_script_splices_before_final_commit_for_self_tx_migration(tmp_path):
    path = write(
        tmp_path,
        "0002_x.sql",
        "begin;\ncreate table t (id int);\ncommit;\n",
    )
    script, single_tx = migrate.build_execution_script(migrate.Migration(path))

    assert single_tx is False
    insert_pos = script.index("insert into pz_schema_migrations")
    create_pos = script.index("create table")
    commit_pos = script.rindex("commit;")
    # ledger write lands between the migration's own DDL and its own commit
    assert create_pos < insert_pos < commit_pos


def test_build_execution_script_raises_if_self_tx_has_no_commit(tmp_path):
    path = write(tmp_path, "0002_x.sql", "begin;\ncreate table t (id int);\n")
    with pytest.raises(migrate.MigrationError):
        migrate.build_execution_script(migrate.Migration(path))


# --- pending calculation + checksum-mismatch detection -------------------------


def _migrations(tmp_path, names):
    return [migrate.Migration(write(tmp_path, n, f"-- {n}\nselect 1;\n")) for n in names]


def test_pending_migrations_excludes_ledger_entries(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql", "0002_b.sql", "0003_c.sql"])
    ledger = {"0001_a.sql": migrations[0].checksum()}

    pending = migrate.pending_migrations(migrations, ledger)

    assert [m.filename for m in pending] == ["0002_b.sql", "0003_c.sql"]


def test_pending_migrations_all_pending_on_empty_ledger(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql", "0002_b.sql"])
    assert migrate.pending_migrations(migrations, {}) == migrations


def test_find_checksum_mismatches_detects_tampered_applied_file(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql"])
    ledger = {"0001_a.sql": "0" * 64}  # wrong checksum, as if the file changed post-apply

    mismatches = migrate.find_checksum_mismatches(migrations, ledger)

    assert mismatches == [("0001_a.sql", "0" * 64, migrations[0].checksum())]


def test_find_checksum_mismatches_clean_when_checksums_match(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql"])
    ledger = {"0001_a.sql": migrations[0].checksum()}

    assert migrate.find_checksum_mismatches(migrations, ledger) == []


def test_find_checksum_mismatches_ignores_files_not_yet_in_ledger(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql", "0002_b.sql"])
    ledger = {"0001_a.sql": migrations[0].checksum()}

    assert migrate.find_checksum_mismatches(migrations, ledger) == []


# --- CLI plumbing --------------------------------------------------------------


def test_parse_vars_builds_dict():
    assert migrate.parse_vars(["embed_dim=1024", "foo=bar"]) == {"embed_dim": "1024", "foo": "bar"}


def test_parse_vars_empty_when_none():
    assert migrate.parse_vars(None) == {}


def test_parse_vars_rejects_missing_equals():
    with pytest.raises(migrate.MigrationError):
        migrate.parse_vars(["embed_dim"])


def test_redact_hides_password_in_db_url():
    assert migrate.redact("postgres://user:hunter2@host:5432/db") == "postgres://user:***@host:5432/db"


def test_redact_leaves_url_without_credentials_alone():
    assert migrate.redact("postgres://host:5432/db") == "postgres://host:5432/db"


def test_resolve_db_url_prefers_explicit_flag(monkeypatch):
    # --db-url is a top-level parser argument, so it must precede the
    # subcommand (`--db-url ... apply`, not `apply --db-url ...`) — this is
    # how every live invocation in this task's verification session used it.
    monkeypatch.setenv("DATABASE_URL", "postgres://from-env/db")
    args = migrate.build_parser().parse_args(["--db-url", "postgres://from-flag/db", "apply"])
    assert migrate.resolve_db_url(args) == "postgres://from-flag/db"


def test_resolve_db_url_falls_back_to_database_url_env(monkeypatch):
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgres://from-env/db")
    args = migrate.build_parser().parse_args(["apply"])
    assert migrate.resolve_db_url(args) == "postgres://from-env/db"


def test_resolve_db_url_raises_when_nothing_set(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    args = migrate.build_parser().parse_args(["apply"])
    with pytest.raises(migrate.MigrationError):
        migrate.resolve_db_url(args)


def test_adopt_through_0024_or_later_is_rejected(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", "postgres://unused/db")
    write(tmp_path, "0024_schema_migrations_ledger.sql", "create table pz_schema_migrations ();\n")
    args = migrate.build_parser().parse_args(
        ["--migrations-dir", str(tmp_path), "adopt", "--through", "0024", "--yes"]
    )
    assert migrate.cmd_adopt(args) != 0


# --- status: ledger row parsing -------------------------------------------------


def test_parse_ledger_rows_splits_tab_separated_columns():
    output = "0001_a.sql\tabc123\t2026-08-01T00:00:00Z\tpostgres\tapplied\t\n"
    rows = migrate.parse_ledger_rows(output)
    assert rows == [
        migrate.LedgerEntry(
            "0001_a.sql", "abc123", "2026-08-01T00:00:00Z", "postgres", "applied", ""
        )
    ]


def test_parse_ledger_rows_keeps_notes_with_embedded_tab_in_last_field():
    output = "0001_a.sql\tabc123\t2026-08-01T00:00:00Z\tpostgres\tadopted\tnote\twith tab\n"
    rows = migrate.parse_ledger_rows(output)
    assert rows[0].notes == "note\twith tab"


def test_parse_ledger_rows_skips_blank_lines():
    output = "0001_a.sql\tabc\t2026-08-01T00:00:00Z\tpostgres\tapplied\t\n\n"
    rows = migrate.parse_ledger_rows(output)
    assert len(rows) == 1


def test_parse_ledger_rows_rejects_malformed_row():
    with pytest.raises(migrate.MigrationError):
        migrate.parse_ledger_rows("not-enough-columns\n")


# --- status: report construction -------------------------------------------------


def _entry(filename, checksum, source="applied", notes=""):
    return migrate.LedgerEntry(
        filename, checksum, "2026-08-01T00:00:00Z", "postgres", source, notes
    )


def test_build_status_report_no_ledger_marks_all_pending(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql", "0002_b.sql"])
    report = migrate.build_status_report(migrations, ledger_present=False, ledger_rows=[])

    assert report.ledger_present is False
    assert report.applied == []
    assert report.pending == migrations
    assert report.orphaned == []
    assert report.mismatches == []


def test_build_status_report_splits_applied_and_pending(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql", "0002_b.sql", "0003_c.sql"])
    ledger_rows = [
        _entry("0001_a.sql", migrations[0].checksum(), source="applied"),
        _entry("0002_b.sql", migrations[1].checksum(), source="adopted", notes="adopted by ops"),
    ]

    report = migrate.build_status_report(migrations, ledger_present=True, ledger_rows=ledger_rows)

    assert [e.filename for e in report.applied] == ["0001_a.sql", "0002_b.sql"]
    assert [e.source for e in report.applied] == ["applied", "adopted"]
    assert [m.filename for m in report.pending] == ["0003_c.sql"]
    assert report.mismatches == []
    assert report.orphaned == []


def test_build_status_report_detects_checksum_drift(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql"])
    ledger_rows = [_entry("0001_a.sql", "0" * 64)]

    report = migrate.build_status_report(migrations, ledger_present=True, ledger_rows=ledger_rows)

    assert report.mismatches == [("0001_a.sql", "0" * 64, migrations[0].checksum())]


def test_build_status_report_flags_orphaned_ledger_rows_with_no_file_on_disk(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql"])
    ledger_rows = [
        _entry("0001_a.sql", migrations[0].checksum()),
        _entry("0002_removed.sql", "deadbeef" * 8),
    ]

    report = migrate.build_status_report(migrations, ledger_present=True, ledger_rows=ledger_rows)

    assert [e.filename for e in report.orphaned] == ["0002_removed.sql"]


# --- status: text formatting -------------------------------------------------


def test_format_status_report_no_ledger_says_history_unknown_and_points_at_adopt(tmp_path):
    report = migrate.StatusReport(
        ledger_present=False, applied=[], pending=[], orphaned=[], mismatches=[]
    )
    text = migrate.format_status_report(tmp_path, "postgres://host/db", report)

    assert "history unknown" in text
    assert "adopt" in text
    # must not claim knowledge it doesn't have
    assert "0001" not in text


def test_format_status_report_lists_applied_with_source_and_pending(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql", "0002_b.sql"])
    report = migrate.build_status_report(
        migrations,
        ledger_present=True,
        ledger_rows=[_entry("0001_a.sql", migrations[0].checksum(), source="adopted")],
    )
    text = migrate.format_status_report(tmp_path, "postgres://host/db", report)

    assert "0001_a.sql" in text
    assert "adopted" in text
    assert "Pending (1)" in text
    assert "0002_b.sql" in text


def test_format_status_report_surfaces_checksum_drift(tmp_path):
    migrations = _migrations(tmp_path, ["0001_a.sql"])
    report = migrate.build_status_report(
        migrations, ledger_present=True, ledger_rows=[_entry("0001_a.sql", "0" * 64)]
    )
    text = migrate.format_status_report(tmp_path, "postgres://host/db", report)

    assert "CHECKSUM DRIFT" in text
    assert "0" * 64 in text


def test_format_status_report_redacts_credentials_in_db_url(tmp_path):
    report = migrate.StatusReport(
        ledger_present=False, applied=[], pending=[], orphaned=[], mismatches=[]
    )
    text = migrate.format_status_report(tmp_path, "postgres://user:hunter2@host/db", report)

    assert "hunter2" not in text
    assert "postgres://user:***@host/db" in text


def test_status_subcommand_is_wired_into_the_parser():
    args = migrate.build_parser().parse_args(["status"])
    assert args.func is migrate.cmd_status
