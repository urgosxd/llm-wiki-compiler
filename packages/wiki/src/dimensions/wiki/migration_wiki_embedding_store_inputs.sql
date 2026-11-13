-- ============================================================
-- Migration: record the embedding fingerprint's INPUTS, not only its digest
-- ============================================================
-- `wiki.embedding_store_meta.fingerprint` is `sha256(backend \0 model \0 endpoint)`.
-- A digest answers one question -- "is this the configuration I am using?" -- and
-- nothing else. A corpus whose provider default moved on therefore becomes
-- unanalysable: the values that would reproduce its digest are recorded nowhere, so
-- nobody can tell which endpoint produced those vectors. `model` above already stays
-- in cleartext for diagnostics; these two are the part that was missing.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL: the inputs of an existing row are unrecoverable
-- by construction -- that is what a hash is -- and NULL says "unknown" instead of
-- inventing a value that no digest vouches for. Rows written from now on carry the
-- inputs their digest was verified against.
--
-- NOTHING compares these columns. `storeMatchesActiveEmbedding` keeps gating on the
-- digest alone, so NULL here cannot relax the gate, and a pair that happens to match
-- the active configuration cannot stand in for a mismatched digest. Recording an
-- input is evidence, never a substitute for the comparison.
alter table wiki.embedding_store_meta
    add column if not exists backend text;

alter table wiki.embedding_store_meta
    add column if not exists endpoint text;
