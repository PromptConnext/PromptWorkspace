-- PromptConnext Cloud — Milestone 1 (plan 0008): track which embed model
-- produced each chunk, so a project's chunks can be checked for homogeneity
-- before a query runs against them. pz_rag_chunks.embedding is a fixed
-- vector(1536) column — switching a workspace's embedding source (BYO <->
-- managed, plan 0007 M2) without reindexing would otherwise silently compare
-- vectors from two different models. app/api/assistant.py checks this
-- column against the resolved query's embed model and rejects with a clear
-- "reindex required" error on mismatch, rather than returning garbage
-- similarity scores.
alter table pz_rag_chunks add column if not exists embed_model text not null default '';
