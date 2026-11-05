-- ============================================================
-- wiki.event_log — the wiki's hash-chained event log, as rows
--
-- ## What this replaces
--
-- `wiki/graph/events.jsonl`, plus the head anchor at `.llmwiki/events.head`. The
-- file is an APPEND-ONLY, HASH-CHAINED log: each record carries `prevHash` (the
-- prior record's digest) and `checksum` (its own), so a flipped byte, a reordered
-- line or a deleted record is detectable on read.
--
-- ## What this file no longer creates
--
-- `wiki.relation_edges` lived here until the relation subsystem was removed. Its
-- statements were deleted from this file rather than the file being dropped, because
-- `wiki.event_log` is declared in it and survives. The TABLE itself is retired, not
-- dropped: no migration in this directory has ever issued a `drop table`, and every
-- Stack measured holds zero rows in it. See `remove-profile-substrate.md`.
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

    -- TEXT, not `timestamptz`, on purpose: `at` is part of the CHECKSUMMED content.
    -- A timestamptz normalizes the rendering (`...11.123Z` in becomes `...11.123000Z`
    -- out), so a record read back would hash differently from the one written and an
    -- untampered chain would verify as corrupt. The column stores the exact ISO string
    -- the writer hashed. Nothing filters events by time, so no query loses an index.
    at text not null,

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
-- (the `wiki.relation_edges` statements that lived here were removed with the
-- relation subsystem; its closing `);` outlived them and made this file
-- unparseable, so a fresh database could not be built at all.)

-- Dedup key: canonical endpoints + type + evidence fingerprint. The evidence is part
-- of `content_hash`, so an edge that GAINS evidence is a different edge and gets its
-- own row rather than colliding.

-- ============================================================
-- Row-level security
-- ============================================================
-- Same shape as every other wiki table: enabled AND forced, policy reading
-- `app.stack_id` through `nullif` so an unset or empty GUC matches nothing instead
-- of raising on a malformed uuid cast. FORCE matters because the table owner would
-- otherwise bypass its own policy.
alter table wiki.event_log enable row level security;
alter table wiki.event_log force row level security;

drop policy if exists tenant_isolation on wiki.event_log;
create policy tenant_isolation on wiki.event_log
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);


grant select, insert, update, delete on wiki.event_log to llmwiki_app;

-- `at` moved from `timestamptz` to `text`: it is CHECKSUMMED content, and a
-- timestamptz re-renders the value (`...11.123Z` in becomes `...11.123000Z` out), so a
-- read-back record hashed differently and every untampered chain verified as corrupt.
-- The CREATE above already declares `text`; this makes an EXISTING database converge,
-- because `create table if not exists` skips the whole statement when the table exists.
alter table wiki.event_log alter column at type text;
