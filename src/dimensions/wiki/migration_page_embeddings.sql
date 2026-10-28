-- ============================================================
-- Migration: move the page/chunk embedding vectors into tables
-- ============================================================
-- Run once to upgrade an existing database:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- Also included in schema.sql, so a fresh volume creates the tables from the
-- start. The duplication is this package's existing convention: there is no
-- migration runner, so schema.sql must be self-sufficient for a clean install
-- while a live database still needs the statements applied by hand.
--
-- ## Why tables and not `.llmwiki/embeddings.json`
--
-- The file store was per project, held the WHOLE corpus in one document, and had
-- to be read into memory to answer anything. That is where the 64 MiB
-- `MAX_EMBEDDING_STORE_BYTES` cap came from: it was not a limit on the corpus, it
-- was a limit on what one process could hold while parsing. A table removes the
-- reason for the cap instead of raising it.
--
-- It also fixes the scoping. Vectors describe pages, pages belong to a Stack, so
-- vectors belong to the same Stack and the same isolation policy. A project-scoped
-- file could not express that: two projects sharing one database would have kept
-- two private copies of vectors for the same pages.
--
-- ## These tables are NOT `document_chunks`
--
-- `document_chunks` already carries `embedding vector(768)` with an HNSW index, and
-- reusing it looks tempting until the foreign key is checked: it hangs off
-- `stack_documents` (the raw L1 documents) while embedding entries hang off
-- `wiki.pages` (the compiled L2 pages). Different subjects, so a new table rather
-- than a reuse -- a chunk of a source document and a chunk of a compiled page are
-- not the same thing and do not share a lifecycle.
--
-- ## Why `wiki.pages` and not a free-standing identity
--
-- `wiki.pages` is keyed by `(stack_id, page_directory, slug)`, which is exactly
-- `PageId` (`<namespace>/<page-part>`) decomposed. Keying the vectors off that
-- triple means deleting a page deletes its vectors through the FK instead of
-- leaving them for a sweep to find.
-- ============================================================

-- The file store carried a HEADER (model, dimensions, fingerprint) next to the
-- vectors, and the read path gates on it: a store built by a different provider or
-- model is degraded rather than silently compared against incompatible vectors.
-- Rows alone cannot express that, so the header becomes its own row -- one per
-- Stack, which is the scope the vectors themselves now have.
create table if not exists wiki.embedding_store_meta (
    stack_id uuid primary key references stacks(id) on delete cascade,
    model text not null,
    dimensions integer not null,
    -- Identity of the configuration that produced the vectors. NULL for a store
    -- written before fingerprints existed, which is compared on `model` alone so an
    -- upgrade does not force an unrequested re-embed of the whole wiki.
    fingerprint text,
    updated_at timestamptz not null default now()
);

-- One row per compiled page. `embedding_text_hash` covers the exact string handed
-- to the provider, so a page whose text changed is detectable without re-embedding
-- anything, and unchanged pages can skip the provider entirely.
create table if not exists wiki.page_embeddings (
    stack_id uuid not null references stacks(id) on delete cascade,
    page_directory text not null,
    slug text not null,

    title text not null,
    summary text not null,

    -- SHA-256 (hex) of the exact string passed to the embedding provider.
    embedding_text_hash text not null,

    -- Dimension must match config.EMBEDDING_DIM (nomic-embed-text-v1.5 → 768).
    vector vector(768) not null,

    updated_at timestamptz not null default now(),

    primary key (stack_id, page_directory, slug),
    constraint page_embeddings_page_fkey
        foreign key (stack_id, page_directory, slug)
        references wiki.pages (stack_id, page_directory, slug)
        on delete cascade
);

-- HNSW for cosine similarity: the whole point of moving off the file is that a
-- nearest-neighbour query stops requiring a full scan of everything in memory.
create index if not exists idx_page_embeddings_vector
    on wiki.page_embeddings
    using hnsw (vector vector_cosine_ops);

-- One row per page chunk. Chunk identity is always `(page, chunk_index)` -- never a
-- delimited string like `${pageId}#${chunkIndex}`, which cannot be indexed
-- separately and breaks the moment a page id contains the delimiter.
create table if not exists wiki.page_chunk_embeddings (
    stack_id uuid not null references stacks(id) on delete cascade,
    page_directory text not null,
    slug text not null,
    chunk_index integer not null,

    title text not null,
    -- SHA-256 (hex) of the chunk text, for hash-based reuse across re-embeds.
    content_hash text not null,
    text text not null,

    vector vector(768) not null,

    updated_at timestamptz not null default now(),

    primary key (stack_id, page_directory, slug, chunk_index),
    constraint page_chunk_embeddings_page_fkey
        foreign key (stack_id, page_directory, slug)
        references wiki.pages (stack_id, page_directory, slug)
        on delete cascade
);

create index if not exists idx_page_chunk_embeddings_vector
    on wiki.page_chunk_embeddings
    using hnsw (vector vector_cosine_ops);

-- ============================================================
-- Row-level security
-- ============================================================
-- Same shape as `wiki.pages` and `ingest_outbox`: enabled AND forced, so the table
-- owner is subject to it too, with the policy reading `app.stack_id`.
--
-- This matters more here than anywhere else: an embedding vector is a lossy but
-- real encoding of the text it came from, so a missing tenant predicate does not
-- merely leak a count -- it leaks content across tenants through similarity search.
alter table wiki.embedding_store_meta enable row level security;
alter table wiki.embedding_store_meta force row level security;
alter table wiki.page_embeddings enable row level security;
alter table wiki.page_embeddings force row level security;
alter table wiki.page_chunk_embeddings enable row level security;
alter table wiki.page_chunk_embeddings force row level security;

drop policy if exists tenant_isolation on wiki.embedding_store_meta;
create policy tenant_isolation on wiki.embedding_store_meta
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.page_embeddings;
create policy tenant_isolation on wiki.page_embeddings
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.page_chunk_embeddings;
create policy tenant_isolation on wiki.page_chunk_embeddings
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.embedding_store_meta to llmwiki_app;
grant select, insert, update, delete on wiki.page_embeddings to llmwiki_app;
grant select, insert, update, delete on wiki.page_chunk_embeddings to llmwiki_app;
