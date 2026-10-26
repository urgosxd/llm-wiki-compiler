-- ============================================================
-- wiki.event_log + wiki.relation_edges — the wiki's typed graph, as rows
--
-- ## What this replaces
--
-- `wiki/graph/events.jsonl` and `wiki/graph/relations.jsonl`, plus the head anchor
-- at `.llmwiki/events.head`. Both files are APPEND-ONLY, HASH-CHAINED logs: each
-- record carries `prevHash` (the prior record's digest) and `checksum` (its own), so
-- a flipped byte, a reordered line or a deleted record is detectable on read.
--
-- ## Why the chain survives the move, and what changes about it
--
-- A file gives the chain its order FOR FREE: line N precedes line N+1 by position.
-- A table has no inherent order, so `seq` carries it explicitly — a per-Stack,
-- gapless, strictly increasing counter. The chain property is then
-- `checksum(n) = f(prevHash = checksum(n-1))`, unchanged in meaning.
--
-- What the move FIXES: two hosts appending to one Stack's file each hold their own
-- copy and fork the chain. A `seq` allocated inside a locked transaction cannot
-- fork, because the second appender blocks on the first.
--
-- ## Why `seq` is not a global sequence
--
-- A Postgres `SEQUENCE` is global and would let two Stacks interleave into one
-- numbering, making "the previous event in THIS Stack" a range query. Per-Stack
-- numbering is allocated as `max(seq)+1` inside the transaction that holds the
-- Stack's advisory lock, so it is gapless per Stack and cannot be raced.
-- ============================================================

create table if not exists wiki.event_log (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- Per-Stack position in the chain. The order a file got from its bytes.
    seq bigint not null,

    -- Stable handle, minted at emit.
    event_id text not null,

    -- Which mutation produced this event, and where it originated.
    event_type text not null,
    origin text not null,

    -- Mutation-specific detail. jsonb because every event type carries a different
    -- shape and the reader validates per type; a column per field would make every
    -- new event type a migration.
    payload jsonb not null default '{}'::jsonb,

    -- Optional composed trust decision that routed the mutation.
    decision text,

    -- Present only on a child event an operation-bundle apply produced. Covered by
    -- BOTH the chain digest and the checksum, so tampering breaks both.
    operation_binding jsonb,

    -- Chain: digest of the PRIOR record (GENESIS_PREV_HASH for the first) and this
    -- record's own digest.
    prev_hash text not null,
    checksum text not null,

    at timestamptz not null,

    primary key (stack_id, seq)
);

-- The chain read path walks one Stack in order; a lookup by event id must also be
-- reachable without scanning.
create unique index if not exists idx_event_log_event_id
    on wiki.event_log (stack_id, event_id);
create index if not exists idx_event_log_type
    on wiki.event_log (stack_id, event_type);

-- ------------------------------------------------------------
-- Relations: the typed edges the events record
-- ------------------------------------------------------------
create table if not exists wiki.relation_edges (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- Stable handle, allocated once at creation.
    relation_id text not null,

    -- Relation-type id, a key of the profile's `relations`.
    relation_type text not null,

    -- Endpoint entity page ids (`<entityType>/<slug>`).
    from_id text not null,
    to_id text not null,

    attributes jsonb not null default '{}'::jsonb,
    evidence jsonb,

    -- Canonical digest over {type, from, to, attributes, evidence}. Two edges with
    -- different evidence are DIFFERENT edges, which is why this is not a unique key
    -- on the endpoints alone.
    content_hash text not null,

    -- Per-record checksum, recomputed and compared on read. Covers the content plus
    -- any operation binding, so a flipped byte is detectable.
    checksum text not null,

    -- The operation binding, when an operation-bundle apply produced this edge.
    operation_binding jsonb,

    -- Set when a compaction SUPERSEDES the edge rather than deleting it: the graph
    -- is append-only in spirit, so history stays readable.
    superseded_by text,

    at timestamptz not null,

    primary key (stack_id, relation_id)
);

-- Dedup key: canonical endpoints + type + evidence fingerprint. The evidence is part
-- of `content_hash`, so an edge that GAINS evidence is a different edge and gets its
-- own row rather than colliding.
create unique index if not exists idx_relation_edges_dedup
    on wiki.relation_edges (stack_id, relation_type, from_id, to_id, content_hash);
create index if not exists idx_relation_edges_from
    on wiki.relation_edges (stack_id, from_id);
create index if not exists idx_relation_edges_to
    on wiki.relation_edges (stack_id, to_id);

-- ============================================================
-- Row-level security
-- ============================================================
-- Same shape as every other wiki table: enabled AND forced, policy reading
-- `app.stack_id` through `nullif` so an unset or empty GUC matches nothing instead
-- of raising on a malformed uuid cast. FORCE matters because the table owner would
-- otherwise bypass its own policy.
alter table wiki.event_log enable row level security;
alter table wiki.event_log force row level security;
alter table wiki.relation_edges enable row level security;
alter table wiki.relation_edges force row level security;

drop policy if exists tenant_isolation on wiki.event_log;
create policy tenant_isolation on wiki.event_log
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.relation_edges;
create policy tenant_isolation on wiki.relation_edges
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.event_log to llmwiki_app;
grant select, insert, update, delete on wiki.relation_edges to llmwiki_app;
