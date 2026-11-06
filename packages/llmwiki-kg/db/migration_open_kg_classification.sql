-- ============================================================
-- Migration: open-classification schema for the knowledge graph
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
-- dropped with `drop constraint if exists` before it is recreated, and every
-- backfill is guarded by `where ... is null`, so re-running this file on an
-- up-to-date database is a no-op. `verified`, `confidence`, `properties`,
-- `source_kind` and `pipeline` are READ but never written here: losing a human
-- review decision while migrating is the one outcome this file must never cause.
--
-- ## What this file deliberately does NOT do
--
-- It records SCHEMA, not behaviour. Nothing classifies anything yet: the backfill
-- below states what is already known about existing rows, and rows inserted later
-- keep whatever the pipeline writes. There is no `Concept` default, no
-- `Unclassified` coercion, and `source.verified` is never touched, because that
-- field means "a human reviewed this" (AKS semantics) and no migration is a
-- human reviewer.
--
-- ## Stored `type` stays the projection value
--
-- `ontology_entities.type` / `ontology_relationships.type` remain NOT NULL and keep
-- their current meaning: what the export and the pages display. The catalog
-- decision lives in the new nullable `canonical_type`, set only when
-- `classification_state = 'classified'`. A "free" row therefore has a NULL
-- canonical type while keeping the type label it was extracted with, which is what
-- lets a free entity still render and still be traversed.

-- ------------------------------------------------------------
-- 1. The per-Stack type catalog (nullable, and that is load-bearing)
-- ------------------------------------------------------------
-- `null` means "no catalog of its own": the Stack falls back to its legacy
-- `ontology` column and the documented default catalog. A NOT NULL column would
-- claim every existing Stack had been given a vocabulary it never had.
--
-- `catalog_version` is stored next to the document rather than derived from it so a
-- reclassification run can tell whether the vocabulary moved without re-parsing
-- every Stack's JSON, and so the value a stored decision was made against survives
-- a catalog edit.
alter table stacks
    add column if not exists type_catalog jsonb;

alter table stacks
    add column if not exists catalog_version text;

-- Shape only, exactly like `valid_ontology_is_object`: whether the catalog is
-- internally consistent is decided by `parseTypeCatalog`, where the error can name
-- the offending type.
alter table stacks
    drop constraint if exists valid_type_catalog_is_object;

alter table stacks
    add constraint valid_type_catalog_is_object
    check (type_catalog is null or jsonb_typeof(type_catalog) = 'object');

-- ------------------------------------------------------------
-- 2. Entity classification, provenance and identity
-- ------------------------------------------------------------
-- `classification_state` is NULLABLE and has no default. NULL means "no decision was
-- ever recorded", which is the truth for a row written by a pipeline that does not
-- classify. A default of `pending` would assert that a classification was attempted
-- and failed, which is a different fact and belongs to the pipeline, not to DDL.
--
-- The five states are the ones the ingestion stages produce:
--   classified      a catalog type was assigned; `canonical_type` is set
--   free_no_match   the classifier abstained: nothing in the catalog fits
--   free_uncertain  the classifier could not decide: ambiguous or insufficient
--   pending         the classifier has not answered yet
--   failed          the classifier failed or exhausted its retries
--
-- `type` stays the projection value (see the header). `proposed_type` keeps what the
-- extractor suggested, so a later catalog version can be compared against the
-- original proposal instead of against a normalized label.
alter table ontology_entities
    add column if not exists classification_state text;

alter table ontology_entities
    add column if not exists canonical_type text;

alter table ontology_entities
    add column if not exists proposed_type text;

-- S20's closed set: whether the quoted evidence supports the claim. Deliberately a
-- separate column from every confidence measure, because "the source backs this" and
-- "the classifier is sure of the label" are different facts (S23).
alter table ontology_entities
    add column if not exists support_state text;

-- Raw classifier outputs, kept with their original meaning (S22). No consumer may
-- reinterpret `jev_confidence` as a probability that the label is correct: the
-- vendor documents it as a derived dispersion measure. `confidence` (AKS) is NOT
-- derived from these columns.
alter table ontology_entities
    add column if not exists jev_choice text;

alter table ontology_entities
    add column if not exists jev_confidence real;

alter table ontology_entities
    add column if not exists jev_top_probability real;

alter table ontology_entities
    add column if not exists jev_model text;

alter table ontology_entities
    add column if not exists jev_classified_at timestamptz;

alter table ontology_entities
    add column if not exists catalog_version text;

alter table ontology_entities
    add column if not exists classifier_version text;

alter table ontology_entities
    add column if not exists classification_updated_at timestamptz;

-- The identity key: what makes two rows the same entity, as opposed to the same
-- spelling. Written by the pipeline (mentions, aliases and canonical entities can
-- share a name), so it is a plain text column and not a generated one.
alter table ontology_entities
    add column if not exists identity_key text;

-- ------------------------------------------------------------
-- 3. Relationship classification, provenance and identity
-- ------------------------------------------------------------
-- `predicate` is the immutable original predicate, written once at extraction and
-- never rewritten by normalization. `type` keeps its current projection meaning, so
-- a predicate nobody could map ("deja sin efecto") survives the round trip instead
-- of collapsing into `related_to` (S31).
alter table ontology_relationships
    add column if not exists predicate text;

alter table ontology_relationships
    add column if not exists canonical_type text;

alter table ontology_relationships
    add column if not exists classification_state text;

alter table ontology_relationships
    add column if not exists support_state text;

-- S34's three results. NULL means "not evaluated", which is not the same answer as
-- `indeterminate` (an endpoint type is unknown) and must not be stored as if it were.
alter table ontology_relationships
    add column if not exists compatibility text;

alter table ontology_relationships
    add column if not exists jev_choice text;

alter table ontology_relationships
    add column if not exists jev_confidence real;

alter table ontology_relationships
    add column if not exists jev_top_probability real;

alter table ontology_relationships
    add column if not exists jev_model text;

alter table ontology_relationships
    add column if not exists jev_classified_at timestamptz;

alter table ontology_relationships
    add column if not exists catalog_version text;

alter table ontology_relationships
    add column if not exists classifier_version text;

alter table ontology_relationships
    add column if not exists classification_updated_at timestamptz;

alter table ontology_relationships
    add column if not exists identity_key text;

-- ------------------------------------------------------------
-- 4. Backfill: state what is already true, invent nothing
-- ------------------------------------------------------------
-- Every existing entity was extracted with a type label, and no evidence judgement
-- was ever made about it. So it becomes `classified` with `canonical_type = type`
-- (the label it was accepted with) while `support_state` stays `uncertain`: claiming
-- `supported` here would fabricate a judgement nobody made (S12, S23).
--
-- The identity key mirrors the lookup the existing code already performs,
-- `lower(name)`, so the backfill merges and splits exactly what the application
-- already considered identical.
update ontology_entities
set identity_key = lower(name)
where identity_key is null;

-- Case variants (`Gateway` and `gateway`) are distinct rows under the old
-- `unique (stack_id, name)` constraint but collapse onto one identity key. They are
-- kept APART, never merged and never deleted: the loser of the deterministic order
-- gets a suffix derived from its own UUID, which is stable across re-runs.
update ontology_entities as e
set identity_key = e.identity_key || '#' || e.id::text
from (
    select id
    from (
        select
            id,
            row_number() over (
                partition by stack_id, identity_key
                order by created_at, id
            ) as position
        from ontology_entities
    ) ranked
    where ranked.position > 1
) collided
where e.id = collided.id;

update ontology_entities
set classification_state = 'classified',
    canonical_type = type,
    proposed_type = type,
    support_state = 'uncertain',
    classification_updated_at = now()
where classification_state is null;

-- Relationships keep their original predicate, and the predicate is what the
-- identity key hashes, so two different predicates between the same endpoints stay
-- two rows (S33).
update ontology_relationships
set predicate = type
where predicate is null;

update ontology_relationships
set identity_key = lower(predicate)
where identity_key is null;

update ontology_relationships as r
set identity_key = r.identity_key || '#' || r.id::text
from (
    select id
    from (
        select
            id,
            row_number() over (
                partition by stack_id, from_entity_id, to_entity_id, identity_key
                order by created_at, id
            ) as position
        from ontology_relationships
    ) ranked
    where ranked.position > 1
) collided
where r.id = collided.id;

update ontology_relationships
set classification_state = 'classified',
    canonical_type = type,
    support_state = 'uncertain',
    classification_updated_at = now()
where classification_state is null;

-- ------------------------------------------------------------
-- 5. State constraints
-- ------------------------------------------------------------
-- `drop ... if exists` then `add` is the idempotent pair this package already uses
-- for `valid_ontology_is_object`: Postgres has no `add constraint if not exists`.
alter table ontology_entities
    drop constraint if exists valid_entity_classification_state;

alter table ontology_entities
    add constraint valid_entity_classification_state
    check (
        classification_state is null
        or classification_state in (
            'classified', 'free_no_match', 'free_uncertain', 'pending', 'failed'
        )
    );

alter table ontology_entities
    drop constraint if exists valid_entity_support_state;

alter table ontology_entities
    add constraint valid_entity_support_state
    check (
        support_state is null
        or support_state in ('supported', 'unsupported', 'uncertain')
    );

-- A canonical type without the `classified` state would be a label no classifier
-- returned, and every read path that trusts `canonical_type` would present it as
-- decided. Enforcing the pair is what makes "free" a state rather than a missing
-- value somebody has to infer.
alter table ontology_entities
    drop constraint if exists canonical_type_requires_classified;

alter table ontology_entities
    add constraint canonical_type_requires_classified
    check (canonical_type is null or classification_state = 'classified');

alter table ontology_relationships
    drop constraint if exists valid_relationship_classification_state;

alter table ontology_relationships
    add constraint valid_relationship_classification_state
    check (
        classification_state is null
        or classification_state in (
            'classified', 'free_no_match', 'free_uncertain', 'pending', 'failed'
        )
    );

alter table ontology_relationships
    drop constraint if exists valid_relationship_support_state;

alter table ontology_relationships
    add constraint valid_relationship_support_state
    check (
        support_state is null
        or support_state in ('supported', 'unsupported', 'uncertain')
    );

alter table ontology_relationships
    drop constraint if exists valid_relationship_compatibility;

alter table ontology_relationships
    add constraint valid_relationship_compatibility
    check (
        compatibility is null
        or compatibility in ('compatible', 'conflict', 'indeterminate')
    );

alter table ontology_relationships
    drop constraint if exists canonical_type_requires_classified;

alter table ontology_relationships
    add constraint canonical_type_requires_classified
    check (canonical_type is null or classification_state = 'classified');

-- ------------------------------------------------------------
-- 6. Identity instead of spelling
-- ------------------------------------------------------------
-- `unique (stack_id, name)` merged homonyms: two different people, systems or
-- documents that happen to share a name were forced onto one row, and there was no
-- way to keep them apart. The identity key replaces it, and a plain index keeps the
-- `lower(name)` lookups the existing read paths perform fast.
--
-- This is a constraint swap, not a data change: every existing row already carries a
-- unique identity key (section 4), so no row is deleted or rewritten here.
alter table ontology_entities
    drop constraint if exists unique_name_per_stack;

alter table ontology_entities
    drop constraint if exists unique_identity_per_stack;

alter table ontology_entities
    add constraint unique_identity_per_stack
    unique (stack_id, identity_key);

create index if not exists idx_entities_stack_name
    on ontology_entities (stack_id, name);

-- Relationships get the same treatment, and the identity key is what keeps two
-- distinct free predicates between the same endpoints apart.
--
-- `unique_edge_per_stack` is KEPT rather than replaced: `consolidateRelationshipRows`
-- and `consolidateRelationships` infer their upsert target from
-- `on conflict (stack_id, from_entity_id, to_entity_id, type)`, and dropping the
-- constraint that backs those columns would turn every re-ingest into
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- Identity-key uniqueness implies type uniqueness for every writer that derives the
-- key from the predicate, so both constraints can hold at once.
alter table ontology_relationships
    drop constraint if exists unique_edge_identity_per_stack;

alter table ontology_relationships
    add constraint unique_edge_identity_per_stack
    unique (stack_id, from_entity_id, to_entity_id, identity_key);

-- ------------------------------------------------------------
-- 7. Identity keys (and original provenance) for writers that predate this pipeline
-- ------------------------------------------------------------
-- `identity_key` is NOT NULL so no row can exist without an identity. Every existing
-- INSERT in this repository lists its columns explicitly and does not mention it, so
-- a NOT NULL column with no derivation would reject every insert the application
-- makes. These triggers derive the same key the backfill used, and only when the
-- caller supplied none: a pipeline that computes an identity (alias, mention,
-- canonical entity) always wins.
--
-- The same argument applies to the two provenance columns, and both are filled here
-- for the same reason. `predicate` is declared immutable, so a later normalization
-- pass that rewrites `type` must not be able to erase what the extractor actually
-- said; `proposed_type` is the extractor's proposal, and for a writer that predates
-- the classifier the stored `type` IS that proposal. Filling them at write time is
-- cheaper and safer than remembering to do it in every future call site.
create or replace function kg_entity_identity_key() returns trigger
language plpgsql as $$
begin
    if new.proposed_type is null then
        new.proposed_type := new.type;
    end if;
    if new.identity_key is null or btrim(new.identity_key) = '' then
        new.identity_key := lower(btrim(new.name));
    end if;
    return new;
end
$$;

create or replace function kg_relationship_identity_key() returns trigger
language plpgsql as $$
begin
    if new.predicate is null then
        new.predicate := new.type;
    end if;
    if new.identity_key is null or btrim(new.identity_key) = '' then
        new.identity_key := lower(btrim(new.predicate));
    end if;
    return new;
end
$$;

drop trigger if exists fill_identity_key on ontology_entities;
create trigger fill_identity_key
    before insert or update of name, identity_key on ontology_entities
    for each row execute function kg_entity_identity_key();

drop trigger if exists fill_identity_key on ontology_relationships;
create trigger fill_identity_key
    before insert or update of type, predicate, identity_key on ontology_relationships
    for each row execute function kg_relationship_identity_key();

alter table ontology_entities
    alter column identity_key set not null;

alter table ontology_relationships
    alter column identity_key set not null;

-- ------------------------------------------------------------
-- 8. Per-candidate provenance
-- ------------------------------------------------------------
-- One row per (candidate, source span) rather than one row per candidate: the same
-- claim is usually stated in several places, and S43 requires that corroboration
-- survive a re-ingest. A candidate is judged BEFORE it has a UUID, so
-- `candidate_ref` is the run-scoped identifier the pipeline assigned and not a
-- foreign key; `identity_key` is what reconnects it after consolidation.
--
-- `evidence_kind` keeps the two facts apart that a single "confidence" would blend:
-- a quote that exists in the source (`textual`) is not an evaluation that the quote
-- supports the claim (`semantic`).
create table if not exists kg_evidence (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,

    candidate_kind text not null,
    candidate_ref text not null,

    document_id uuid not null references stack_documents(id) on delete cascade,
    chunk_id uuid references document_chunks(id) on delete cascade,

    -- 0-based position of the chunk in its document, duplicated here so a chunk that
    -- is re-chunked later does not erase where the quote came from.
    chunk_index integer,

    -- The span as it was quoted. The offsets are characters into
    -- `document_chunks.content`, never into the original file.
    evidence_text text not null,
    char_start integer,
    char_end integer,

    -- TRUE when the quote was located after controlled normalization (case and
    -- whitespace folding); FALSE when it was not found and the row records an
    -- unverifiable claim.
    normalized_match boolean not null default false,

    evidence_kind text not null default 'textual',

    model text,
    pipeline_version text,
    catalog_version text,
    created_at timestamptz not null default now(),

    constraint valid_evidence_candidate_kind
        check (candidate_kind in ('entity', 'relationship')),
    constraint valid_evidence_kind
        check (evidence_kind in ('textual', 'semantic')),
    constraint valid_evidence_offsets check (
        (char_start is null and char_end is null)
        or (
            char_start is not null
            and char_end is not null
            and char_start >= 0
            and char_end > char_start
        )
    )
);

create index if not exists idx_evidence_candidate
    on kg_evidence (stack_id, candidate_kind, candidate_ref);

create index if not exists idx_evidence_document on kg_evidence (document_id);

create index if not exists idx_evidence_chunk on kg_evidence (chunk_id);

-- ------------------------------------------------------------
-- 9. Classification history
-- ------------------------------------------------------------
-- Append-only. A stored decision that changes with no trace is indistinguishable
-- from corruption, and S43 requires that a reclassification be auditable: what the
-- row was, what it became, which catalog and classifier version decided it, and why.
-- The JEV columns repeat here on purpose; reading the current row would only ever
-- show the LATEST answer.
create table if not exists kg_classification_log (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,

    candidate_kind text not null,
    candidate_ref text not null,

    previous_state text,
    new_state text not null,
    previous_canonical_type text,
    new_canonical_type text,

    jev_choice text,
    jev_confidence real,
    jev_top_probability real,
    jev_model text,

    catalog_version text,
    classifier_version text,
    reason text,
    created_at timestamptz not null default now(),

    constraint valid_log_candidate_kind
        check (candidate_kind in ('entity', 'relationship')),
    constraint valid_log_new_state
        check (
            new_state in (
                'classified', 'free_no_match', 'free_uncertain', 'pending', 'failed'
            )
        ),
    constraint valid_log_previous_state
        check (
            previous_state is null
            or previous_state in (
                'classified', 'free_no_match', 'free_uncertain', 'pending', 'failed'
            )
        )
);

create index if not exists idx_classification_log_candidate
    on kg_classification_log (stack_id, candidate_kind, candidate_ref, created_at desc);

-- ------------------------------------------------------------
-- 10. Tenancy for the two new tables
-- ------------------------------------------------------------
-- `migration_rls_tenancy.sql` lists the tables that existed when it was written, so
-- the two tables created above would otherwise be the only tenant-scoped tables in
-- this schema without a policy. Their DDL and their policy travel together here, and
-- the predicates are the same uniform `stack_id` form that file uses.
alter table kg_evidence enable row level security;
alter table kg_evidence force row level security;
alter table kg_classification_log enable row level security;
alter table kg_classification_log force row level security;

drop policy if exists tenant_isolation on kg_evidence;
create policy tenant_isolation on kg_evidence
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on kg_classification_log;
create policy tenant_isolation on kg_classification_log
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);
