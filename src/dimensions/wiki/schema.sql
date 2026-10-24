-- ============================================================
-- The `wiki` schema: where compiled wiki pages live in Postgres
-- ============================================================
-- Run once against the same database the KG dimension already uses, as the DDL
-- owner (`aks`), after `packages/llmwiki-kg/db/migration_rls_tenancy.sql` so the
-- `llmwiki_app` role and the tenant GUC convention already exist:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- ## Why a separate schema instead of a table beside the graph's
--
-- The wiki and the knowledge graph are two DIMENSIONS that share one database and
-- one connection pool, not one module. Putting compiled wiki pages in `public`
-- beside `stack_documents` and `ontology_entities` would make the wiki's
-- persistence indistinguishable from the graph's, and would put wiki DDL in the
-- vendored AKS package's migration files. A named schema keeps the boundary
-- visible in the one place an operator looks: `\dt wiki.*` versus `\dt public.*`.
--
-- What the wiki does NOT get from this file is independence from the KG client.
-- Both dimensions are reached through the same pooled `postgres` client the KG
-- barrel already exports, because a second driver and a second pool against one
-- database buys nothing and doubles the connection configuration. The schema
-- boundary is about ownership and review, not about connection topology.
--
-- ## The tenant is the stack, exactly as in `public`
--
-- `stack_id` is the tenant key here for the same reason it is there: `stacks.id`
-- IS the tenant. The row-level-security predicate is deliberately identical to
-- the one in `migration_rls_tenancy.sql` -- `stack_id = nullif(current_setting(
-- 'app.stack_id', true), '')::uuid` -- so a reader who has learned the convention
-- once does not have to learn a second one.
--
-- NULLIF is load-bearing and not defensive noise. `current_setting(..., true)`
-- returns NULL for an UNKNOWN setting, but a setting that was explicitly reset
-- returns the EMPTY STRING, and `select ''::uuid` raises 22P02 -- an error, not
-- "no rows". An unbound session must match nothing, not crash.
--
-- ## The grant trap this file exists to avoid
--
-- `migration_rls_tenancy.sql` grants `llmwiki_app` access with `on all tables in
-- schema public` plus matching `alter default privileges ... in schema public`.
-- Neither reaches a NEW schema: a table created here would be unreadable by the
-- application role, and the failure would look like "the wiki dimension silently
-- returns nothing" rather than "permission denied". The grants at the bottom are
-- therefore not boilerplate; without them this migration produces a schema the
-- app can see and not use.

-- ------------------------------------------------------------
-- The schema
-- ------------------------------------------------------------
create schema if not exists wiki;

-- ------------------------------------------------------------
-- Compiled pages
-- ------------------------------------------------------------
-- One row per compiled concept or query page. The primary key is the page's
-- natural identity -- `(stack_id, page_directory, slug)` -- because a slug is
-- unique only WITHIN a directory, and `wiki.ts`'s writer already treats a
-- directory collision as a different page. A surrogate id would allow duplicate
-- pages to coexist, which is the one thing the write path must never permit.
--
-- `page_directory` is constrained to the two directories `PageDirectory` declares
-- in code (`src/export/types.ts:49`). Encoding that closed set in the database
-- means a typo'd directory is rejected on write instead of becoming a page no
-- reader ever lists.
--
-- `body` is stored inline rather than in an object store: W3 keeps L2 (the
-- compiled product) in the database and leaves L1 (raw source bytes) to Wave 4.
-- Keeping the two layers apart is what lets W4 move blobs without touching this
-- table.
create table if not exists wiki.pages (
    stack_id       uuid        not null references public.stacks(id) on delete cascade,
    page_directory text        not null check (page_directory in ('concepts', 'queries')),
    slug           text        not null,
    title          text        not null,
    summary        text        not null default '',
    tags           text[]      not null default '{}',
    links          text[]      not null default '{}',
    body           text        not null default '',
    orphaned       boolean     not null default false,
    archived       boolean     not null default false,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    primary key (stack_id, page_directory, slug)
);

-- Listing one tenant's pages newest-first is the reader's hot path
-- (`createWikiReader` -> listPages). The index leads with `stack_id` because RLS
-- filters on it first, so it is also the predicate's own index.
create index if not exists idx_wiki_pages_listing
    on wiki.pages (stack_id, page_directory, updated_at desc);

-- Text search over title and summary replaces the in-memory scan
-- `matchingPages` performs today. `pg_trgm` is already installed by the KG
-- schema, so this adds no extension requirement of its own.
create index if not exists idx_wiki_pages_title_trgm
    on wiki.pages using gin (title gin_trgm_ops);

create index if not exists idx_wiki_pages_summary_trgm
    on wiki.pages using gin (summary gin_trgm_ops);

-- ------------------------------------------------------------
-- Concept alias records
-- ------------------------------------------------------------
-- The persisted identity decisions from `concept-aliases.ts`: which merged-away
-- names resolve to which canonical one, under which embedding fingerprint and
-- ruleset version.
--
-- Stored as ONE row per tenant holding two jsonb arrays rather than a row per
-- alias, because the record is consumed as a unit: `conceptAliasRecordUsable`
-- invalidates the WHOLE record when the fingerprint changes, so partial reads have
-- no use. A row per alias would invite mixing aliases from two fingerprints,
-- which is precisely the state the fingerprint exists to forbid.
create table if not exists wiki.concept_aliases (
    stack_id      uuid        not null primary key references public.stacks(id) on delete cascade,
    version       integer     not null,
    fingerprint   text        not null,
    ruleset       integer     not null,
    aliases       jsonb       not null default '[]'::jsonb,
    pending       jsonb       not null default '[]'::jsonb,
    recorded_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Row-level security, mirroring `public`
-- ------------------------------------------------------------
-- ENABLE makes policies apply to non-owners; FORCE also applies them to the table
-- owner. Neither binds a SUPERUSER or BYPASSRLS connection -- that is a ROLE
-- attribute, and it is why `migration_rls_tenancy.sql` creates `llmwiki_app`. This
-- file inherits that requirement instead of restating it; if the application still
-- connects as `aks`, every policy below is inert.
alter table wiki.pages            enable row level security;
alter table wiki.concept_aliases  enable row level security;

alter table wiki.pages            force row level security;
alter table wiki.concept_aliases  force row level security;

drop policy if exists tenant_isolation on wiki.pages;
create policy tenant_isolation on wiki.pages
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.concept_aliases;
create policy tenant_isolation on wiki.concept_aliases
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

-- ------------------------------------------------------------
-- Grants (see "The grant trap" above)
-- ------------------------------------------------------------
-- `if not exists` on the role is intentionally absent: this file runs AFTER the
-- tenancy migration, and silently creating a role with different attributes would
-- defeat the point of that migration having verified them.
grant usage on schema wiki to llmwiki_app;
grant select, insert, update, delete on all tables in schema wiki to llmwiki_app;

-- Future tables in this schema are covered too, so a later wiki table does not
-- arrive ungranted the way this whole schema would have without these lines.
alter default privileges in schema wiki
    grant select, insert, update, delete on tables to llmwiki_app;
