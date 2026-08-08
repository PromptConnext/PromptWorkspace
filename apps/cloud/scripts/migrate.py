#!/usr/bin/env python3
"""Apply apps/cloud/migrations/*.sql against a Postgres database, tracked in
pz_schema_migrations (see migrations/0024_schema_migrations_ledger.sql and
docs/DEPLOYMENT.md §2.2, "Apply Supabase migrations").

WHY A SCRIPT THAT SHELLS OUT TO `psql`, NOT A PYTHON DB DRIVER
apps/cloud's runtime dependencies (requirements.txt) include no Postgres
driver — DATA_BACKEND=supabase talks to Postgres through the supabase-py
client (PostgREST over HTTPS), never a direct psycopg-style connection, and
migrations are explicitly plain SQL applied over a *direct* connection (see
0024's own migration comment: "read/written only over a direct Postgres
connection"). Adding psycopg2 solely for this script would be a new
dependency in a repo that deliberately carries none for this purpose, and
`psql` is already the tool every existing doc and migration comment assumes
is on PATH. So this stays a thin, testable wrapper around `psql -f` — no
ORM, no down-migrations, no dependency graph. Every piece of logic that
doesn't require a live database (numeric ordering, pending calculation,
header parsing, checksum computation, the transaction-splicing decision) is
a plain function covered by tests/test_migrate.py; only the two `run psql`
call sites touch a real connection.

PARAMETERISED MIGRATIONS
A migration that needs a deploy-time value (e.g. 0023_configurable_embed_dim
.sql's destructive, fixed-width vector column) declares it in its own header
with a comment of the form:

    -- migration-runner: requires-vars=embed_dim

(comma-separated for more than one). `apply` reads this before ever opening
a connection for that file and refuses — loudly, before touching the
database — to apply it without a matching `--var NAME=VALUE`. This is
independent of whatever guard the migration's own SQL contains (0023 has a
`\\if :{?embed_dim}` abort of its own for anyone who runs it with plain
psql, outside this runner); the header convention exists so a *future*
parameterised migration doesn't need to hand-roll that same psql-level
guard to get the runner's fail-fast behaviour.

USAGE
    scripts/migrate.py apply [--db-url URL] [--var NAME=VALUE ...] [--dry-run]
    scripts/migrate.py adopt --through 0022 [--adopted-by NAME] [--note TEXT] [--yes]

`--db-url` defaults to $DATABASE_URL, then $SUPABASE_DB_URL.
"""

from __future__ import annotations

import argparse
import dataclasses
import getpass
import hashlib
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MIGRATIONS_DIR_DEFAULT = Path(__file__).resolve().parent.parent / "migrations"
LEDGER_TABLE = "pz_schema_migrations"
LEDGER_MIGRATION_NUMBER = 24

NUM_RE = re.compile(r"^(\d+)_")
REQUIRES_VARS_RE = re.compile(r"^--\s*migration-runner:\s*requires-vars=(.+)$", re.MULTILINE)
# A migration is "self-transactional" if it brackets itself in its own
# top-level begin;/commit; (currently only 0023, whose destructive guard has
# to run and be able to abort before any DDL starts — see its header).
# Everything else is "plain" and gets wrapped by psql --single-transaction.
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
        # sha256 of the raw bytes — matches `shasum -a 256` in
        # docs/DEPLOYMENT.md's adoption procedure, so a checksum recorded by
        # `adopt` and one recorded by `apply` are directly comparable.
        return hashlib.sha256(self.path.read_bytes()).hexdigest()

    def required_vars(self) -> list[str]:
        match = REQUIRES_VARS_RE.search(self.text())
        if not match:
            return []
        return [v.strip() for v in match.group(1).split(",") if v.strip()]

    def is_self_transactional(self) -> bool:
        return bool(SELF_TX_BEGIN_RE.search(self.text()))


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
    # migration's own declared vars (e.g. 0023's :embed_dim).
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


def table_exists(db_url: str) -> bool:
    argv = psql_argv(db_url, {}, single_transaction=False, as_script=False)
    argv += ["-t", "-A", "-c", f"select to_regclass('public.{LEDGER_TABLE}') is not null;"]
    result = run_psql(argv, "")
    if result.returncode != 0:
        raise MigrationError(f"could not query database: {result.stderr.strip()}")
    return result.stdout.strip() == "t"


def load_ledger(db_url: str) -> dict[str, str]:
    """filename -> checksum for every row currently in pz_schema_migrations,
    or {} if the table doesn't exist yet (a brand-new database, or one that
    hasn't been through adoption/0024 yet)."""
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


def find_checksum_mismatches(
    migrations: list[Migration], ledger: dict[str, str]
) -> list[tuple[str, str, str]]:
    """(filename, checksum recorded in the ledger, checksum of the file on
    disk today) for every already-applied migration whose file has changed
    since it was recorded. This is the failure mode the checksum column
    exists for — see 0024's migration comment."""
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


def cmd_apply(args: argparse.Namespace) -> int:
    migrations_dir = Path(args.migrations_dir)
    migrations = discover_migrations(migrations_dir)
    db_url = resolve_db_url(args)
    extra_vars = parse_vars(args.var)

    if not table_exists(db_url):
        # A fresh database: pz_schema_migrations doesn't exist yet, so no
        # migration's ledger row can be written "in the same transaction as
        # the migration" — that table has to exist first. Bootstrap it by
        # applying the ledger migration itself out of numeric order (its DDL
        # only ever creates that one ops table; nothing else in this repo's
        # migrations reads or depends on it, so running it first is safe),
        # then resume every other migration — 0001 included — in normal
        # numeric order with the ledger already in place.
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
        missing = [v for v in m.required_vars() if v not in extra_vars]
        if missing:
            print(
                f"REFUSING TO APPLY {m.filename} — missing required variable(s): "
                f"{', '.join(missing)} (declared in this file's own "
                "'migration-runner: requires-vars=' header). Re-run with "
                f"--var {missing[0]}=<value>; see the file's header comment "
                "for what value it expects.",
                file=sys.stderr,
            )
            print("Stopping — no later migrations will be attempted.", file=sys.stderr)
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


def cmd_adopt(args: argparse.Namespace) -> int:
    migrations_dir = Path(args.migrations_dir)
    migrations = discover_migrations(migrations_dir)
    db_url = resolve_db_url(args)

    try:
        through = int(args.through)
    except ValueError as exc:
        raise MigrationError(f"--through {args.through!r} is not a migration number") from exc

    if through >= LEDGER_MIGRATION_NUMBER:
        print(
            "REFUSING — adoption is only for pre-ledger history (migrations "
            f"before {LEDGER_MIGRATION_NUMBER:04d}_schema_migrations_ledger.sql). "
            "That migration and everything after it is always recorded as "
            "source='applied' by actually running it, never asserted. Use "
            "`apply` for those.",
            file=sys.stderr,
        )
        return 2

    ledger_migration = next(
        (m for m in migrations if m.number == LEDGER_MIGRATION_NUMBER), None
    )
    if ledger_migration is None:
        print(
            f"could not find a {LEDGER_MIGRATION_NUMBER:04d}_*.sql migration in "
            f"--migrations-dir ({migrations_dir})",
            file=sys.stderr,
        )
        return 2

    if through == 23:
        print(
            "WARNING: 0023_configurable_embed_dim.sql is destructive and "
            "requires a deliberate -v embed_dim=<N> run — adopting it only "
            "asserts you already did that by hand yourself; this command "
            "does not and cannot verify it. See docs/DEPLOYMENT.md §2.2.",
            file=sys.stderr,
        )
        if not args.yes:
            print("Re-run with --yes to confirm you understand this.", file=sys.stderr)
            return 2

    to_adopt = [
        m for m in migrations if m.number <= through and m.number != LEDGER_MIGRATION_NUMBER
    ]
    ledger = load_ledger(db_url)
    already = [m.filename for m in to_adopt if m.filename in ledger]
    new_adopt = [m for m in to_adopt if m.filename not in ledger]
    ledger_needs_creating = ledger_migration.filename not in ledger

    print("Adoption plan:")
    print(f"  database: {redact(db_url)}")
    if ledger_needs_creating:
        print(
            f"  create the ledger table by actually applying "
            f"{ledger_migration.filename} (source='applied')"
        )
    else:
        print(f"  ledger table already present ({ledger_migration.filename} already recorded)")
    if already:
        print(f"  already recorded, left alone: {', '.join(already)}")
    if new_adopt:
        names = ", ".join(m.filename for m in new_adopt)
        print(f"  record as source='adopted' (asserted, not executed): {names}")
    else:
        print("  no new history to adopt.")

    if not new_adopt and not ledger_needs_creating:
        print("Nothing to do.")
        return 0

    if not args.yes:
        reply = input("Proceed? [y/N] ").strip().lower()
        if reply != "y":
            print("Aborted — nothing changed.")
            return 1

    if ledger_needs_creating:
        print(f"Applying {ledger_migration.filename} ...")
        result = apply_one(db_url, ledger_migration, extra_vars={})
        if result.stdout.strip():
            print(result.stdout.strip())
        if result.returncode != 0:
            print(result.stderr.strip(), file=sys.stderr)
            print(
                "FAILED creating the ledger table — adoption aborted, nothing recorded.",
                file=sys.stderr,
            )
            return 1
        print(f"Applied {ledger_migration.filename}.")

    if new_adopt:
        adopted_by = args.adopted_by or os.environ.get("USER") or getpass.getuser()
        adopted_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        note = (
            f"Adopted {adopted_at} by {adopted_by}: asserted already applied "
            "to this database; not independently verified, only "
            "checksummed against the current file."
        )
        if args.note:
            note += f" {args.note}"

        statements = []
        script_vars: dict[str, str] = {"adopt_note": note}
        for i, m in enumerate(new_adopt):
            fkey, ckey = f"adopt_f{i}", f"adopt_c{i}"
            statements.append(
                f"insert into {LEDGER_TABLE} (filename, checksum, source, notes) "
                f"values (:'{fkey}', :'{ckey}', 'adopted', :'adopt_note') "
                "on conflict (filename) do nothing;"
            )
            script_vars[fkey] = m.filename
            script_vars[ckey] = m.checksum()
        script = "\n".join(statements) + "\n"
        argv = psql_argv(db_url, script_vars, single_transaction=True, as_script=True)
        result = run_psql(argv, script)
        if result.stdout.strip():
            print(result.stdout.strip())
        if result.returncode != 0:
            print(result.stderr.strip(), file=sys.stderr)
            print(
                "FAILED recording adopted history — rolled back, nothing changed.",
                file=sys.stderr,
            )
            return 1
        print(f"Recorded {len(new_adopt)} migration(s) as adopted.")

    print("Adoption complete.")
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

    adopt_p = sub.add_parser(
        "adopt",
        help="assert pre-ledger migration history without executing it (docs/DEPLOYMENT.md §2.2)",
    )
    adopt_p.add_argument(
        "--through",
        required=True,
        metavar="NNNN",
        help="last migration already believed applied, e.g. 0022",
    )
    adopt_p.add_argument("--adopted-by", help="default: $USER")
    adopt_p.add_argument("--note", help="appended to the standard adoption note")
    adopt_p.add_argument(
        "--yes", action="store_true", help="skip the interactive confirmation prompt"
    )
    adopt_p.set_defaults(func=cmd_adopt)

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
