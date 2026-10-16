-- 0007_pw_receipts — append-only, hash-chained receipts (enterprise AI v2.1 D1).
--
-- THE PROBLEM
-- A decision row is updated in place (open → approved), so nothing shows who
-- did what in which order, and an edited row is indistinguishable from a real
-- one. View 1 of the v2.1 architecture requires tamper-evident receipts.
--
-- SHAPE
-- One chain per project: `seq` counts from 1, `prev_hash` is the previous
-- receipt's `hash` (64 zeros for the first), `hash` is SHA-256 over the
-- canonical JSON of every other column (app/delivery/receipts.py).
-- No foreign key to pw_projects: receipts outlive the project they describe,
-- and a cascade would be refused by the append-only trigger anyway.
-- A decision event is recorded once per decision (partial unique index);
-- role events repeat.
--
-- APPEND-ONLY
-- service_role gets SELECT and INSERT only, and a trigger refuses UPDATE and
-- DELETE for every role, including the table owner.
--
-- DEPLOY ORDER
-- Either order. Reads tolerate a missing table (empty chain); writes are
-- logged and repaired by the next decision write once the table exists.

create table if not exists pw_receipts (
    id uuid primary key,
    project_id uuid not null,
    workspace_id uuid not null,
    seq bigint not null check (seq >= 1),
    event text not null,
    subject_type text not null check (subject_type in ('decision', 'project_role')),
    subject_id text not null,
    actor text not null,
    body jsonb not null default '{}'::jsonb,
    prev_hash text not null check (length(prev_hash) = 64),
    hash text not null check (length(hash) = 64),
    created_at timestamptz not null,
    unique (project_id, seq)
);
create unique index if not exists uq_pw_receipts_decision_event
    on pw_receipts (subject_id, event) where subject_type = 'decision';
create index if not exists idx_pw_receipts_subject on pw_receipts (subject_id);

create or replace function pw_receipts_append_only() returns trigger
language plpgsql as $$
begin
    raise exception 'pw_receipts is append-only';
end;
$$;

drop trigger if exists pw_receipts_no_update on pw_receipts;
create trigger pw_receipts_no_update
    before update or delete on pw_receipts
    for each row execute function pw_receipts_append_only();

alter table pw_receipts enable row level security;
revoke all on pw_receipts from authenticated;
revoke all on pw_receipts from anon;
grant select, insert on pw_receipts to service_role;
