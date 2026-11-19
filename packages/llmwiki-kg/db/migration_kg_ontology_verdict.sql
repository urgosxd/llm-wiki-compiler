-- ============================================================
-- Migration: ontology verdict (accepted / rejected) for the knowledge graph
-- ============================================================
-- Run once to upgrade an existing database without losing data:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- This file is also mirrored in the main schema.sql, so a fresh volume reaches the
-- same shape from the start and a migrated database and a fresh one agree. The
-- duplication is this package's existing convention (see migration_stack_ontology.sql):
-- there is no migration runner, so schema.sql must be self-sufficient for a clean
-- install while a live database still needs this file applied by hand.
--
-- ## Non-destructive by construction
--
-- No `drop table`, no `drop column`, no `truncate`, no rebuild, no volume reset.
-- Every column arrives through `add column if not exists`, every constraint is
-- dropped with `drop constraint if exists` before it is recreated, and every index
-- is created with `if not exists`, so re-running this file on an up-to-date
-- database is a no-op. Nothing is backfilled by an UPDATE: the DEFAULT is the
-- backfill.
--
-- ## Why a verdict and not `classification_state`
--
-- `classification_state` already exists and is NOT reused here. It is the
-- catalog-match vocabulary (`classified | free_no_match | free_uncertain | pending |
-- failed`) enforced by its own CHECK, it is inserted as `pending` by the ingest
-- pipeline and then UPDATEd by `persist-classification.ts`, so anything written to
-- it before that UPDATE is erased rather than kept. The ontology verdict is a
-- different axis — did the ontology accept this claim — and it must survive every
-- later classification pass, so it gets its own columns.
--
-- ## What this file deliberately does NOT do
--
-- It records SCHEMA, not behaviour. Nothing starts writing a `rejected` verdict
-- because this file ran: every existing row stays `accepted`, which is what it was,
-- and only a writer that has a verdict to record sets the column. `verified`,
-- `confidence`, `properties`, `source_kind` and `pipeline` are never written here:
-- losing a human review decision while migrating is the one outcome this file must
-- never cause.

-- ------------------------------------------------------------
-- 1. The verdict columns
-- ------------------------------------------------------------
-- `accepted` is the default and not a placeholder: every row that exists before this
-- migration WAS accepted by the ontology, because a rejected triplet was never
-- written. So a graph written before this change is not ambiguous afterwards — it is
-- accepted, which is precisely what it is.
--
-- `ontology_rejection_reason` carries the classifier's own four-member vocabulary
-- rather than a boolean, and `ontology_offending_type` carries the type label the
-- verdict was reached about, so a reader joins on the reason instead of parsing a
-- message.
alter table ontology_entities
    add column if not exists ontology_verdict text not null default 'accepted';
alter table ontology_entities
    add column if not exists ontology_rejection_reason text;
alter table ontology_entities
    add column if not exists ontology_offending_type text;

alter table ontology_relationships
    add column if not exists ontology_verdict text not null default 'accepted';
alter table ontology_relationships
    add column if not exists ontology_rejection_reason text;
alter table ontology_relationships
    add column if not exists ontology_offending_type text;

-- ------------------------------------------------------------
-- 2. The checks: a closed vocabulary, and a pair that cannot disagree
-- ------------------------------------------------------------
-- `drop ... if exists` then `add` is the idempotent pair this package already uses
-- for `valid_entity_classification_state`; Postgres has no `add constraint if not
-- exists`.
alter table ontology_entities
    drop constraint if exists valid_entity_ontology_verdict;
alter table ontology_entities
    add constraint valid_entity_ontology_verdict
    check (ontology_verdict in ('accepted', 'rejected'));

-- The four reasons are the classifier's own union, spelled exactly as
-- `core/ontology.ts` spells them. A reason outside this list would be a verdict
-- nobody could filter on.
alter table ontology_entities
    drop constraint if exists valid_entity_ontology_rejection_reason;
alter table ontology_entities
    add constraint valid_entity_ontology_rejection_reason
    check (ontology_rejection_reason is null or ontology_rejection_reason in
        ('UNKNOWN_ENTITY_TYPE', 'UNKNOWN_RELATIONSHIP_TYPE', 'SUBJECT_TYPE_NOT_IN_DOMAIN',
         'OBJECT_TYPE_NOT_IN_RANGE'));

-- An equivalence, not two conditions: a rejected row ALWAYS has its reason and an
-- accepted row NEVER does, so "rejected with no reason" is unrepresentable. Existing
-- rows are `accepted` with a NULL reason, which is exactly the state this admits,
-- which is why it can be added to a populated database at all.
alter table ontology_entities
    drop constraint if exists ontology_rejection_reason_requires_rejected;
alter table ontology_entities
    add constraint ontology_rejection_reason_requires_rejected
    check ((ontology_verdict = 'rejected') = (ontology_rejection_reason is not null));

alter table ontology_relationships
    drop constraint if exists valid_relationship_ontology_verdict;
alter table ontology_relationships
    add constraint valid_relationship_ontology_verdict
    check (ontology_verdict in ('accepted', 'rejected'));

alter table ontology_relationships
    drop constraint if exists valid_relationship_ontology_rejection_reason;
alter table ontology_relationships
    add constraint valid_relationship_ontology_rejection_reason
    check (ontology_rejection_reason is null or ontology_rejection_reason in
        ('UNKNOWN_ENTITY_TYPE', 'UNKNOWN_RELATIONSHIP_TYPE', 'SUBJECT_TYPE_NOT_IN_DOMAIN',
         'OBJECT_TYPE_NOT_IN_RANGE'));

alter table ontology_relationships
    drop constraint if exists ontology_rejection_reason_requires_rejected;
alter table ontology_relationships
    add constraint ontology_rejection_reason_requires_rejected
    check ((ontology_verdict = 'rejected') = (ontology_rejection_reason is not null));

-- ------------------------------------------------------------
-- 3. The indexes: the verdict is read as a filter, never as prose
-- ------------------------------------------------------------
-- A class that has to be read out of a text field cannot be filtered, counted or
-- joined on, and a filter without an index is a full scan of the Stack it was
-- supposed to narrow. `(stack_id, ontology_verdict)` is the pair every such read
-- uses, because every graph read is already scoped to one Stack.
create index if not exists idx_entities_ontology_verdict
    on ontology_entities (stack_id, ontology_verdict);
create index if not exists idx_rels_ontology_verdict
    on ontology_relationships (stack_id, ontology_verdict);
