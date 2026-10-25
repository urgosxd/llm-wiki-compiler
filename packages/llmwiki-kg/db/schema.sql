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
-- ------------------------------------------------------------
-- ingest_outbox: durable recovery record for a two-dimension ingest
-- ------------------------------------------------------------
-- Belongs to a STACK, not a project: an ingest is identified by the Stack both
-- dimensions are bound to, so two projects sharing this database cannot reconcile
-- each other's interrupted runs. See migration_ingest_outbox.sql for the RLS
-- policy and the grant, which are applied by the tenancy migration rather than
-- here -- the same split every other table uses.
--
-- The payload is stored rather than re-fetched because a reconciler that runs on
-- the next boot has no network and no caller to ask.
create table if not exists ingest_outbox (
    ingest_id    text primary key,
    stack_id     uuid not null references stacks (id) on delete cascade,
    source       text not null,
    title        text not null,
    document     text not null,
    body         text not null,
    status       text not null check (status in ('pending', 'committed')),
    dimensions   jsonb not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists idx_ingest_outbox_pending
    on ingest_outbox (stack_id)
    where status = 'pending';
