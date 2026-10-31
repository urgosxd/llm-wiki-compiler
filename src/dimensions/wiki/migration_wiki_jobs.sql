-- ============================================================
-- Durable ingest jobs
--
-- ## Why this table exists
--
-- Job state used to live only in the host process's memory, and the module that
-- owned it said so plainly: "Lose the process and the progress is gone." That was
-- the right cost while the HTTP listener was the only reader — a running ingest is
-- already serialized by the project lock, and a queued job cannot live inside a
-- transaction that has not opened.
--
-- It stops being right the moment a SECOND process needs to answer "how is my
-- ingest going". The MCP server is that process: it is a separate `llmwiki serve`
-- over stdio, it shares no memory with `llmwiki host`, and an agent driving the
-- product through MCP is exactly the caller who wants to poll rather than block.
--
-- ## Why one row per job, rewritten whole
--
-- `IngestJob` is immutable by contract: every transition REPLACES the snapshot
-- rather than mutating it. The two dimension states are nested objects with a
-- variable-length attempt list, so normalizing them would buy join cost for a
-- value that is only ever read as a whole. The table keeps the two dimensions as
-- `jsonb` and the columns a reader filters on (`status`, `source`) promoted out.
--
-- ## What is NOT stored
--
-- No page text, no source body, no credentials. A job record names the source
-- IDENTITY, the stages it reached and the error message — the same disclosure
-- stance as `ingest-failures.jsonl`, which stays as the append-only failure trail.
-- ============================================================

create table if not exists wiki.ingest_job (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- `ing_<ULID>`, minted by the registry. Unique per Stack, not globally: two
    -- Stacks are independent tenants and their id spaces must not collide.
    job_id text not null,

    -- Source identity the job was created for. Promoted out of the JSON so a
    -- reader can ask "was this document already ingested" without parsing.
    source text not null,

    -- Both dimension statuses promoted for the same reason: the MCP tool filters
    -- on "still running" and a jsonb path expression cannot use an index here.
    ingest_status text not null,
    compile_status text not null,

    -- The full `IngestJob` snapshot. Rewritten on every transition.
    payload jsonb not null,

    created_at timestamptz not null,
    updated_at timestamptz not null,

    primary key (stack_id, job_id)
);

-- Newest-first listing is the only read the tools perform that is not by id.
create index if not exists idx_ingest_job_recent
    on wiki.ingest_job (stack_id, updated_at desc);

-- "Is anything still running for this Stack" is asked on every status read.
create index if not exists idx_ingest_job_status
    on wiki.ingest_job (stack_id, ingest_status);

alter table wiki.ingest_job enable row level security;
alter table wiki.ingest_job force row level security;

drop policy if exists tenant_isolation on wiki.ingest_job;
create policy tenant_isolation on wiki.ingest_job
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

-- Same grant shape as every other wiki table; the role is created by
-- `migration_rls_tenancy.sql`, which `apply-schemas.sh` now runs first.
grant usage on schema wiki to llmwiki_app;
grant select, insert, update, delete on all tables in schema wiki to llmwiki_app;
