-- ============================================================
-- Migration: move the ingest outbox from JSON files to a table
-- ============================================================
-- Run once to upgrade an existing database without losing data:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- Also included in schema.sql, so a fresh volume creates the table from the start.
-- The duplication is this package's existing convention: there is no migration
-- runner, so schema.sql must be self-sufficient for a clean install while a live
-- database still needs the statements applied by hand.
--
-- ## Why a table and not the existing `.llmwiki/dimensions/outbox/*.json`
--
-- The file outbox was per-project: one directory under each checkout's `.llmwiki`.
-- That was correct while an ingest belonged to a directory, and it stopped being
-- correct once the compiled pages became rows. An ingest now belongs to a STACK --
-- the same stack both dimensions are bound to -- so the recovery record has to live
-- where the stack lives, or two projects sharing one database would reconcile each
-- other's interrupted ingests. Measured before this migration: 412 stacks in one
-- database and no column anywhere identifying a project, so a project-scoped record
-- had no honest place to sit.
--
-- ## Why the payload is stored rather than re-fetched
--
-- A pending record must be replayable without the original bytes. The file version
-- stored `document` and `body` for exactly that reason and this keeps the same
-- contract: a reconciler that runs on the next boot has no network, no source file,
-- and no way to ask the caller to resend.
--
-- ## Tenant isolation
--
-- `stack_id` is in the table and the policy, so RLS applies exactly as it does to
-- every other tenanted table. A record is only visible to a session bound to its
-- own stack. The reconciler runs under `withTenant`, which is what makes "finish
-- the ingests of THIS stack" a query rather than a filter someone must remember.

create table if not exists ingest_outbox (
    -- Stable id, minted by the coordinator before any dimension commits.
    ingest_id text primary key,
    -- The Stack this ingest belongs to. Both dimensions are bound to it.
    stack_id uuid not null references stacks (id) on delete cascade,
    -- Source identity the dimensions were given.
    source text not null,
    title text not null,
    -- Retained so a replay needs no re-fetch and no caller round trip.
    document text not null,
    body text not null,
    status text not null check (status in ('pending', 'committed')),
    -- Per-dimension progress: which dimensions committed and under which key.
    -- A null idempotency_key inside an entry is work the reconciler must retry.
    dimensions jsonb not null,
    created_at timestamptz not null default now(),
    -- Updated on every write so an operator can see how long a record has been
    -- pending, which is the question a stuck ingest actually raises.
    updated_at timestamptz not null default now()
);

-- The reconciler's only query: every record of one stack that is still pending.
-- Partial, because committed records are deleted rather than scanned.
create index if not exists idx_ingest_outbox_pending
    on ingest_outbox (stack_id)
    where status = 'pending';

-- RLS, matching every other tenanted table. `force` binds the policy to the table
-- owner too, so a superuser connection that owns this table is the only way to
-- escape it -- which is exactly the situation `DATABASE_URL` must move away from.
alter table ingest_outbox enable row level security;
alter table ingest_outbox force row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where tablename = 'ingest_outbox' and policyname = 'tenant_isolation'
    ) then
        create policy tenant_isolation on ingest_outbox
            using (stack_id = (nullif(current_setting('app.stack_id', true), ''))::uuid)
            with check (stack_id = (nullif(current_setting('app.stack_id', true), ''))::uuid);
    end if;
end $$;

grant select, insert, update, delete on ingest_outbox to llmwiki_app;

comment on table ingest_outbox is
    'Durable record of a two-dimension ingest, written before any commit so an interrupted run can be finished later. Belongs to a Stack, not a project.';
