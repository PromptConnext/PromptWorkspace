-- 0029 — durable registration state for per-repository webhook secrets.
--
-- A binding is written before GitHub registration so the first delivery cannot
-- race its local key.  `pending` prevents another request from treating that
-- provisional secret as confirmed while the first request is still registering
-- it. Existing rows predate this state and are treated as already confirmed.

alter table pz_repo_webhooks
    add column if not exists registration_state text not null default 'confirmed'
        check (registration_state in ('pending', 'confirmed')),
    add column if not exists registration_owner uuid;

