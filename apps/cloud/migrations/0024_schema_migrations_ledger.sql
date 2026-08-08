-- 0024 — schema_migrations ledger
--
-- THE PROBLEM
-- migrations/ has held 23 plain SQL files applied by a shell loop
-- (docs/DEPLOYMENT.md §2.2), and nothing anywhere records which of them has
-- actually run against a given database. Whether the operator's production
-- database has 0010 through 0022 cannot be determined by inspection — only
-- guessed at from which tables happen to exist. This migration creates the
-- table that removes that guesswork going forward: one row per migration
-- file that is known, not inferred, to be reflected in this database.
--
-- SHAPE
--   filename    — the migration's own filename (e.g. '0017_task_assigned_user.sql'),
--                 primary key. Matches what a runner iterates from disk, so
--                 "have I applied this file" is a single indexed lookup.
--   checksum    — sha256 hex digest (lowercase, no prefix) of the migration
--                 file's exact bytes. Catches a migration edited after it
--                 was recorded — a real failure mode in this repo: an
--                 operator has already declined, on a related task, to let
--                 an agent edit an already-applied migration file, precisely
--                 because the file and reality could then silently diverge.
--                 A checksum makes that divergence machine-detectable
--                 instead of relying on nobody ever doing it. Required, not
--                 nullable, on every row including adopted ones (see below)
--                 — an unauditable row would defeat the point of adding a
--                 checksum column at all.
--   applied_at  — when this ledger row was written. For source='applied'
--                 that is real execution time; for source='adopted' it is
--                 assertion time (see below). Not a claim about when the
--                 migration's DDL actually ran historically — that moment
--                 was never recorded and this table cannot recover it.
--   applied_by  — the connected Postgres role at the time the row was
--                 written (defaults to current_user). Cheap audit trail;
--                 costs nothing to capture automatically.
--   source      — 'applied' if a runner executed this file and recorded the
--                 row in the same action, or 'adopted' if an operator
--                 asserted the migration's effects already exist without
--                 that runner ever executing it. This distinction is the
--                 whole point of the column: "we observed this happen" and
--                 "we were told this happened" are different epistemic
--                 states and this schema keeps them different rather than
--                 flattening both into one undifferentiated "applied" fact.
--   notes       — free-form context. Expected to carry something for every
--                 adopted row (who asserted it, when, and why) since an
--                 assertion with no paper trail is barely better than the
--                 guessing this table exists to replace; optional for
--                 applied rows, where the row's own existence is the record.
--
-- WHY NOT A SERIAL/UUID PRIMARY KEY
-- filename is already the natural, stable, human-legible key a runner will
-- look migrations up by ("has 0017_task_assigned_user.sql run?") — a
-- surrogate key would only add an index nobody queries by.
--
-- WHY NO GRANT TO `authenticated` AND NO RLS
-- Every prior migration in this repo grants app-facing tables to
-- `authenticated` because the app's Supabase client (PostgREST, JWT-scoped)
-- reads and writes them at runtime. This table is different in kind: it is
-- migration tooling, written and read only by whoever holds the direct
-- Postgres connection string (an operator running psql, or later, a runner
-- script invoked the same way) — the application's request/response path
-- never touches it and was not changed to do so. Granting it to
-- `authenticated` or gating it behind RLS policies scoped by
-- pz_is_member()/pz_is_admin() would be applying an access-control model
-- built for per-workspace application data to a database-wide ops table
-- that has no workspace to scope by, so it is deliberately omitted rather
-- than bolted on for consistency's sake.
--
-- ADOPTING AN EXISTING DATABASE
-- This migration only creates the table. It does not, and must not, guess
-- that "everything before 0024 is applied" — that would bake exactly the
-- uncertainty this table exists to remove back into its own first rows. A
-- database that already has migration history (e.g. production, believed
-- to carry 0001-0022) needs an explicit, documented adoption step to seed
-- that history as asserted fact. See docs/DEPLOYMENT.md, "Adopting an
-- existing database into the migrations ledger", for the procedure and the
-- reasoning behind requiring it to be explicit. A fresh database needs no
-- such step: run every migration from 0001 as normal, this one included.

create table if not exists pz_schema_migrations (
    filename    text primary key,
    checksum    text not null,
    applied_at  timestamptz not null default now(),
    applied_by  text not null default current_user,
    source      text not null default 'applied',
    notes       text,
    constraint pz_schema_migrations_source_check check (source in ('applied', 'adopted'))
);

comment on table pz_schema_migrations is
  'Ledger of apps/cloud/migrations/*.sql files known to be reflected in this '
  'database. source=applied: a runner executed the file and wrote this row '
  'in the same action. source=adopted: an operator asserted the migration''s '
  'effects already existed here, without that runner executing the file '
  '(see docs/DEPLOYMENT.md, "Adopting an existing database into the '
  'migrations ledger"). Never grant this table to `authenticated` or gate '
  'it with workspace RLS — it is migration tooling, not application data, '
  'and is read/written only over a direct Postgres connection.';
