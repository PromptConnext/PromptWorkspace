-- 0009_pw_decision_expiry — unanswered decisions expire (enterprise AI v2.1 D1).
--
-- THE PROBLEM
-- An open decision waited forever. View 1: "unanswered means no", with
-- timeouts and a reminder.
--
-- SHAPE
-- expires_at: set at request time (DECISION_TTL_DAYS, default 7).
-- reminded_at: when the one "expires soon" email went out.
-- status gains 'expired', written by the sweep (app/delivery/sweep.py).
-- Decisions already open get a full term from today, so nothing expires on
-- the first sweep after this migration.
-- Idempotent: every statement can run twice.
--
-- GRANTS
-- None needed. pw_decisions already exists with its service-only grants from
-- 0004/0005; the new columns inherit them.
--
-- DEPLOY ORDER
-- Apply BEFORE deploying the code that writes expires_at: the Supabase
-- adapter writes every Decision field on save.

alter table pw_decisions add column if not exists expires_at timestamptz;
alter table pw_decisions add column if not exists reminded_at timestamptz;

update pw_decisions set expires_at = now() + interval '7 days'
where status = 'open' and expires_at is null;

alter table pw_decisions drop constraint if exists pw_decisions_status_check;
alter table pw_decisions add constraint pw_decisions_status_check
    check (status in ('open', 'approved', 'rejected', 'withdrawn', 'expired'));

create index if not exists idx_pw_decisions_due
    on pw_decisions (expires_at) where status = 'open';
