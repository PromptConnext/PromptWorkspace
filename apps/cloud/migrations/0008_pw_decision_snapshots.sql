-- 0008_pw_decision_snapshots — erasable decision snapshots (enterprise AI v2.1 D1).
--
-- THE PROBLEM
-- pw_decisions.subject_content (0006) keeps the approved document's text on
-- the decision row. Plan documents can hold personal data, and Thai PDPA
-- erasure must remove it without touching the decision or its receipts.
--
-- SHAPE
-- pw_decision_snapshots: one row per decision, written once at request time.
-- Erasure nulls `content` and stamps `erased_at`/`erased_by`; the decision
-- keeps `subject_hash`, and the receipt chain (0007) only ever held the hash.
-- Existing snapshots are copied here and the old column is cleared. The
-- column itself is dropped by a later migration (plan 0029 §13 item 19).
--
-- GRANTS
-- Service-only from birth: RLS on, no policy, nothing for anon/authenticated.
-- 0005 gives service_role select/insert/update/delete on new tables by
-- default; those are revoked and select, insert, update re-granted. Rows are
-- never deleted by the server (erasure nulls the text); they go only with
-- their decision or project (cascade).
--
-- DEPLOY ORDER
-- Apply BEFORE deploying the code that writes snapshots here: that code
-- answers 503 delivery_store_unavailable on a request when the table is
-- missing. Code still running from before reads the cleared column as "no
-- snapshot", which the web already renders.

create table if not exists pw_decision_snapshots (
    decision_id uuid primary key references pw_decisions (id) on delete cascade,
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null references pw_workspaces (id) on delete cascade,
    content text,
    created_at timestamptz not null default now(),
    erased_at timestamptz,
    erased_by text,
    check ((content is null) = (erased_at is not null))
);

insert into pw_decision_snapshots (decision_id, project_id, workspace_id, content, created_at)
select id, project_id, workspace_id, subject_content, created_at
from pw_decisions
where subject_content is not null
on conflict (decision_id) do nothing;

update pw_decisions set subject_content = null where subject_content is not null;

alter table pw_decision_snapshots enable row level security;
revoke all on pw_decision_snapshots from authenticated;
revoke all on pw_decision_snapshots from anon;
revoke all on pw_decision_snapshots from service_role;
grant select, insert, update on pw_decision_snapshots to service_role;
