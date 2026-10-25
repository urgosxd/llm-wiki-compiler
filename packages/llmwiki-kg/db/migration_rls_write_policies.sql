-- ============================================================
-- Migration: give the RLS policies their WRITE half
-- ============================================================
-- Run once against an existing database, as the table owner:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- ## Why this file exists
--
-- `migration_rls_tenancy.sql` creates every policy with `using (...)` only.
-- `USING` is a READ predicate: it filters SELECT, UPDATE-target and
-- DELETE-target rows. It does NOT validate what an INSERT or UPDATE writes.
-- Postgres has a separate clause for that, `WITH CHECK`.
--
-- Measured consequence, connecting as `llmwiki_app` (nosuperuser, nobypassrls):
-- 195 of 743 tests fail, and every one of them starts the same way:
--
--   PostgresError: new row violates row-level security policy for table "stacks"
--
-- Every write is rejected outright, including `insert into stacks` in
-- `POST /stacks`. So the tenancy migration is not "inert until you switch roles";
-- it is incomplete, and switching roles today would take the service down.
--
-- ## The shape of the fix, and why it is not uniform
--
-- Seven tables take the same predicate as their read policy: `stack_id` must equal
-- the bound tenant. Content is always written *after* the Stack is resolved, so
-- the binding is available.
--
-- `stacks` cannot use that predicate. Creating a Stack is the one operation where
-- the row being written IS the tenant, and `app.stack_id` does not exist yet — a
-- bootstrap problem. A `with check (id = app.stack_id)` there would make
-- `POST /stacks` impossible for every caller, forever.
--
-- `stacks` therefore gets a policy that binds INSERT to the domain the caller
-- supplied:
--
--   with check (domain = nullif(current_setting('app.stack_domain', true), ''))
--
-- That is only meaningful if `POST /stacks` actually sets `app.stack_domain`
-- before its insert. It does not today, so `routes/stacks.ts` must bind the domain
-- it is about to create BEFORE inserting. Without that, this policy refuses Stack
-- creation, which is the correct failure — a missing binding must fail closed — but
-- it is a code change that belongs with this migration, not before it.
--
-- ## Order of operations, and why it matters
--
-- 1. Apply this migration (safe while `DATABASE_URL` still names `aks`; `aks`
--    bypasses RLS, so nothing changes yet).
-- 2. Land the `routes/stacks.ts` domain binding.
-- 3. Run the suite with `AKS_TEST_DATABASE_URL` pointed at `llmwiki_app`.
-- 4. Only then point `DATABASE_URL` at `llmwiki_app`.
--
-- Steps 1 and 2 are independent; step 3 is the gate for step 4.
--
-- ## What this does NOT fix
--
-- `llmwiki_app` is created `nologin` with no password. Creating a login role and
-- setting a password is an operator action, deliberately not committed here.

-- ------------------------------------------------------------
-- Content tables: stack_id must equal the bound tenant
-- ------------------------------------------------------------
-- `drop policy` + `create policy` rather than `alter policy`, so this file is
-- idempotent and re-runnable: a second apply replaces the policies instead of
-- failing on a duplicate name.

drop policy if exists tenant_isolation on stack_documents;
create policy tenant_isolation on stack_documents
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on document_chunks;
create policy tenant_isolation on document_chunks
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on ontology_entities;
create policy tenant_isolation on ontology_entities
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on ontology_relationships;
create policy tenant_isolation on ontology_relationships
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on entity_source_documents;
create policy tenant_isolation on entity_source_documents
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on entity_pages;
create policy tenant_isolation on entity_pages
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on backfeed_queue;
create policy tenant_isolation on backfeed_queue
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

-- ------------------------------------------------------------
-- `stacks`: the bootstrap table, so the write predicate is the domain
-- ------------------------------------------------------------
-- Read stays as it is — id OR domain, because resolution by domain happens before
-- `app.stack_id` is known.
--
-- Write is `domain = app.stack_domain`. Two consequences worth stating:
--
--   * A caller cannot create a Stack under a domain it was not bound to. That is
--     the isolation this migration exists for.
--   * `POST /stacks` must bind the domain it is about to create BEFORE its insert,
--     or this refuses the creation. That is fail-closed and intended.
--
-- Updates to an existing Stack still work: `using` selects the row by id, and the
-- `with check` validates the domain, which an update does not change.
drop policy if exists tenant_isolation on stacks;
create policy tenant_isolation on stacks
    using (
        id = nullif(current_setting('app.stack_id', true), '')::uuid
        or domain = nullif(current_setting('app.stack_domain', true), '')
    )
    with check (
        domain = nullif(current_setting('app.stack_domain', true), '')
    );
