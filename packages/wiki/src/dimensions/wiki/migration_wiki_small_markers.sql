-- ============================================================
-- The three small markers: pending embeddings, lint cache, rule state
--
-- Each is a bounded piece of per-project bookkeeping whose only reason to be a file
-- was that everything else was. Grouped in one migration because separately none of
-- them is worth a review.
-- ============================================================

-- ------------------------------------------------------------
-- Pending embedding refreshes, and their quarantine
--
-- `.llmwiki/pending-embeddings.json` and `.llmwiki/quarantined-embeddings.json` share
-- ONE shape: a list of `{pageId, attempts}`. Two files existed because one list is
-- retried and the other has aged out — a distinction a single `state` column carries
-- without duplicating the schema, the readers and the caps.
--
-- The list is a RETRY MARKER, not a queue with ordering semantics: it is rewritten
-- whole on every settle. Rows keep that by making `(stack_id, page_id)` the key and
-- replacing the set inside one transaction.
-- ------------------------------------------------------------
create table if not exists wiki.embedding_refresh_marker (
    stack_id uuid not null references stacks(id) on delete cascade,
    page_id text not null,

    -- Failed refresh attempts that led here. Reaching the cap quarantines the id.
    attempts integer not null default 0,

    -- `pending` is retried; `quarantined` has aged out and is only reported.
    state text not null default 'pending' check (state in ('pending', 'quarantined')),

    updated_at timestamptz not null default now(),

    primary key (stack_id, page_id)
);

create index if not exists idx_embedding_refresh_state
    on wiki.embedding_refresh_marker (stack_id, state);

-- ------------------------------------------------------------
-- Lint result cache
--
-- `.llmwiki/last-lint.json`. A CACHE in the strict sense: losing it costs a re-lint
-- and nothing else, which is why a malformed row is treated as a miss rather than an
-- error.
-- ------------------------------------------------------------
create table if not exists wiki.lint_cache (
    stack_id uuid primary key references stacks(id) on delete cascade,

    -- Digest of the inputs the cached result was computed from, so a changed wiki
    -- invalidates by comparison rather than by a timestamp.
    input_hash text not null,

    -- The cached findings, verbatim. jsonb because the reader validates the shape it
    -- expects and a column per lint rule would be a migration per rule.
    findings jsonb not null default '[]'::jsonb,

    -- Counts the reader reports without walking the findings.
    error_count integer not null default 0,
    warning_count integer not null default 0,

    updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Rule extractor state
--
-- `.llmwiki/rule-state.json`. Its contents mirror the compile state closely (source
-- hashes and concepts), because it tracks the same sources through a DIFFERENT
-- extractor. Kept as jsonb for that reason: it is a snapshot the extractor owns, not
-- a shape the product queries across Stacks.
-- ------------------------------------------------------------
create table if not exists wiki.rule_extractor_state (
    stack_id uuid primary key references stacks(id) on delete cascade,
    state jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

-- ============================================================
-- Row-level security
-- ============================================================
alter table wiki.embedding_refresh_marker enable row level security;
alter table wiki.embedding_refresh_marker force row level security;
alter table wiki.lint_cache enable row level security;
alter table wiki.lint_cache force row level security;
alter table wiki.rule_extractor_state enable row level security;
alter table wiki.rule_extractor_state force row level security;

drop policy if exists tenant_isolation on wiki.embedding_refresh_marker;
create policy tenant_isolation on wiki.embedding_refresh_marker
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.lint_cache;
create policy tenant_isolation on wiki.lint_cache
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.rule_extractor_state;
create policy tenant_isolation on wiki.rule_extractor_state
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.embedding_refresh_marker to llmwiki_app;
grant select, insert, update, delete on wiki.lint_cache to llmwiki_app;
grant select, insert, update, delete on wiki.rule_extractor_state to llmwiki_app;
