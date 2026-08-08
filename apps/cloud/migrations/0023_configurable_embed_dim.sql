-- 0023 — stop hardcoding the embedding width at 1536.
--
-- pz_rag_chunks.embedding, pz_code_chunks.embedding, and both
-- pz_*_match_chunks(p_query_embedding vector(1536), …) signatures were a
-- fixed vector(1536) column/parameter. That ceiling excludes every strong
-- open multilingual encoder and every free local option verified during
-- this project (BGE-m3 1024, Jina v3 1024, KaLM-embedding-multilingual
-- v2.5 896 — its MRL truncates down only, never up — and every embedding
-- model in Ollama's catalogue at 1024 or smaller). The only free 1536
-- model found (Alibaba-NLP/gte-Qwen2-1.5B-instruct) isn't in Ollama. For a
-- deployment whose content is mixed Thai/English, that ceiling is a real
-- retrieval-quality regression, not a cosmetic one.
--
-- `embed_dim` was already threaded through app/config.py, app/models/
-- schemas.py, app/db/repository.py and app/db/supabase_repository.py
-- (plan 0008 M1) — only the DDL was still a literal 1536.
--
-- WHY A PSQL VARIABLE, NOT A NEW FIXED CONSTANT
-- A migration file cannot read this service's runtime config, and there is
-- no single dimension that is "right" for every deployer — it depends on
-- which embedding model they actually run. So this migration takes the
-- width as a deploy-time parameter instead of picking a new hardcoded
-- number (which would just move the ceiling, not remove it):
--
--     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v embed_dim=1024 -f migrations/0023_configurable_embed_dim.sql
--
-- Pick the number to match the `embed_dim` you configure on the workspace
-- model connection (POST /workspaces/{id}/model-connection) — e.g. 1024 for
-- BGE-m3 or Jina v3, 896 for KaLM-embedding-multilingual v2.5. There is no
-- default on purpose: silently falling back to 1536 would resurrect the
-- exact ceiling this migration exists to remove, so applying it without
-- -v embed_dim=<N> aborts loudly below instead of guessing. `-v
-- ON_ERROR_STOP=1` is required too — psql's own default for a scripted -f
-- run is to log an error and keep going with exit code 0, which would
-- silently skip straight to the destructive statements below instead of
-- actually stopping on the guard.
--
-- This migration is therefore NOT part of the plain
-- `for f in migrations/00*.sql; do psql ... -f "$f"; done` loop — apply
-- everything up to 0022 that way, run this one by hand with -v embed_dim=N,
-- then resume the loop for anything after it. See docs/DEPLOYMENT.md and
-- apps/cloud/README.md.
--
-- WHY DESTRUCTIVE, NOT AN IN-PLACE WIDEN/NARROW
-- A vector(1536) value cannot be reinterpreted as a vector(N) value for any
-- N != 1536 — the numbers at each position mean something only in the
-- geometry of the model that produced them, there is no valid cast. Any
-- deployment that has already embedded chunks under vector(1536) MUST lose
-- those vectors to change width; there is no non-destructive path. This
-- migration does not pretend otherwise: it deletes every existing chunk
-- row before narrowing the column, rather than leaving stale 1536-wide
-- rows sitting in a column that now claims a different width (which would
-- either fail the ALTER outright or, worse, leave a column Postgres
-- refuses to let old and new rows coexist in).
--
-- What is NOT lost: pz_rag_chunks/pz_code_chunks are a derived cache, not
-- a source of truth. Requirements/spec_documents/tasks text still lives on
-- those entities; GitHub code was never persisted here in the first place
-- (ADR 0011 "no source code at rest" — pz_code_chunks has no `content`
-- column, only refs). Losing embeddings therefore costs re-embedding
-- spend and a temporary grounding gap, not content. The operator still
-- MUST reindex afterward (POST /workspaces/{id}/assistant/reindex) — until
-- they do, every content/mixed chat question falls back to "no indexed
-- content" (ungrounded, but never silently wrong) via the existing
-- app/api/assistant.py retrieval-transparency path.
\if :{?embed_dim}
\else
do $$ begin
  raise exception 'embed_dim is not set. This migration changes a destructive, fixed-width vector column and refuses to guess. Re-run as: psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v embed_dim=<N> -f migrations/0023_configurable_embed_dim.sql -- where <N> matches the embed_dim of the model connection you will configure (e.g. 1024 for BGE-m3 / Jina v3, 896 for KaLM-embedding-multilingual v2.5).';
end $$;
\endif

begin;

-- Existing embeddings cannot survive a width change (see above) — wipe them
-- before touching the column so no row is ever left claiming a width the
-- column no longer has. Everything else on these rows (content, embed
-- model bookkeeping, code-chunk path/sha refs) is either re-derivable by
-- reindexing or, for code, was never stored here to begin with.
delete from pz_rag_chunks;
delete from pz_code_chunks;

-- Dropping the column takes its ivfflat index (idx_pz_rag_chunks_embedding)
-- with it; re-added below at the new width.
alter table pz_rag_chunks drop column embedding;
alter table pz_rag_chunks add column embedding vector(:embed_dim) not null;

create index idx_pz_rag_chunks_embedding
  on pz_rag_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table pz_code_chunks drop column embedding;
alter table pz_code_chunks add column embedding vector(:embed_dim) not null;

create index idx_pz_code_chunks_embedding
  on pz_code_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- CREATE OR REPLACE keeps the function's OID (and its existing GRANT), so
-- this changes the parameter's width without needing to drop it first —
-- Postgres matches function identity on the parameter's base type (vector),
-- not its typmod, so this really is a REPLACE, not a rename-in-disguise.
create or replace function pz_rag_match_chunks(
    p_workspace_id uuid,
    p_project_id uuid,
    p_query_embedding vector(:embed_dim),
    p_match_count integer default 8
) returns table (
    node_type text,
    node_id uuid,
    chunk_index integer,
    content text,
    score float
)
language sql stable set search_path = public as $$
  select node_type, node_id, chunk_index, content,
         1 - (embedding <=> p_query_embedding) as score
  from pz_rag_chunks
  where workspace_id = p_workspace_id and project_id = p_project_id
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

grant execute on function pz_rag_match_chunks(uuid, uuid, vector, integer) to authenticated;

create or replace function pz_code_match_chunks(
    p_workspace_id uuid,
    p_project_id uuid,
    p_query_embedding vector(:embed_dim),
    p_match_count integer default 8
) returns table (
    repo text,
    path text,
    sha text,
    start_line integer,
    end_line integer,
    score float
)
language sql stable set search_path = public as $$
  select repo, path, sha, start_line, end_line,
         1 - (embedding <=> p_query_embedding) as score
  from pz_code_chunks
  where workspace_id = p_workspace_id and project_id = p_project_id
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

grant execute on function pz_code_match_chunks(uuid, uuid, vector, integer) to authenticated;

-- Guard-gap close (app/api/assistant.py): under the old fixed vector(1536)
-- column, a per-chunk dimension mismatch was unreachable — every chunk was
-- 1536-wide by construction, so the existing embed_model_mismatch check
-- (migration 0016) was the only guard that could ever fire. Now that width
-- is a deploy-time choice, two connections can share an embed_model name
-- and still disagree on dimension (e.g. an MRL-truncated width configured
-- differently), and that mismatch is worse than a name mismatch — the
-- stored vectors are not even the same shape as the query vector. This
-- column lets the app check dimension the same way it already checks
-- model name, instead of only finding out via a query-time pgvector error.
alter table pz_rag_chunks add column if not exists embed_dim integer not null default 0;

commit;

\echo pz_rag_chunks / pz_code_chunks are now vector(:embed_dim). All prior chunks were deleted — run POST /workspaces/{id}/assistant/reindex (or reindex each project) before the assistant can ground content/mixed answers again.
