-- ============================================================
-- The `wiki` schema: where compiled wiki pages live in Postgres
-- ============================================================
-- Run once against the same database the KG dimension already uses, as the DDL
-- owner (`aks`), after `packages/llmwiki-kg/db/migration_rls_tenancy.sql` so the
-- `llmwiki_app` role and the tenant GUC convention already exist:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- ## Why a separate schema instead of a table beside the graph's
--
-- The wiki and the knowledge graph are two DIMENSIONS that share one database and
-- one connection pool, not one module. Putting compiled wiki pages in `public`
-- beside `stack_documents` and `ontology_entities` would make the wiki's
-- persistence indistinguishable from the graph's, and would put wiki DDL in the
-- vendored AKS package's migration files. A named schema keeps the boundary
-- visible in the one place an operator looks: `\dt wiki.*` versus `\dt public.*`.
--
-- What the wiki does NOT get from this file is independence from the KG client.
-- Both dimensions are reached through the same pooled `postgres` client the KG
-- barrel already exports, because a second driver and a second pool against one
-- database buys nothing and doubles the connection configuration. The schema
-- boundary is about ownership and review, not about connection topology.
--
-- ## The tenant is the stack, exactly as in `public`
--
-- `stack_id` is the tenant key here for the same reason it is there: `stacks.id`
-- IS the tenant. The row-level-security predicate is deliberately identical to
-- the one in `migration_rls_tenancy.sql` -- `stack_id = nullif(current_setting(
-- 'app.stack_id', true), '')::uuid` -- so a reader who has learned the convention
-- once does not have to learn a second one.
--
-- NULLIF is load-bearing and not defensive noise. `current_setting(..., true)`
-- returns NULL for an UNKNOWN setting, but a setting that was explicitly reset
-- returns the EMPTY STRING, and `select ''::uuid` raises 22P02 -- an error, not
-- "no rows". An unbound session must match nothing, not crash.
--
-- ## The grant trap this file exists to avoid
--
-- `migration_rls_tenancy.sql` grants `llmwiki_app` access with `on all tables in
-- schema public` plus matching `alter default privileges ... in schema public`.
-- Neither reaches a NEW schema: a table created here would be unreadable by the
-- application role, and the failure would look like "the wiki dimension silently
-- returns nothing" rather than "permission denied". The grants at the bottom are
-- therefore not boilerplate; without them this migration produces a schema the
-- app can see and not use.

-- ------------------------------------------------------------
-- The schema
-- ------------------------------------------------------------
create schema if not exists wiki;

-- ------------------------------------------------------------
-- Compiled pages
-- ------------------------------------------------------------
-- One row per compiled concept or query page. The primary key is the page's
-- natural identity -- `(stack_id, page_directory, slug)` -- because a slug is
-- unique only WITHIN a directory, and `wiki.ts`'s writer already treats a
-- directory collision as a different page. A surrogate id would allow duplicate
-- pages to coexist, which is the one thing the write path must never permit.
--
-- `page_directory` is constrained to the two directories `PageDirectory` declares
-- in code (`src/export/types.ts:49`). Encoding that closed set in the database
-- means a typo'd directory is rejected on write instead of becoming a page no
-- reader ever lists.
--
-- `body` is stored inline rather than in an object store: W3 keeps L2 (the
-- compiled product) in the database and leaves L1 (raw source bytes) to Wave 4.
-- Keeping the two layers apart is what lets W4 move blobs without touching this
-- table.
create table if not exists wiki.pages (
    stack_id       uuid        not null references public.stacks(id) on delete cascade,
    page_directory text        not null check (page_directory in ('concepts', 'queries')),
    slug           text        not null,
    title          text        not null,
    -- Source identity (URL, path, or digest) this page was compiled from.
    --
    -- A COLUMN, not something parsed out of the body, and not folded into the slug.
    -- `saveSource` treats source identity as the KEY: re-ingesting the same source
    -- under a changed title must update the existing page rather than fork a second
    -- one. On the filesystem that lookup means reading every file and parsing its
    -- frontmatter; with this column it is one indexed query.
    --
    -- NULL is meaningful: a page created outside an ingest (an authored page, or a
    -- row migrated from the filesystem without frontmatter) has no known source, and
    -- guessing one from the slug would make a later re-ingest update the wrong page.
    source_identity text       null,
    summary        text        not null default '',
    tags           text[]      not null default '{}',
    links          text[]      not null default '{}',
    body           text        not null default '',
    orphaned       boolean     not null default false,
    archived       boolean     not null default false,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    primary key (stack_id, page_directory, slug)
);

-- Listing one tenant's pages newest-first is the reader's hot path
-- (`createWikiReader` -> listPages). The index leads with `stack_id` because RLS
-- filters on it first, so it is also the predicate's own index.
create index if not exists idx_wiki_pages_listing
    on wiki.pages (stack_id, page_directory, updated_at desc);

-- Text search over title and summary replaces the in-memory scan
-- `matchingPages` performs today. `pg_trgm` is already installed by the KG
-- schema, so this adds no extension requirement of its own.
-- The re-ingest lookup: "does this source already have a page here?".
-- Partial, because rows with no source identity can never match the query and are
-- the minority a full index would carry for nothing.
create unique index if not exists idx_wiki_pages_source
    on wiki.pages (stack_id, page_directory, source_identity)
    where source_identity is not null;

create index if not exists idx_wiki_pages_title_trgm
    on wiki.pages using gin (title gin_trgm_ops);

create index if not exists idx_wiki_pages_summary_trgm
    on wiki.pages using gin (summary gin_trgm_ops);

-- ------------------------------------------------------------
-- Concept alias records
-- ------------------------------------------------------------
-- The persisted identity decisions from `concept-aliases.ts`: which merged-away
-- names resolve to which canonical one, under which embedding fingerprint and
-- ruleset version.
--
-- Stored as ONE row per tenant holding two jsonb arrays rather than a row per
-- alias, because the record is consumed as a unit: `conceptAliasRecordUsable`
-- invalidates the WHOLE record when the fingerprint changes, so partial reads have
-- no use. A row per alias would invite mixing aliases from two fingerprints,
-- which is precisely the state the fingerprint exists to forbid.
create table if not exists wiki.concept_aliases (
    stack_id      uuid        not null primary key references public.stacks(id) on delete cascade,
    version       integer     not null,
    fingerprint   text        not null,
    ruleset       integer     not null,
    aliases       jsonb       not null default '[]'::jsonb,
    pending       jsonb       not null default '[]'::jsonb,
    recorded_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Row-level security, mirroring `public`
-- ------------------------------------------------------------
-- ENABLE makes policies apply to non-owners; FORCE also applies them to the table
-- owner. Neither binds a SUPERUSER or BYPASSRLS connection -- that is a ROLE
-- attribute, and it is why `migration_rls_tenancy.sql` creates `llmwiki_app`. This
-- file inherits that requirement instead of restating it; if the application still
-- connects as `aks`, every policy below is inert.
alter table wiki.pages            enable row level security;
alter table wiki.concept_aliases  enable row level security;

alter table wiki.pages            force row level security;
alter table wiki.concept_aliases  force row level security;

drop policy if exists tenant_isolation on wiki.pages;
create policy tenant_isolation on wiki.pages
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.concept_aliases;
create policy tenant_isolation on wiki.concept_aliases
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

-- ------------------------------------------------------------
-- Raw wiki documents, replacing `sources/`
-- ------------------------------------------------------------
-- The directory held both the raw markdown and the answer to "what still needs
-- compiling", so neither could move alone. With work discoverable from rows, the
-- directory has no remaining job.
--
-- Deliberately NOT `stack_documents`: that one belongs to the knowledge-graph
-- dimension (`uploads/`), and the two dimensions compile their own corpora.

create table if not exists wiki.source_documents (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- The ingest identity. Unique per Stack because the same URL ingested into two
    -- Stacks is two documents that must compile independently.
    source_identity text not null,

    -- Title and filename the ingest derived. `filename` is kept because existing
    -- compiler state keys documents by filename, and a migration must be able to
    -- recognize a document it already knows.
    title text not null,
    filename text not null,

    -- The raw markdown: frontmatter plus body, byte-for-byte what `saveSource`
    -- wrote. Retained whole because the compiler feeds it to the model and the
    -- provenance surfaces quote line ranges out of it.
    content text not null,

    -- SHA-256 (hex) of `content`. This is what makes incremental compilation
    -- correct, so it is stored rather than recomputed on read.
    content_hash text not null,

    -- Byte length of `content`, so a reader can size a document without loading it.
    size_bytes integer not null,

    -- When this document last CHANGED. Not "when the row was written": a re-ingest
    -- of identical bytes is a no-op, and a compile must not treat it as new work.
    changed_at timestamptz not null default now(),
    created_at timestamptz not null default now(),

    primary key (stack_id, source_identity)
);

-- The compiler's discovery query: every document in this Stack, ordered so a
-- compile is reproducible. Without this the scan is a sequential read of the
-- whole corpus on every run.
create index if not exists idx_source_documents_scan
    on wiki.source_documents (stack_id, filename);

-- Lookup by content, used when a re-ingest asks "do these exact bytes already
-- exist under another identity?".
create index if not exists idx_source_documents_hash
    on wiki.source_documents (stack_id, content_hash);

-- ============================================================
-- The compile state that used to be `.llmwiki/state.json`
-- ============================================================
-- Per-document compilation outcome. `wiki.source_documents` says what exists;
-- this says what has been done with it. Split in two because they change on
-- different schedules: an ingest touches the first, a compile touches the second,
-- and keeping them together would make every ingest rewrite compile bookkeeping.
create table if not exists wiki.source_compile_state (
    stack_id uuid not null references stacks(id) on delete cascade,
    source_identity text not null,

    -- Hash of the content that was actually compiled. Compared against
    -- `source_documents.content_hash` to decide whether recompilation is needed;
    -- a mismatch IS the "changed" signal.
    compiled_hash text not null,

    -- Concept slugs this document produced, so deleting the document can retire
    -- exactly its pages rather than scanning for orphans.
    concept_slugs text[] not null default '{}',

    compiled_at timestamptz not null default now(),

    -- Reusable extraction snapshot: the ExtractedConcept[] an unchanged source can
    -- skip re-extracting. Kept as jsonb because it is a CACHE validated on read
    -- (fingerprint + sourceHash + slug ownership); losing it costs LLM calls, never
    -- correctness. Without this column, migrating state.json would silently throw
    -- away every reusable extraction.
    extraction jsonb,

    -- Typed mirror of `concept_slugs`, as branded `concepts/<slug>` ids.
    entities text[] not null default '{}',

    -- Output language the extraction ran under. Read by rule-extractor to decide
    -- whether an unchanged source's extraction is still reusable.
    output_language text,

    -- The source identity recorded at ingest time. Persisted so a REMOVED source can
    -- still be named: by the time a deletion is detected its file is gone, and
    -- without this nothing could tell the graph which document to retire.
    source_ref text,

    primary key (stack_id, source_identity),
    constraint source_compile_state_document_fkey
        foreign key (stack_id, source_identity)
        references wiki.source_documents (stack_id, source_identity)
        on delete cascade
);

-- ============================================================
-- Row-level security
-- ============================================================
-- Same shape as every other wiki table: enabled AND forced, policy reading
-- `app.stack_id` through `nullif` so an unset or empty GUC matches nothing
-- instead of raising on a malformed uuid cast.
alter table wiki.source_documents enable row level security;
alter table wiki.source_documents force row level security;
alter table wiki.source_compile_state enable row level security;
alter table wiki.source_compile_state force row level security;

drop policy if exists tenant_isolation on wiki.source_documents;
create policy tenant_isolation on wiki.source_documents
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.source_compile_state;
create policy tenant_isolation on wiki.source_compile_state
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);


-- ------------------------------------------------------------
-- Page and chunk embedding vectors
-- ------------------------------------------------------------
-- Moved out of `.llmwiki/embeddings.json`, where the whole corpus lived in one
-- document and had to be parsed into memory to answer anything -- the origin of
-- the 64 MiB cap. These hang off `wiki.pages`, not `document_chunks`, because a
-- compiled page and a raw source document are different subjects.

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
alter table wiki.page_embeddings enable row level security;
alter table wiki.page_embeddings force row level security;
alter table wiki.page_chunk_embeddings enable row level security;
alter table wiki.page_chunk_embeddings force row level security;

drop policy if exists tenant_isolation on wiki.page_embeddings;
create policy tenant_isolation on wiki.page_embeddings
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.page_chunk_embeddings;
create policy tenant_isolation on wiki.page_chunk_embeddings
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);


-- ------------------------------------------------------------
-- Grants (see "The grant trap" above)
-- ------------------------------------------------------------
-- `if not exists` on the role is intentionally absent: this file runs AFTER the
-- tenancy migration, and silently creating a role with different attributes would
-- defeat the point of that migration having verified them.
grant usage on schema wiki to llmwiki_app;
grant select, insert, update, delete on all tables in schema wiki to llmwiki_app;

-- Future tables in this schema are covered too, so a later wiki table does not
-- arrive ungranted the way this whole schema would have without these lines.
alter default privileges in schema wiki
    grant select, insert, update, delete on tables to llmwiki_app;


-- ============================================================
-- wiki.compile_config — Stack-scoped compile coordination
--
-- The last piece of `.llmwiki/state.json`: `frozenSlugs`, `frozenEntities` and
-- `promptModifiers` are properties of the COMPILE, not of a document, so
-- `source_compile_state` has no home for them. One row per Stack.
-- See `migration_wiki_compile_config.sql` for the full rationale.
-- ============================================================
create table if not exists wiki.compile_config (
    stack_id uuid primary key references stacks(id) on delete cascade,
    frozen_slugs text[] not null default '{}',
    frozen_entities text[] not null default '{}',
    prompt_modifiers text,
    updated_at timestamptz not null default now()
);

alter table wiki.compile_config enable row level security;
alter table wiki.compile_config force row level security;

drop policy if exists tenant_isolation on wiki.compile_config;
create policy tenant_isolation on wiki.compile_config
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.compile_config to llmwiki_app;
