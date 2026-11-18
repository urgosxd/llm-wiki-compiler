-- ============================================================
-- wiki.kg_extracted_chunks — which chunk texts a source has already paid to extract
--
-- ## Why this table exists
--
-- Re-ingesting an unchanged document used to repeat the FULL extraction: one chat
-- request per chunk, sequentially, with nothing recording that the same chunk text
-- had already been extracted for the same source. `public.document_chunks` carries a
-- `content_hash` column for exactly this purpose, but the compiler's ingest path never
-- writes that table -- only the vendored HTTP route calls `persistChunks` -- so a skip
-- keyed on it would answer "nothing reused" forever on the only path that exists.
--
-- This table is the durable record the skip needs, and it is deliberately HASH-ONLY:
-- no content, no embeddings, no token counts. Nothing but the skip logic reads it, so
-- persisting it changes no other reader's behaviour -- which is the whole reason it is
-- a new table instead of rows appearing in `public.document_chunks`.
--
-- ## What one row asserts
--
-- "This exact chunk text was already extracted for this source, in this Stack." It is
-- NEVER written for a reused chunk -- only for the chunks a run actually sent to the
-- model -- so a row means the extraction happened, not that it was skipped.
--
-- ## Why (stack_id, source, content_hash) is the key
--
-- `source` is the source identity the compiler records in
-- `public.stack_documents.storage_path` (a URL or a path), so a hash recorded for one
-- source can never suppress extraction for another; the Stack scopes it the same way
-- every other tenant table is scoped. The key makes recording IDEMPOTENT: a re-ingest
-- of unchanged content inserts nothing, because the hashes are already there.
--
-- ## Why it enforces row-level security
--
-- It carries `stack_id`, so it is a tenant relation like every other one, and
-- `test/dimensions/kg-rls-tenant-catalog.test.ts` derives its population from exactly
-- that column. A table keyed by a tenant and not isolated is the silent failure the
-- tenancy migration exists to prevent -- and here a leak would tell one Stack which
-- sources another had compiled.
--
-- Idempotent: every statement is `if not exists` or `drop ... if exists`, so
-- `scripts/apply-schemas.sh` may be re-run on an up-to-date database.
-- ============================================================
create table if not exists wiki.kg_extracted_chunks (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- Source identity, as `public.stack_documents.storage_path` records it.
    source text not null,

    -- Hex SHA-256 of the chunk text, as `chunkAndEmbed` computes it.
    content_hash text not null,

    extracted_at timestamptz not null default now(),

    primary key (stack_id, source, content_hash)
);

alter table wiki.kg_extracted_chunks enable row level security;
alter table wiki.kg_extracted_chunks force row level security;

drop policy if exists tenant_isolation on wiki.kg_extracted_chunks;
create policy tenant_isolation on wiki.kg_extracted_chunks
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.kg_extracted_chunks to llmwiki_app;
