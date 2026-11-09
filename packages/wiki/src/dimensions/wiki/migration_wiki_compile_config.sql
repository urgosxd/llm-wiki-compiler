-- ============================================================
-- wiki.compile_config — the Stack-scoped half of `.llmwiki/state.json`
--
-- ## Why this is the LAST piece of state.json, not a replacement for it
--
-- `state.json` holds two different things, and only one of them is per-document:
--
--   1. `sources` — the hash, concept slugs and compiled-at of each source.
--      `wiki.source_compile_state` already has exactly this shape and has existed
--      since `migration_wiki_sources.sql`. It is currently UNUSED (measured: zero
--      rows, zero TypeScript references), which is why it is a wiring job rather
--      than a new design.
--
--   2. The Stack-scoped coordination fields — `frozenSlugs`, `frozenEntities` and
--      `promptModifiers`. These are properties of the COMPILE, not of a document:
--      which slugs are frozen across batches, and which prompt modifiers the last
--      run used. There is no per-document home for them, so they need one row per
--      Stack.
--
-- `indexHash` is deliberately absent. Measured: it is never read or written to
-- make a decision anywhere in the codebase — it exists only in the type and in
-- validation. Persisting it would store a value nothing consults.
--
-- ## Why one row per Stack rather than a key/value table
--
-- These are three fixed fields of a single logical record. A key/value table would
-- make a typo in a key a silent no-op instead of a schema error, and would let a
-- Stack hold two conflicting `promptModifiers` rows.
-- ============================================================

create table if not exists wiki.compile_config (
    stack_id uuid primary key references stacks(id) on delete cascade,

    -- Concept slugs frozen across batches so content from deleted sources survives
    -- a reconciliation pass. Text[], matching `source_compile_state.concept_slugs`:
    -- these flow into orphan path-joins, so the array is validated on the way out.
    frozen_slugs text[] not null default '{}',

    -- The v2 typed mirror of the above, minted as branded `concepts/<slug>` ids.
    -- Kept ALONGSIDE `frozen_slugs` (never replacing it) for the same reason the
    -- file format keeps both.
    frozen_entities text[] not null default '{}',

    -- Digest of the user-selected prompt modifiers the last compile ran under.
    -- The EMPTY STRING records "none selected", which is deliberately not the same
    -- value as "never compiled" -- see `promptModifiersChanged` in the compiler.
    -- NULL therefore means "no compile has recorded a digest yet".
    prompt_modifiers text,

    updated_at timestamptz not null default now()
);

-- ============================================================
-- Row-level security
-- ============================================================
-- Same shape as every other wiki table: enabled AND forced, policy reading
-- `app.stack_id` through `nullif` so an unset or empty GUC matches nothing
-- instead of raising on a malformed uuid cast. FORCE matters because the table
-- owner would otherwise bypass its own policy.
alter table wiki.compile_config enable row level security;
alter table wiki.compile_config force row level security;

drop policy if exists tenant_isolation on wiki.compile_config;
create policy tenant_isolation on wiki.compile_config
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.compile_config to llmwiki_app;
