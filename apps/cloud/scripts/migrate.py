#!/usr/bin/env python3
"""Apply apps/cloud/migrations/*.sql against a Postgres database, tracked in
pw_schema_migrations (see migrations/0001_pw_schema_migrations_ledger.sql and
docs/DEPLOYMENT.md §2.2, "Apply Supabase migrations").

WHY A SCRIPT THAT SHELLS OUT TO `psql`, NOT A PYTHON DB DRIVER
apps/cloud's runtime dependencies (requirements.txt) include no Postgres
driver — DATA_BACKEND=supabase talks to Postgres through the supabase-py
client (PostgREST over HTTPS), never a direct psycopg-style connection, and
migrations are explicitly plain SQL applied over a *direct* connection (see
the ledger migration's own comment: "read/written only over a direct
Postgres connection"). Adding psycopg2 solely for this script would be a new
dependency in a repo that deliberately carries none for this purpose, and
`psql` is already the tool every existing doc and migration comment assumes
is on PATH. So this stays a thin, testable wrapper around `psql -f` — no
ORM, no down-migrations, no dependency graph. Every piece of logic that
doesn't require a live database (numeric ordering, pending calculation,
header parsing, checksum computation, the transaction-splicing decision) is
a plain function covered by tests/test_migrate.py; only the two `run psql`
call sites touch a real connection.

PARAMETERISED MIGRATIONS
A migration that needs a deploy-time value (e.g. 0002_pw_baseline.sql's
fixed-width vector columns) declares it in its own header with a comment of
the form:

    -- migration-runner: requires-vars=embed_dim

(comma-separated for more than one). `apply` reads this before ever opening
a connection for that file — the ledger bootstrap included — and refuses,
loudly and before touching the database, to apply it without a matching
`--var NAME=VALUE`. This is independent of whatever guard the migration's
own SQL contains (the baseline has a `\\if :{?embed_dim}` abort of its own
for anyone who runs it with plain psql, outside this runner); the header
convention exists so a *future* parameterised migration doesn't need to
hand-roll that same psql-level guard to get the runner's fail-fast
behaviour.

USAGE
    scripts/migrate.py apply [--db-url URL] [--var NAME=VALUE ...] [--dry-run]
    scripts/migrate.py status [--db-url URL]

`--db-url` defaults to $DATABASE_URL, then $SUPABASE_DB_URL.

STATUS IS STRICTLY READ-ONLY
`status` answers "what does this database's history actually look like" —
which migrations are recorded (with the `source` each row carries), which
are pending, and whether any already-recorded file has drifted from what's
on disk. It runs a handful of SELECTs and nothing
else: no ledger bootstrap, no writes, no side effects, so pointing it at
production to find out what state it's in cannot itself change that
state. On a database with no `pw_schema_migrations` table at all, it does
NOT fall back to inferring history from which application tables happen
to exist — a partially-applied migration leaves some of its objects
behind, which would make that inference actively wrong, not just
imprecise — it reports the history as unknown.

THE LEDGER IS MIGRATION 1
0001_pw_schema_migrations_ledger.sql creates the ledger, so every database
this runner builds has a complete history from its first statement. A
database built from the pre-baseline 36-file chain (tag
pre-promptworkspace-rename) is not upgraded by this runner.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

MIGRATIONS_DIR_DEFAULT = Path(__file__).resolve().parent.parent / "migrations"
LEDGER_TABLE = "pw_schema_migrations"
LEDGER_MIGRATION_NUMBER = 1
# Before the 2026-10-03 rename and squash, every table (the ledger included)
# carried this prefix. A database that still has the old ledger predates the
# baseline; it is reset, never migrated forward (docs/DEPLOYMENT.md §2.2).
PRE_BASELINE_TABLE_PREFIX = "pz_"
PRE_BASELINE_LEDGER_TABLE = f"{PRE_BASELINE_TABLE_PREFIX}schema_migrations"
PRE_BASELINE_MESSAGE = (
    f"pre-baseline database ({PRE_BASELINE_TABLE_PREFIX} schema); reset it — "
    "fresh-start decision, see docs/DEPLOYMENT.md"
)

NUM_RE = re.compile(r"^(\d+)_")
REQUIRES_VARS_RE = re.compile(r"^--\s*migration-runner:\s*requires-vars=(.+)$", re.MULTILINE)
# A migration is "self-transactional" if it brackets itself in its own
# top-level begin;/commit; (none currently does — the baseline generator
# strips the one the pre-baseline 0023 had). Everything else is "plain" and
# gets wrapped by psql --single-transaction.
SELF_TX_BEGIN_RE = re.compile(r"^[ \t]*begin[ \t]*;[ \t]*$", re.MULTILINE | re.IGNORECASE)
TOP_LEVEL_COMMIT_RE = re.compile(r"^[ \t]*commit[ \t]*;[ \t]*$", re.MULTILINE | re.IGNORECASE)


class MigrationError(RuntimeError):
    """Raised for any condition that should abort the run loudly."""


@dataclasses.dataclass(frozen=True)
class Migration:
    path: Path

    @property
    def filename(self) -> str:
        return self.path.name

    @property
    def number(self) -> int:
        match = NUM_RE.match(self.filename)
        if not match:
            raise MigrationError(
                f"{self.filename}: filename does not start with a numeric prefix "
                "(NNNN_description.sql) — cannot order it."
            )
        return int(match.group(1))

    def text(self) -> str:
        return self.path.read_text()

    def checksum(self) -> str:
        # sha256 of the raw bytes — the same value `shasum -a 256 <file>`
        # prints, so a ledger row can be checked by hand.
        return hashlib.sha256(self.path.read_bytes()).hexdigest()

    def required_vars(self) -> list[str]:
        match = REQUIRES_VARS_RE.search(self.text())
        if not match:
            return []
        return [v.strip() for v in match.group(1).split(",") if v.strip()]

    def is_self_transactional(self) -> bool:
        return bool(SELF_TX_BEGIN_RE.search(self.text()))


@dataclasses.dataclass(frozen=True)
class LedgerEntry:
    """One row of pw_schema_migrations, as read back for `status`."""

    filename: str
    checksum: str
    applied_at: str
    applied_by: str
    source: str
    notes: str


def discover_migrations(migrations_dir: Path) -> list[Migration]:
    """All *.sql in migrations_dir, sorted numerically (0002 < 0010), not
    lexicographically (which would sort "0010" before "0002" is fine, but
    would sort "0002" before "00010" wrong if numbering ever grows a digit —
    numeric sort is correct either way and costs nothing)."""
    migrations = [Migration(p) for p in migrations_dir.glob("*.sql")]
    migrations.sort(key=lambda m: m.number)
    return migrations


def redact(db_url: str) -> str:
    return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", db_url)


def resolve_db_url(args: argparse.Namespace) -> str:
    if args.db_url:
        return args.db_url
    for var in ("DATABASE_URL", "SUPABASE_DB_URL"):
        value = os.environ.get(var)
        if value:
            return value
    raise MigrationError(
        "no database URL — pass --db-url or set $DATABASE_URL / $SUPABASE_DB_URL"
    )


def parse_vars(raw: list[str] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in raw or []:
        if "=" not in item:
            raise MigrationError(f"--var {item!r} is not in NAME=VALUE form")
        name, value = item.split("=", 1)
        name = name.strip()
        if not name:
            raise MigrationError(f"--var {item!r} has an empty name")
        result[name] = value
    return result


def ledger_insert_sql(source: str, with_note: bool) -> str:
    # Distinct :mig_runner_* variable names so they can never collide with a
    # migration's own declared vars (e.g. the baseline's :embed_dim).
    if with_note:
        return (
            f"insert into {LEDGER_TABLE} (filename, checksum, source, notes) "
            f"values (:'mig_runner_filename', :'mig_runner_checksum', "
            f"'{source}', :'mig_runner_note');"
        )
    return (
        f"insert into {LEDGER_TABLE} (filename, checksum, source) "
        f"values (:'mig_runner_filename', :'mig_runner_checksum', '{source}');"
    )


def build_execution_script(
    migration: Migration, source: str = "applied", note: str | None = None
) -> tuple[str, bool]:
    """Returns (script_text, needs_single_transaction).

    Plain migration: the ledger INSERT is appended after the file's own SQL
    and the whole thing runs under `psql --single-transaction`, so a failure
    anywhere — the migration's DDL or the ledger write itself — rolls back
    everything and leaves neither a partial migration nor a ledger row
    claiming one.

    Self-transactional migration (has its own top-level begin;/commit;): the
    ledger INSERT is spliced in just before that file's own closing commit;,
    so it lands inside the same, file-authored transaction instead of being
    layered outside it. This file is NOT also wrapped in
    --single-transaction from here — its own begin;/commit; already scope
    the whole thing, spliced insert included.
    """
    text = migration.text()
    insert_sql = ledger_insert_sql(source, with_note=note is not None)
    if migration.is_self_transactional():
        commit_matches = list(TOP_LEVEL_COMMIT_RE.finditer(text))
        last_commit = commit_matches[-1] if commit_matches else None
        if last_commit is None:
            raise MigrationError(
                f"{migration.filename}: has its own top-level 'begin;' but no "
                "top-level 'commit;' was found to splice the ledger write "
                "before — refusing to guess where its transaction ends."
            )
        pos = last_commit.start()
        spliced = text[:pos] + insert_sql + "\n\n" + text[pos:]
        return spliced, False
    return text + "\n\n" + insert_sql + "\n", True


def psql_argv(
    db_url: str, extra_vars: dict[str, str], *, single_transaction: bool, as_script: bool
) -> list[str]:
    argv = ["psql", db_url, "-X", "-v", "ON_ERROR_STOP=1"]
    if single_transaction:
        argv.append("--single-transaction")
    for name, value in extra_vars.items():
        argv += ["-v", f"{name}={value}"]
    if as_script:
        # Explicit "-f -" (read the script from stdin as a *file*), not bare
        # stdin: --single-transaction only kicks in "in combination with one
        # or more -c and/or -f", and psql's own docs treat plain
        # (non-interactive) stdin input the same way, but -f - says so
        # unambiguously rather than relying on that.
        argv += ["-f", "-"]
    return argv


def run_psql(argv: list[str], script: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, input=script, text=True, capture_output=True)


def _public_table_exists(db_url: str, table: str) -> bool:
    argv = psql_argv(db_url, {}, single_transaction=False, as_script=False)
    argv += ["-t", "-A", "-c", f"select to_regclass('public.{table}') is not null;"]
    result = run_psql(argv, "")
    if result.returncode != 0:
        raise MigrationError(f"could not query database: {result.stderr.strip()}")
    return result.stdout.strip() == "t"


def table_exists(db_url: str) -> bool:
    return _public_table_exists(db_url, LEDGER_TABLE)


def pre_baseline_ledger_exists(db_url: str) -> bool:
    return _public_table_exists(db_url, PRE_BASELINE_LEDGER_TABLE)


def load_ledger(db_url: str) -> dict[str, str]:
    """filename -> checksum for every row currently in pw_schema_migrations,
    or {} if the table doesn't exist yet (a brand-new database)."""
    if not table_exists(db_url):
        return {}
    argv = psql_argv(db_url, {}, single_transaction=False, as_script=False)
    query = f"select filename, checksum from {LEDGER_TABLE} order by filename;"
    argv += ["-t", "-A", "-F", "\t", "-c", query]
    result = run_psql(argv, "")
    if result.returncode != 0:
        raise MigrationError(f"could not read {LEDGER_TABLE}: {result.stderr.strip()}")
    ledger: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        filename, checksum = line.split("\t")
        ledger[filename] = checksum
    return ledger


def parse_ledger_rows(output: str) -> list[LedgerEntry]:
    """Parse psql -t -A -F'\\t' output (6 columns: filename, checksum,
    applied_at, applied_by, source, notes) into LedgerEntry rows. Pure — no
    connection — so this is unit-testable independent of load_ledger_rows,
    which only adds the `psql` call around it."""
    rows: list[LedgerEntry] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        # maxsplit=5 so a notes value containing a literal tab still lands
        # entirely in the last field instead of shifting later columns.
        parts = line.split("\t", 5)
        if len(parts) != 6:
            raise MigrationError(f"unexpected {LEDGER_TABLE} row shape: {line!r}")
        filename, checksum, applied_at, applied_by, source, notes = parts
        rows.append(LedgerEntry(filename, checksum, applied_at, applied_by, source, notes))
    return rows


def load_ledger_rows(db_url: str) -> list[LedgerEntry]:
    """Full ledger rows (filename, checksum, applied_at, applied_by, source,
    notes), for `status`. Caller must have already confirmed the table
    exists (table_exists) — this issues the SELECT unconditionally. A
    single read-only query; no writes."""
    argv = psql_argv(db_url, {}, single_transaction=False, as_script=False)
    query = (
        "select filename, checksum, applied_at, applied_by, source, "
        f"coalesce(notes, '') from {LEDGER_TABLE} order by filename;"
    )
    argv += ["-t", "-A", "-F", "\t", "-c", query]
    result = run_psql(argv, "")
    if result.returncode != 0:
        raise MigrationError(f"could not read {LEDGER_TABLE}: {result.stderr.strip()}")
    return parse_ledger_rows(result.stdout)


def find_checksum_mismatches(
    migrations: list[Migration], ledger: dict[str, str]
) -> list[tuple[str, str, str]]:
    """(filename, checksum recorded in the ledger, checksum of the file on
    disk today) for every already-applied migration whose file has changed
    since it was recorded. This is the failure mode the checksum column
    exists for — see the ledger migration's comment."""
    mismatches = []
    for migration in migrations:
        recorded = ledger.get(migration.filename)
        if recorded is None:
            continue
        actual = migration.checksum()
        if actual != recorded:
            mismatches.append((migration.filename, recorded, actual))
    return mismatches


def pending_migrations(migrations: list[Migration], ledger: dict[str, str]) -> list[Migration]:
    return [m for m in migrations if m.filename not in ledger]


@dataclasses.dataclass(frozen=True)
class StatusReport:
    """Everything `status` reports, computed with no further I/O — so this
    shape is what format_status_report renders and what tests assert
    against, independent of ever touching a real database."""

    ledger_present: bool
    applied: list[LedgerEntry]
    pending: list[Migration]
    orphaned: list[LedgerEntry]  # ledger rows with no matching file on disk today
    mismatches: list[tuple[str, str, str]]  # (filename, recorded checksum, actual checksum)


def build_status_report(
    migrations: list[Migration], ledger_present: bool, ledger_rows: list[LedgerEntry]
) -> StatusReport:
    """Pure combination of what's on disk (migrations) and what's recorded
    (ledger_rows) into a StatusReport. Reuses pending_migrations and
    find_checksum_mismatches — the same functions `apply` relies on — so
    `status` and `apply` can never disagree about what's pending or
    drifted."""
    if not ledger_present:
        return StatusReport(
            ledger_present=False, applied=[], pending=list(migrations), orphaned=[], mismatches=[]
        )
    ledger_checksums = {row.filename: row.checksum for row in ledger_rows}
    entries_by_filename = {row.filename: row for row in ledger_rows}
    applied = [
        entries_by_filename[m.filename] for m in migrations if m.filename in entries_by_filename
    ]
    pending = pending_migrations(migrations, ledger_checksums)
    mismatches = find_checksum_mismatches(migrations, ledger_checksums)
    known_filenames = {m.filename for m in migrations}
    orphaned = [row for row in ledger_rows if row.filename not in known_filenames]
    return StatusReport(
        ledger_present=True,
        applied=applied,
        pending=pending,
        orphaned=orphaned,
        mismatches=mismatches,
    )


def format_status_report(migrations_dir: Path, db_url: str, report: StatusReport) -> str:
    """Render a StatusReport as the text `status` prints. Pure — takes no
    connection — so output format is covered by ordinary pytest assertions
    instead of only by hand-checking a live run."""
    lines = [f"Database: {redact(db_url)}", f"Migrations dir: {migrations_dir}", ""]

    if not report.ledger_present:
        lines.append(
            f"No {LEDGER_TABLE} table found — history unknown. This command does "
            "not infer which migrations ran by checking whether their tables "
            "exist (a partially-applied migration would make that guess wrong); "
            "with no ledger, there is nothing to report, only nothing to know."
        )
        lines.append(
            "Run `migrate.py apply` if this is a genuinely fresh database (see "
            "docs/DEPLOYMENT.md §2.2)."
        )
        return "\n".join(lines)

    lines.append(f"Ledger present ({LEDGER_TABLE}).")
    lines.append("")

    if report.applied:
        lines.append(f"Applied ({len(report.applied)}):")
        for entry in report.applied:
            note = f"  — {entry.notes}" if entry.notes else ""
            lines.append(
                f"  {entry.filename:<45} {entry.source:<8} "
                f"{entry.applied_at}  by {entry.applied_by}{note}"
            )
    else:
        lines.append("Applied (0): none recorded yet.")
    lines.append("")

    if report.pending:
        lines.append(f"Pending ({len(report.pending)}):")
        for m in report.pending:
            required = m.required_vars()
            suffix = f"  (requires: {', '.join(required)})" if required else ""
            lines.append(f"  {m.filename}{suffix}")
    else:
        lines.append("Pending (0): up to date with every migration on disk.")

    if report.orphaned:
        lines.append("")
        lines.append(
            f"Ledger rows with no matching file on disk ({len(report.orphaned)}) "
            "— recorded migration renamed or removed since:"
        )
        for entry in report.orphaned:
            lines.append(f"  {entry.filename}  ({entry.source}, {entry.applied_at})")

    if report.mismatches:
        lines.append("")
        lines.append(
            f"CHECKSUM DRIFT ({len(report.mismatches)}) — recorded vs. file on disk today:"
        )
        for filename, recorded, actual in report.mismatches:
            lines.append(f"  {filename}: ledger has {recorded}, file on disk is now {actual}")
        lines.append(
            "The file changed after being recorded. `apply` will refuse to run "
            "anything until this is resolved — restore the original file, or if "
            "the change is intentional, ship it as a new migration instead."
        )

    return "\n".join(lines)


def apply_one(
    db_url: str,
    migration: Migration,
    extra_vars: dict[str, str],
    *,
    source: str = "applied",
    note: str | None = None,
) -> subprocess.CompletedProcess[str]:
    script, single_tx = build_execution_script(migration, source=source, note=note)
    all_vars = dict(extra_vars)
    all_vars["mig_runner_filename"] = migration.filename
    all_vars["mig_runner_checksum"] = migration.checksum()
    if note is not None:
        all_vars["mig_runner_note"] = note
    argv = psql_argv(db_url, all_vars, single_transaction=single_tx, as_script=True)
    return run_psql(argv, script)


def refuse_missing_vars(migration: Migration, extra_vars: dict[str, str]) -> bool:
    """Print the refusal and return True if `migration` declares a
    requires-vars name that `extra_vars` lacks. Shared by the ledger
    bootstrap and the pending loop, so neither path can apply a
    parameterised migration without its value."""
    missing = [v for v in migration.required_vars() if v not in extra_vars]
    if not missing:
        return False
    print(
        f"REFUSING TO APPLY {migration.filename} — missing required variable(s): "
        f"{', '.join(missing)} (declared in this file's own "
        "'migration-runner: requires-vars=' header). Re-run with "
        f"--var {missing[0]}=<value>; see the file's header comment "
        "for what value it expects.",
        file=sys.stderr,
    )
    print("Stopping — no later migrations will be attempted.", file=sys.stderr)
    return True


def cmd_apply(args: argparse.Namespace) -> int:
    migrations_dir = Path(args.migrations_dir)
    migrations = discover_migrations(migrations_dir)
    db_url = resolve_db_url(args)
    extra_vars = parse_vars(args.var)

    if pre_baseline_ledger_exists(db_url):
        print(f"REFUSING TO APPLY — {PRE_BASELINE_MESSAGE}", file=sys.stderr)
        return 2

    if not table_exists(db_url):
        # A fresh database: pw_schema_migrations doesn't exist yet, so no
        # migration's ledger row can be written "in the same transaction as
        # the migration" — that table has to exist first. Bootstrap it by
        # applying the ledger migration (number 1, so first in numeric
        # order anyway; its DDL only ever creates that one ops table), with
        # its own ledger row spliced in, then resume every other migration
        # in numeric order with the ledger already in place.
        if args.dry_run:
            print(f"{len(migrations)} pending migration(s) (ledger table not created yet):")
            for m in migrations:
                required = m.required_vars()
                suffix = f"  (requires: {', '.join(required)})" if required else ""
                print(f"  {m.filename}{suffix}")
            return 0

        ledger_migration = next(
            (m for m in migrations if m.number == LEDGER_MIGRATION_NUMBER), None
        )
        if ledger_migration is None:
            raise MigrationError(
                f"{LEDGER_MIGRATION_NUMBER:04d}_*.sql not found in {migrations_dir} — "
                "cannot bootstrap the ledger table."
            )
        if refuse_missing_vars(ledger_migration, extra_vars):
            return 2
        print(
            f"Ledger table not present yet — bootstrapping by applying "
            f"{ledger_migration.filename} first (source='applied'), then "
            "continuing in numeric order."
        )
        result = apply_one(db_url, ledger_migration, extra_vars)
        if result.stdout.strip():
            print(result.stdout.strip())
        if result.returncode != 0:
            print(result.stderr.strip(), file=sys.stderr)
            print(
                f"FAILED bootstrapping {ledger_migration.filename} — rolled "
                "back, nothing committed. Stopping.",
                file=sys.stderr,
            )
            return 1
        print(f"Applied {ledger_migration.filename}.")

    ledger = load_ledger(db_url)

    mismatches = find_checksum_mismatches(migrations, ledger)
    if mismatches:
        print(
            "REFUSING TO PROCEED — checksum mismatch on already-applied migration(s):",
            file=sys.stderr,
        )
        for filename, recorded, actual in mismatches:
            print(
                f"  {filename}: ledger has {recorded}, file on disk is now {actual}",
                file=sys.stderr,
            )
        print(
            "These files changed after being applied. Restore the original "
            "file, or if the change is intentional, ship it as a NEW "
            "migration (new filename) instead of editing history.",
            file=sys.stderr,
        )
        return 2

    pending = pending_migrations(migrations, ledger)
    if not pending:
        print(f"Up to date — {len(migrations)} migration(s) already applied, nothing pending.")
        return 0

    if args.dry_run:
        print(f"{len(pending)} pending migration(s):")
        for m in pending:
            required = m.required_vars()
            suffix = f"  (requires: {', '.join(required)})" if required else ""
            print(f"  {m.filename}{suffix}")
        return 0

    for m in pending:
        if refuse_missing_vars(m, extra_vars):
            return 2

        print(f"Applying {m.filename} ...")
        result = apply_one(db_url, m, extra_vars)
        if result.stdout.strip():
            print(result.stdout.strip())
        if result.returncode != 0:
            print(result.stderr.strip(), file=sys.stderr)
            print(
                f"FAILED applying {m.filename} — rolled back, nothing "
                "committed for this migration (and no ledger row was "
                "written for it). Stopping — no later migrations will be attempted.",
                file=sys.stderr,
            )
            return 1
        print(f"Applied {m.filename}.")

    print(f"Done — applied {len(pending)} migration(s).")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Read-only: table_exists() and load_ledger_rows() each issue exactly
    one SELECT and nothing else — no ledger bootstrap, no writes, so this
    cannot change the state of whatever database it's pointed at."""
    migrations_dir = Path(args.migrations_dir)
    migrations = discover_migrations(migrations_dir)
    db_url = resolve_db_url(args)

    ledger_present = table_exists(db_url)
    ledger_rows = load_ledger_rows(db_url) if ledger_present else []
    report = build_status_report(migrations, ledger_present, ledger_rows)
    print(format_status_report(migrations_dir, db_url, report))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="migrate.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--db-url",
        help="Postgres connection string (default: $DATABASE_URL, then $SUPABASE_DB_URL)",
    )
    parser.add_argument(
        "--migrations-dir",
        default=str(MIGRATIONS_DIR_DEFAULT),
        help="directory of NNNN_*.sql files (default: apps/cloud/migrations)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    apply_p = sub.add_parser("apply", help="apply all pending migrations, in numeric order")
    apply_p.add_argument(
        "--var",
        action="append",
        metavar="NAME=VALUE",
        help="value for a migration's declared required variable (repeatable)",
    )
    apply_p.add_argument(
        "--dry-run", action="store_true", help="list what would be applied and stop"
    )
    apply_p.set_defaults(func=cmd_apply)

    status_p = sub.add_parser(
        "status",
        help="read-only: which migrations are applied/pending, and any checksum drift",
    )
    status_p.set_defaults(func=cmd_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except MigrationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
