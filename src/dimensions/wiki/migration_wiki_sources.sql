-- ============================================================
-- Migration: move the wiki's raw documents out of `sources/` into a table
-- ============================================================
-- Run once to upgrade an existing database:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- Also included in schema.sql, so a fresh volume creates the table from the
-- start. The duplication is this package's existing convention: there is no
-- migration runner, so schema.sql must be self-sufficient for a clean install
-- while a live database still needs the statements applied by hand.
--
-- ## Why this replaces `sources/` rather than sitting beside it
--
-- `sources/` held two different things in one directory: the raw markdown an
-- ingest produced, and the answer to "what work has not been compiled yet", which
-- `compiler/hasher.ts` derived by listing the directory and hashing every file.
-- The second is why the first could not move: an ingest that wrote a row and no
-- file was invisible to the compiler, and the ingest->compile path died.
--
-- With the work discoverable from rows, the directory has no remaining job. This
-- table carries the same bytes so the compiler reads them by query instead.
--
-- ## Why this is NOT `stack_documents`
--
-- `stack_documents` belongs to the KNOWLEDGE GRAPH dimension: `uploads/`, its own
-- `storage_path`, its own hash, its own lifecycle. The wiki compiles from its own
-- corpus and the two are deliberately separate -- a document ingested through the
-- API and the same text ingested through the CLI are two independent arrivals in
-- two independent dimensions, related only by sitting under one Stack.
--
-- Merging them would make the wiki dimension read the graph's corpus, which is the
-- opposite of the separation `LLMWIKI_DIMENSIONS` exists to express.
--
-- ## Why the hash is a first-class column
--
-- `detectChanges` decides new/changed/unchanged/deleted by comparing a SHA-256 of
-- each document against the previous compile. That comparison is the whole
-- correctness of incremental compilation: skip it and every compile re-extracts
-- the entire corpus, get it wrong and a changed document is never re-compiled.
-- The hash therefore lives beside the bytes, not in a separate side table that
-- could drift from them.
-- ============================================================

-- One row per raw wiki document. `source_identity` is the key an ingest already
-- uses (a URL, a file path, or a `manual:<sha>` for pasted text), so a re-ingest of
-- the same origin updates this row instead of forking a second document.
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

grant select, insert, update, delete on wiki.source_documents to llmwiki_app;
grant select, insert, update, delete on wiki.source_compile_state to llmwiki_app;
