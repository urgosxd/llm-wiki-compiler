-- ============================================================
-- AKS Reference Server Schema
-- ============================================================

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- ============================================================
-- GROUP 1: Stacks
-- ============================================================

create table if not exists stacks (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    domain text not null unique,
    description text,
    scope text not null default 'stack',
    compilation_strategy text default 'incremental',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint valid_scope        check (scope in ('stack', 'workspace', 'domain')),
    constraint valid_strategy     check (compilation_strategy in ('incremental', 'global')),
    constraint valid_domain_slug  check (domain ~ '^[a-z0-9-]+$')
);

create index if not exists idx_stacks_domain on stacks(domain);

-- ============================================================
-- GROUP 2: Documents
-- ============================================================

create table if not exists stack_documents (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,

    -- The original filename as uploaded.
    filename text not null,

    -- Where the file lives on disk, relative to /code/uploads/ in the container.
    -- Format: {stack_id}/{document_id}{ext}
    storage_path text not null,

    -- Size of the file in bytes.
    size_bytes integer not null,

    -- MIME type from the upload, if provided.
    content_type text,

    -- SHA-256 of the file content. This is what makes upload idempotent —
    -- uploading the same content to the same Stack returns the existing record.
    -- Maps to AKSDocument.source_hash in the spec.
    source_hash text not null,

    -- Truncation metadata. Populated when text content exceeds the
    -- extraction limit (used in Group 3). Null otherwise.
    truncated boolean not null default false,
    original_length integer,

    -- Placeholder for the Group 3 quality audit. Stored as JSONB so we
    -- can put structured audit results here later without a schema change.
    audit jsonb,

    ingested_at timestamptz not null default now(),

    -- Same content can exist in different Stacks, but only once per Stack.
    constraint unique_hash_per_stack unique (stack_id, source_hash)
);

create index if not exists idx_docs_stack on stack_documents(stack_id);
create index if not exists idx_docs_hash on stack_documents(source_hash);

-- ============================================================
-- GROUP 3: Compilation pipeline tables
-- ============================================================

-- Chunks are the unit of extraction. One document produces many chunks.
-- Each chunk has its own embedding vector for similarity retrieval.
create table if not exists document_chunks (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references stack_documents(id) on delete cascade,
    stack_id uuid not null references stacks(id) on delete cascade,

    -- 0-based position within the document. Lets us stitch neighbor
    -- context during retrieval and re-extract specific chunks on update.
    chunk_index integer not null,

    -- The text content of the chunk.
    content text not null,

    -- SHA-256 of content. When a document is re-ingested, chunks whose
    -- hash matches the previous extraction can be skipped.
    content_hash text not null,

    -- Approximate token count. Used for retrieval budget calculations.
    token_count integer,

    -- The embedding vector. Dimension must match config.EMBEDDING_DIM.
    -- nomic-embed-text-v1.5 produces 768-dim vectors (gateway provider).
    embedding vector(768),

    -- How this chunk was produced. Informational only.
    chunker_strategy text default 'sentence',

    created_at timestamptz not null default now(),

    constraint unique_chunk_per_doc unique (document_id, chunk_index)
);

-- HNSW index for fast cosine similarity search. This is what makes
-- semantic retrieval affordable as the corpus grows.
create index if not exists idx_chunks_embedding
    on document_chunks
    using hnsw (embedding vector_cosine_ops);

-- Trigram index for text similarity scoring in the hybrid retrieval
-- path described in the AKS spec's Retrieval Quality section.
create index if not exists idx_chunks_content_trgm
    on document_chunks
    using gin (content gin_trgm_ops);

create index if not exists idx_chunks_stack on document_chunks(stack_id);


-- Entities are the compiled knowledge units. Every entity belongs to
-- exactly one Stack and has a stable UUID that survives renaming.
create table if not exists ontology_entities (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,

    name text not null,
    type text not null,  -- domain-defined: Concept, Process, Role, System, ...

    -- Compiled account of this entity within the full domain. Updated
    -- as more documents contribute via consolidation.
    description text,

    -- Arbitrary key-value metadata, schema-free.
    properties jsonb default '{}'::jsonb,

    -- Extraction confidence in [0.0, 1.0]. Increases during consolidation
    -- as more sources corroborate this entity.
    confidence real not null default 0.5,

    -- Unit of graduation evidence. Defaults false for machine extraction.
    -- Flips to true on human review or approved backfeed.
    verified boolean not null default false,

    -- Most recent ingestion that mentioned or consolidated into this entity.
    -- Drives the AKS staleness signal. NOT a confidence decay — pure metadata.
    last_seen_at timestamptz not null default now(),

    -- Extraction provenance.
    extracted_at timestamptz not null default now(),
    extracted_by_model text,
    source_kind text default 'document',  -- document | connector | backfeed | manual
    pipeline text default 'llamaindex-schema-extraction',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Entity names are unique within a Stack. Prevents duplicates from
    -- consolidation bugs and makes name-to-id lookups O(1).
    constraint unique_name_per_stack unique (stack_id, name)
);

create index if not exists idx_entities_stack on ontology_entities(stack_id);
create index if not exists idx_entities_type on ontology_entities(type);


-- Relationships are typed directed edges between entities. Always stored
-- by UUID, never by name, so entities can be renamed without breaking edges.
create table if not exists ontology_relationships (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,

    from_entity_id uuid not null references ontology_entities(id) on delete cascade,
    to_entity_id uuid not null references ontology_entities(id) on delete cascade,

    type text not null,  -- verb phrase: requires, triggers, produces, ...
    description text,

    confidence real not null default 0.5,
    verified boolean not null default false,

    extracted_at timestamptz not null default now(),
    extracted_by_model text,
    source_kind text default 'document',
    pipeline text default 'llamaindex-schema-extraction',

    created_at timestamptz not null default now(),

    -- Same edge between same entities is unique. Re-extraction consolidates
    -- via on conflict update rather than creating duplicate rows.
    constraint unique_edge_per_stack unique (stack_id, from_entity_id, to_entity_id, type)
);

create index if not exists idx_rels_stack on ontology_relationships(stack_id);
create index if not exists idx_rels_from on ontology_relationships(from_entity_id);
create index if not exists idx_rels_to on ontology_relationships(to_entity_id);


-- Contributing-documents join table. Tracks which documents fed into
-- each entity via extraction or consolidation. Maps directly to
-- AKSEntity.contributing_documents in the spec. Powers source citations
-- on entity pages in Group 5.
create table if not exists entity_source_documents (
    entity_id uuid not null references ontology_entities(id) on delete cascade,
    document_id uuid not null references stack_documents(id) on delete cascade,
    stack_id uuid not null references stacks(id) on delete cascade,
    contributed_at timestamptz not null default now(),
    primary key (entity_id, document_id)
);

create index if not exists idx_esd_entity on entity_source_documents(entity_id);
create index if not exists idx_esd_doc on entity_source_documents(document_id);

-- ============================================================
-- GROUP 5: Entity Pages
-- ============================================================

-- Cached entity pages. Pages are generated on demand from the compiled
-- graph and cached here. The graph_version field is a hash of the entity's
-- data and its relationships at generation time. When the underlying graph
-- changes, the hash changes, and the cache is implicitly invalidated.
create table if not exists entity_pages (
    entity_id uuid primary key references ontology_entities(id) on delete cascade,
    stack_id uuid not null references stacks(id) on delete cascade,
    entity_name text not null,
    markdown text not null,
    graph_version text not null,
    source_type text not null default 'compiled',
    generated_at timestamptz not null default now(),
    generated_by_model text
);

create index if not exists idx_pages_stack on entity_pages(stack_id);

alter table stacks add column if not exists synthesize_descriptions boolean not null default false;

-- ------------------------------------------------------------
-- Ontology, per Stack (nullable, and that is load-bearing)
-- ------------------------------------------------------------
-- A Stack's ontology is the declaration that constrains extraction: entity types,
-- relationship types, and the IS-A hierarchy between them.
--
-- NULL IS MEANINGFUL, NOT "EMPTY". `ontology is null` is the ORACLE's behaviour:
-- advertise the default type hints and accept whatever the model emits. That is
-- what every existing Stack does today, so a nullable column means existing rows
-- keep working with no backfill. A NOT NULL column with a `{}` default would
-- silently switch every existing Stack into enforcement mode and start rejecting
-- triplets it currently accepts.
--
-- ONE COLUMN, NOT A TABLE. The document is read and written whole, and an entity
-- type and the subtypes referencing it are only meaningful together; a half-applied
-- edit would leave a hierarchy pointing at types that no longer exist. A jsonb
-- column makes the write atomic. A `stack_entity_types` table would spread that
-- invariant across rows with no natural transaction boundary.
--
-- THE CHECK VALIDATES SHAPE ONLY. Cycles, undeclared parents and duplicate types
-- are enforced by `validateOntology` at load time, where the error can name the
-- offending type. Duplicating those rules in SQL would name nothing useful and the
-- two implementations would drift.
alter table stacks
    add column if not exists ontology jsonb;

alter table stacks
    drop constraint if exists valid_ontology_is_object;

alter table stacks
    add constraint valid_ontology_is_object
    check (ontology is null or jsonb_typeof(ontology) = 'object');

-- ============================================================
-- GROUP 6: Backfeed Queue
-- ============================================================
-- Pending and processed backfeed items. Each item is a proposed
-- change to the ontology — an entity to add or update, a relationship
-- to add, a description revision. Items live here until a human
-- approves or rejects them.

create table if not exists backfeed_queue (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,

    -- Where did this item come from?
    --   run    - produced by an agent run over the Stack
    --   direct - submitted directly by a human or non-agent process
    origin text not null,

    -- What was the trigger that produced this?
    --   manual - a human explicitly flagged something
    --   auto   - an agent runtime auto-flagged based on confidence/policy
    --   api    - submitted programmatically (CI, webhook, etc.)
    trigger_type text not null default 'manual',

    -- The proposed change. Stored as JSONB so we can carry whatever
    -- shape the proposal needs without schema changes.
    --
    -- Expected shape:
    --   {
    --     "entities": [
    --       { "name": "...", "type": "...", "description": "...", "confidence": 0.8 }
    --     ],
    --     "relationships": [
    --       { "from": "...", "to": "...", "type": "...", "description": "...", "confidence": 0.8 }
    --     ]
    --   }
    --
    -- Either entities or relationships (or both) may be present.
    proposal jsonb not null,

    -- Optional human-readable note explaining why this was flagged
    note text,

    -- Optional metadata: agent run id, document reference, user id, etc.
    -- Stored as JSONB so callers can pass arbitrary context.
    metadata jsonb default '{}'::jsonb,

    -- Lifecycle
    status text not null default 'pending',  -- pending | approved | rejected
    reviewed_at timestamptz,
    reviewed_by text,                          -- who approved/rejected (string ID, optional)
    review_note text,

    created_at timestamptz not null default now(),

    constraint valid_origin       check (origin in ('run', 'direct')),
    constraint valid_trigger_type check (trigger_type in ('manual', 'auto', 'api')),
    constraint valid_status       check (status in ('pending', 'approved', 'rejected'))
);

create index if not exists idx_backfeed_stack on backfeed_queue(stack_id);
create index if not exists idx_backfeed_status on backfeed_queue(status);
create index if not exists idx_backfeed_created on backfeed_queue(created_at desc);

-- There is deliberately no `ingest_outbox` table. Cross-dimension atomicity comes
-- from the single transaction in `src/dimensions/coordinator.ts`, so the table was
-- dropped rather than kept: it was written inside that transaction (a rollback
-- erased it), its reconciler's outcome was discarded by the only caller, and it
-- stored a full copy of every document and body. A database created before the
-- drop is converted by `migration_drop_ingest_outbox.sql`, which is destructive and
-- is applied by an operator, never by this file.

-- ============================================================
-- GROUP 7: Open classification (entities, relationships, evidence)
-- ============================================================
-- MIRRORED FROM `migration_open_kg_classification.sql`, in the same idempotent form
-- and with the same effect. That file is the upgrade an operator runs on a live
-- database; this one is the clean-install path, which additionally has to be safe
-- when `scripts/apply-schemas.sh` replays it against a database that already has
-- rows (the `create table if not exists` bodies above are no-ops there, so every
-- new column arrives through the ALTERs below and the backfill still has to run
-- before `identity_key` can become NOT NULL).
--
-- Column meanings are documented in full in the migration file. In one line each:
--   classification_state  classified | free_no_match | free_uncertain | pending | failed; NULL = never decided
--   canonical_type        the catalog type, set only when classification_state = 'classified'
--   proposed_type         what the extractor proposed, kept so a later catalog can be compared to it
--   support_state         whether the quoted evidence backs the claim: supported | unsupported | uncertain
--   predicate             the immutable original relation predicate (never normalized away)
--   compatibility         compatible | conflict | indeterminate; NULL = not evaluated
--   jev_*                 raw classifier output with its original meaning; never folded into `confidence`
--   identity_key          what makes two rows the same thing, as opposed to the same spelling

-- The per-Stack catalog: NULL means "no catalog of its own", so the Stack falls back
-- to the legacy `ontology` column and the documented default catalog.
alter table stacks add column if not exists type_catalog jsonb;
alter table stacks add column if not exists catalog_version text;
alter table stacks drop constraint if exists valid_type_catalog_is_object;
alter table stacks add constraint valid_type_catalog_is_object
    check (type_catalog is null or jsonb_typeof(type_catalog) = 'object');

-- Entity classification, provenance and identity.
alter table ontology_entities add column if not exists classification_state text;
alter table ontology_entities add column if not exists canonical_type text;
alter table ontology_entities add column if not exists proposed_type text;
alter table ontology_entities add column if not exists support_state text;
alter table ontology_entities add column if not exists jev_choice text;
alter table ontology_entities add column if not exists jev_confidence real;
alter table ontology_entities add column if not exists jev_top_probability real;
alter table ontology_entities add column if not exists jev_model text;
alter table ontology_entities add column if not exists jev_classified_at timestamptz;
alter table ontology_entities add column if not exists catalog_version text;
alter table ontology_entities add column if not exists classifier_version text;
alter table ontology_entities add column if not exists classification_updated_at timestamptz;
alter table ontology_entities add column if not exists identity_key text;

-- Relationship classification, provenance and identity.
alter table ontology_relationships add column if not exists predicate text;
alter table ontology_relationships add column if not exists canonical_type text;
alter table ontology_relationships add column if not exists classification_state text;
alter table ontology_relationships add column if not exists support_state text;
alter table ontology_relationships add column if not exists compatibility text;
alter table ontology_relationships add column if not exists jev_choice text;
alter table ontology_relationships add column if not exists jev_confidence real;
alter table ontology_relationships add column if not exists jev_top_probability real;
alter table ontology_relationships add column if not exists jev_model text;
alter table ontology_relationships add column if not exists jev_classified_at timestamptz;
alter table ontology_relationships add column if not exists catalog_version text;
alter table ontology_relationships add column if not exists classifier_version text;
alter table ontology_relationships add column if not exists classification_updated_at timestamptz;
alter table ontology_relationships add column if not exists identity_key text;

-- Backfill: state what is already true, invent nothing. Existing rows were accepted
-- with a type label and no evidence judgement was ever made about them, so they are
-- `classified` with `support_state = 'uncertain'` -- never `supported`, which would
-- fabricate a judgement. `verified`, `confidence`, `properties`, `source_kind` and
-- `pipeline` are read but never written here.
update ontology_entities set identity_key = lower(name) where identity_key is null;
update ontology_relationships set predicate = type where predicate is null;
update ontology_relationships set identity_key = lower(predicate) where identity_key is null;

-- Case variants (`Gateway`, `gateway`) are distinct rows under `unique (stack_id, name)`
-- but collapse onto one identity key. They are kept APART, never merged: the later row
-- of a deterministic order gets a suffix from its own UUID, stable across re-runs.
update ontology_entities as e set identity_key = e.identity_key || '#' || e.id::text
from (select id from (select id, row_number() over (
        partition by stack_id, identity_key order by created_at, id) as position
    from ontology_entities) ranked where ranked.position > 1) collided
where e.id = collided.id;

update ontology_relationships as r set identity_key = r.identity_key || '#' || r.id::text
from (select id from (select id, row_number() over (
        partition by stack_id, from_entity_id, to_entity_id, identity_key
        order by created_at, id) as position
    from ontology_relationships) ranked where ranked.position > 1) collided
where r.id = collided.id;

update ontology_entities set classification_state = 'classified', canonical_type = type,
    proposed_type = type, support_state = 'uncertain', classification_updated_at = now()
where classification_state is null;
update ontology_relationships set classification_state = 'classified',
    canonical_type = type, support_state = 'uncertain', classification_updated_at = now()
where classification_state is null;

-- State constraints. `drop ... if exists` then `add` is the idempotent pair this file
-- already uses for `valid_ontology_is_object`; Postgres has no `add constraint if not exists`.
alter table ontology_entities drop constraint if exists valid_entity_classification_state;
alter table ontology_entities add constraint valid_entity_classification_state
    check (classification_state is null or classification_state in
        ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed'));
alter table ontology_entities drop constraint if exists valid_entity_support_state;
alter table ontology_entities add constraint valid_entity_support_state
    check (support_state is null or support_state in ('supported', 'unsupported', 'uncertain'));
-- A canonical type without `classified` would be a label no classifier returned.
alter table ontology_entities drop constraint if exists canonical_type_requires_classified;
alter table ontology_entities add constraint canonical_type_requires_classified
    check (canonical_type is null or classification_state = 'classified');

alter table ontology_relationships drop constraint if exists valid_relationship_classification_state;
alter table ontology_relationships add constraint valid_relationship_classification_state
    check (classification_state is null or classification_state in
        ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed'));
alter table ontology_relationships drop constraint if exists valid_relationship_support_state;
alter table ontology_relationships add constraint valid_relationship_support_state
    check (support_state is null or support_state in ('supported', 'unsupported', 'uncertain'));
alter table ontology_relationships drop constraint if exists valid_relationship_compatibility;
alter table ontology_relationships add constraint valid_relationship_compatibility
    check (compatibility is null or compatibility in ('compatible', 'conflict', 'indeterminate'));
alter table ontology_relationships drop constraint if exists canonical_type_requires_classified;
alter table ontology_relationships add constraint canonical_type_requires_classified
    check (canonical_type is null or classification_state = 'classified');

-- Identity instead of spelling: `unique (stack_id, name)` merged homonyms, so the
-- identity key replaces it. The plain `(stack_id, name)` index keeps the `lower(name)`
-- lookups the read paths perform fast.
alter table ontology_entities drop constraint if exists unique_name_per_stack;
alter table ontology_entities drop constraint if exists unique_identity_per_stack;
alter table ontology_entities add constraint unique_identity_per_stack
    unique (stack_id, identity_key);
create index if not exists idx_entities_stack_name on ontology_entities (stack_id, name);

-- `unique_edge_per_stack` is KEPT beside the identity-key constraint: two consolidators
-- infer their upsert target from `on conflict (stack_id, from_entity_id, to_entity_id, type)`,
-- and dropping the constraint backing those columns breaks every re-ingest.
alter table ontology_relationships drop constraint if exists unique_edge_identity_per_stack;
alter table ontology_relationships add constraint unique_edge_identity_per_stack
    unique (stack_id, from_entity_id, to_entity_id, identity_key);

-- `identity_key` is NOT NULL so no row can exist without an identity, but every INSERT
-- in this repository lists its columns and does not name it. These triggers derive the
-- key the backfill used, and only when the caller supplied none: a pipeline that
-- computes an identity (alias, mention, canonical entity) always wins. They also fill
-- `proposed_type` / `predicate` when absent, because for a writer that predates the
-- classifier the stored `type` IS the proposal and the original predicate, and
-- `predicate` is immutable so a later normalization must not erase what was asserted.
create or replace function kg_entity_identity_key() returns trigger
language plpgsql as $$
begin
    if new.proposed_type is null then new.proposed_type := new.type; end if;
    if new.identity_key is null or btrim(new.identity_key) = '' then
        new.identity_key := lower(btrim(new.name));
    end if;
    return new;
end
$$;

create or replace function kg_relationship_identity_key() returns trigger
language plpgsql as $$
begin
    if new.predicate is null then new.predicate := new.type; end if;
    if new.identity_key is null or btrim(new.identity_key) = '' then
        new.identity_key := lower(btrim(new.predicate));
    end if;
    return new;
end
$$;

drop trigger if exists fill_identity_key on ontology_entities;
create trigger fill_identity_key before insert or update of name, identity_key
    on ontology_entities for each row execute function kg_entity_identity_key();
drop trigger if exists fill_identity_key on ontology_relationships;
create trigger fill_identity_key before insert or update of type, predicate, identity_key
    on ontology_relationships for each row execute function kg_relationship_identity_key();

alter table ontology_entities alter column identity_key set not null;
alter table ontology_relationships alter column identity_key set not null;

-- Per-candidate provenance. One row per (candidate, source span): the same claim is
-- usually stated in several places and corroboration must survive a re-ingest. A
-- candidate is judged BEFORE it has a UUID, so `candidate_ref` is the run-scoped
-- identifier the pipeline assigned, not a foreign key. `evidence_kind` keeps two
-- different facts apart: a quote that exists in the source is not an evaluation that
-- the quote supports the claim.
create table if not exists kg_evidence (
    id uuid primary key default gen_random_uuid(),
    stack_id uuid not null references stacks(id) on delete cascade,
    candidate_kind text not null,
    candidate_ref text not null,
    document_id uuid not null references stack_documents(id) on delete cascade,
    chunk_id uuid references document_chunks(id) on delete cascade,
    chunk_index integer,
    evidence_text text not null,
    char_start integer,
    char_end integer,
    normalized_match boolean not null default false,
    evidence_kind text not null default 'textual',
    model text,
    pipeline_version text,
    catalog_version text,
    created_at timestamptz not null default now(),
    constraint valid_evidence_candidate_kind check (candidate_kind in ('entity', 'relationship')),
    constraint valid_evidence_kind check (evidence_kind in ('textual', 'semantic')),
    constraint valid_evidence_offsets check (
        (char_start is null and char_end is null)
        or (char_start is not null and char_end is not null and char_start >= 0 and char_end > char_start))
);
create index if not exists idx_evidence_candidate
    on kg_evidence (stack_id, candidate_kind, candidate_ref);
create index if not exists idx_evidence_document on kg_evidence (document_id);
create index if not exists idx_evidence_chunk on kg_evidence (chunk_id);

-- Append-only classification history: what the row was, what it became, which catalog
-- and classifier version decided it, and why. The JEV columns repeat here on purpose;
-- reading the current row would only ever show the LATEST answer.
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
    constraint valid_log_candidate_kind check (candidate_kind in ('entity', 'relationship')),
    constraint valid_log_new_state check (new_state in
        ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed')),
    constraint valid_log_previous_state check (previous_state is null or previous_state in
        ('classified', 'free_no_match', 'free_uncertain', 'pending', 'failed'))
);
create index if not exists idx_classification_log_candidate
    on kg_classification_log (stack_id, candidate_kind, candidate_ref, created_at desc);

-- Tenancy for the two tables created above: `migration_rls_tenancy.sql` lists the
-- tables that existed when it was written, so their DDL and their policy travel
-- together here, with the same uniform `stack_id` predicate that file uses.
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
