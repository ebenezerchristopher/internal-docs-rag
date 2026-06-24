-- Internal Docs RAG — Supabase schema
-- Run this once in the Supabase SQL editor (or via the supabase CLI).
-- It is idempotent: it can be re-run safely.

-- 1. Enable pgvector.
create extension if not exists vector;

-- 2. The documents table.
--    id:        stable chunk id derived from docId + heading + chunkIndex
--    content:   chunk text
--    metadata:  jsonb with title, heading, source (repo-relative path), build_id
--    embedding: 1536 dims (matches text-embedding-3-small)
create table if not exists public.documents (
  id text primary key,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

-- 3. IVFFlat index for cosine distance search.
--    lists = 100 is fine up to ~1M vectors; bump as the corpus grows.
create index if not exists documents_embedding_ivf
  on public.documents
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. match_documents RPC.
--    Returns the top match_count rows whose cosine similarity to
--    query_embedding is >= match_threshold, ordered by similarity desc.
create or replace function public.match_documents(
  query_embedding vector(1536),
  match_count int default 6,
  match_threshold float default 0
) returns table (
  id text,
  content text,
  metadata jsonb,
  similarity float
) language sql stable as $$
  select
    d.id,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where 1 - (d.embedding <=> query_embedding) > match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. RLS: the API uses the service role key and bypasses RLS. We still enable
--    RLS on the table so that the anon key (not used here) cannot read docs.
alter table public.documents enable row level security;

-- No policies are created. The service role bypasses RLS by design.
