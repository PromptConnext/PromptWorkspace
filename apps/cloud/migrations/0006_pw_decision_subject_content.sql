-- 0006_pw_decision_subject_content — the document an approval was asked about.
--
-- THE PROBLEM
-- A decision stores only the SHA-256 of the stage document it approves
-- (0004), so the approver is shown "Approve the intent" with nothing to read
-- and no way to see what changed since the last approval. The hash proves
-- the document is unchanged; it cannot show it.
--
-- SHAPE
-- pw_decisions.subject_content: the document text at request time, the exact
-- content `subject_hash` covers. Nullable: a decision made before this
-- migration has none, and the web says so instead of showing a diff.
--
-- DEPLOY ORDER
-- Either order is safe. The Supabase adapter reads with `select *` (a missing
-- column just reads as None) and, when a write naming the column is refused
-- as unknown, saves the decision without it. Apply it to get the snapshot.
-- Grants are table-level (0004, 0005), so nothing to grant here.

alter table pw_decisions add column if not exists subject_content text;
