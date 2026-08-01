-- 0022 — Policy Scope: a project's declared compliance/regulatory frame
-- (built-in template IDs + free-text custom scope), injected server-side
-- into constitution/specify/plan/tasks generation and seeded into the repo
-- at tech-review exit. See app/models/schemas.py::PolicyScope and
-- app/policies/registry.py.
-- Additive & backward-compatible: existing rows default to null (never
-- selected), which the generation and repo-seed paths treat as empty scope.

alter table pz_projects add column if not exists policy_scope jsonb;
