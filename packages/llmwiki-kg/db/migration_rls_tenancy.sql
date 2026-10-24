-- ============================================================
-- Migration: enforce tenancy with row-level security
-- ============================================================
-- Run once against an existing database, after the application role exists:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- ## Read this before trusting it
--
-- `FORCE ROW LEVEL SECURITY` binds POLICIES TO THE TABLE OWNER. It does NOT
-- override `SUPERUSER` or `BYPASSRLS`, which are ROLE attributes. Measured on the
-- live database:
--
--   | role                                  | rows visible (RLS + FORCE) |
--   | ------------------------------------- | -------------------------- |
--   | `aks` (rolsuper=t, rolbypassrls=t)    | 2 of 2 — RLS IGNORED       |
--   | nologin nosuperuser nobypassrls       | 1 of 2 — RLS works         |
--
-- So this migration is INERT while the application connects as `aks`. That is why
-- it also creates `llmwiki_app`: until DATABASE_URL names that role, every policy
-- below evaluates to "allow everything" and the schema is unchanged in practice.
-- `aks` stays the DDL/migration owner because creating extensions requires it.
--
-- ## The tenant is the stack
--
-- `stacks` has no `tenant_id` column and must not get one: `stacks.id` IS the
-- tenant (its `domain` is already `not null unique`). Every other table carries
-- `stack_id`, so the predicate is uniform there and asymmetric on `stacks`:
--
--   stacks            using (id = nullif(current_setting('app.stack_id', true), '')::uuid)
--   everything else   using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
--
-- `app.stack_domain` exists so a caller that resolved a stack BY DOMAIN can still
-- read `stacks` before `app.stack_id` is known. Policies on `stacks` accept either
-- match. Content tables accept only the id, because resolution precedes content.
--
-- ## Failing closed needs NULLIF, not just the `,true` suffix
--
-- `,true` makes an UNKNOWN setting return NULL instead of raising. But a setting
-- that was explicitly reset can come back as the EMPTY STRING, and `''::uuid`
-- raises 22P02 — an error, not "no rows". Measured:
--
--   select ''::uuid  ->  ERROR: invalid input syntax for type uuid: ""
--
-- So every predicate wraps the setting in NULLIF(..., ''). NULLIF yields NULL,
-- NULL::uuid stays NULL, and the policy evaluates to NULL (treated as false),
-- which is the fail-CLOSED behaviour a missing binding must have. Without it, an
-- unbound session crashes instead of returning nothing.

-- ------------------------------------------------------------
-- The application role
-- ------------------------------------------------------------
-- NOLOGIN here: a password is set by the operator, not committed to the repo.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'llmwiki_app') then
        create role llmwiki_app nologin nosuperuser nocreatedb nocreaterole nobypassrls;
    end if;
end
$$;

grant usage on schema public to llmwiki_app;
grant select, insert, update, delete on all tables in schema public to llmwiki_app;
grant usage, select on all sequences in schema public to llmwiki_app;
-- Future tables created by `aks` are covered too, so a new table does not silently
-- arrive ungranted.
alter default privileges in schema public grant select, insert, update, delete on tables to llmwiki_app;

-- ------------------------------------------------------------
-- Enable RLS on all eight tables
-- ------------------------------------------------------------
-- ENABLE makes policies apply to non-owners; FORCE also applies them to the owner.
-- Neither reaches a SUPERUSER/BYPASSRLS connection — see the header.
alter table stacks                  enable row level security;
alter table stack_documents         enable row level security;
alter table document_chunks         enable row level security;
alter table ontology_entities       enable row level security;
alter table ontology_relationships  enable row level security;
alter table entity_source_documents enable row level security;
alter table entity_pages            enable row level security;
alter table backfeed_queue          enable row level security;

alter table stacks                  force row level security;
alter table stack_documents         force row level security;
alter table document_chunks         force row level security;
alter table ontology_entities       force row level security;
alter table ontology_relationships  force row level security;
alter table entity_source_documents force row level security;
alter table entity_pages            force row level security;
alter table backfeed_queue          force row level security;

-- ------------------------------------------------------------
-- Policies: `stacks` accepts an id OR a domain match
-- ------------------------------------------------------------
-- Resolution by domain happens BEFORE app.stack_id is known, so this table cannot
-- use the uniform predicate. Getting this wrong in the safe-looking direction
-- (id-only) would make domain-based stack resolution impossible.
drop policy if exists tenant_isolation on stacks;
create policy tenant_isolation on stacks
    using (
        id = nullif(current_setting('app.stack_id', true), '')::uuid
        or domain = nullif(current_setting('app.stack_domain', true), '')
    );

-- ------------------------------------------------------------
-- Policies: every other table is id-only
-- ------------------------------------------------------------
drop policy if exists tenant_isolation on stack_documents;
create policy tenant_isolation on stack_documents
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on document_chunks;
create policy tenant_isolation on document_chunks
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on ontology_entities;
create policy tenant_isolation on ontology_entities
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on ontology_relationships;
create policy tenant_isolation on ontology_relationships
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on entity_source_documents;
create policy tenant_isolation on entity_source_documents
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on entity_pages;
create policy tenant_isolation on entity_pages
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on backfeed_queue;
create policy tenant_isolation on backfeed_queue
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);
