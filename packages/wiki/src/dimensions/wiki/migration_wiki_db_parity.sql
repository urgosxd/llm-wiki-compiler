-- ============================================================
-- Migration: the state a row-backed Stack was silently losing
-- ============================================================
-- Run once to upgrade an existing database without losing data. The file is listed
-- in `scripts/apply-schemas.sh`, which owns the order, so the documented way to apply
-- it to a live database is the runner itself:
--
--   ./scripts/apply-schemas.sh postgres://aks:aks@localhost:5434/aks
--
-- Applied alone, it is the same statements a hand-migration runs:
--
--   docker compose exec db psql -U aks -d aks -f /path/to/this/file
--
-- This file is MIRRORED in `src/dimensions/wiki/schema.sql`, so a fresh database
-- reaches the same shape from the start and a migrated database and a fresh one
-- agree. The duplication is this package's existing convention (see
-- `migration_page_embeddings.sql`): there is no migration runner in the application,
-- so `schema.sql` must be self-sufficient for a clean install while a live database
-- still needs this file applied. The mirror in `schema.sql` is delimited by the
-- comments `wiki-db-parity-mirror:begin` and `wiki-db-parity-mirror:end` for a reader's
-- benefit; `test/dimensions/db-parity-migration.test.ts` does NOT read them. It builds
-- the pre-migration database from the frozen snapshot
-- `test/fixtures/wiki-schema-pre-db-parity.sql`, applies THIS file to it, and compares
-- the result against a fresh install built from the mirrored `schema.sql`. The snapshot
-- is frozen because deriving the pre-migration side from the current `schema.sql` would
-- compare one file against itself: drift in its pre-migration portion would move both
-- sides by the same amount and stay invisible. The two copies are therefore kept honest
-- by a real Postgres instead of by review.
--
-- ## What was missing, and why each shape is the one the file path uses
--
-- The stability work landed on the file-backed store only: aliases and attribution
-- gaps live in page frontmatter, curated links in `.llmwiki/curated-links.json`, and
-- categories in `wiki/categories/<categoryId>.md`. A Stack whose pages live in
-- `wiki.pages` rows lost all four, because `renderPageMarkdown` can only rebuild a
-- page from the columns that exist -- so a fact with no column cannot survive the
-- round trip. Parity is therefore a persistence question, and the shapes below are
-- chosen to match how the file path already treats each artifact:
--
--   aliases, attribution_gaps   per-PAGE facts, so per-row columns, not a table. The
--                               dead `wiki.concept_aliases` table is NOT reused: its
--                               primary key is `stack_id`, so it can hold one row per
--                               Stack, and its `fingerprint` column invalidates the
--                               WHOLE record when the embedding model changes -- the
--                               oscillation this migration exists to remove. It is
--                               also not dropped; dropping a table is not this file's
--                               business (see `odd/tasks/wiki-db-parity.md`, D1/D2).
--   curated_links               one row per link, keyed by the stable key the file
--                               store already mints from (source, target, anchor), and
--                               carrying the anchor plus its surrounding prose so the
--                               overlay can re-validate it against the regenerated
--                               body on every render (D3).
--   categories, category_members
--                               one row per category, keyed by the identity minted
--                               ONCE from the canonical name, plus one row per
--                               membership carrying the reason and evidence key. The
--                               identity comes from the lowercased slug in BOTH paths
--                               (`categoryIdForName` -> `slugify`), so `Foo` and `foo`
--                               are already ONE object in the file path and are one
--                               object here too. No unique index is added on
--                               `canonical_name`, so this migration neither creates nor
--                               worsens that collapse, and parity holds because the
--                               behaviour is shared (D4, corrected in L5).
--
-- ## Non-destructive and idempotent by construction
--
-- No `drop table`, no `drop column`, no `truncate`, no rebuild, no volume reset.
-- Columns arrive through `add column if not exists`, tables through
-- `create table if not exists`, indexes through `create index if not exists`, and
-- every policy is dropped with `drop policy if exists` before it is created. There is
-- no backfill to write: the new columns are NOT NULL with a constant default, so
-- Postgres fills existing rows with `'[]'` as part of the DDL and rewrites nothing.
-- Re-running this file on an up-to-date database is therefore a no-op, which the
-- parity test proves by applying it to the same database twice and diffing the schema.
--
-- `wiki.concept_aliases` is READ by nothing and WRITTEN by nothing; this file leaves
-- it exactly as it is.

-- ------------------------------------------------------------
-- 1. Page-scoped artifacts: aliases and attribution gaps
-- ------------------------------------------------------------

-- `aliases` holds the merged-away names that resolve to this page, in the order they
-- were folded, so the identity tier can read back the same incumbent set the file path
-- reads out of frontmatter.
--
-- `attribution_gaps` holds the sources this page draws on and does not cite, so a
-- row-backed page is never rendered as fully attributed when it is not. Both are jsonb
-- arrays rather than child tables for the same reason the file path keeps them in
-- frontmatter: they are read and written as a per-page unit, and no query filters on a
-- single alias or a single gap.
alter table wiki.pages
    add column if not exists aliases jsonb not null default '[]'::jsonb;

alter table wiki.pages
    add column if not exists attribution_gaps jsonb not null default '[]'::jsonb;

-- ------------------------------------------------------------
-- 2. Curated contextual links
-- ------------------------------------------------------------
-- `stable_key` is the identity the file store already computes from
-- (source, target, anchor text), so re-reviewing the same link updates one row instead
-- of forking a second. `anchor_before` / `anchor_after` are the prose around the
-- mention: without them a lost anchor cannot be reported in a way an operator can act
-- on, and with them the overlay can tell "the wording moved" from "the mention is gone".
--
-- `source_page_id` / `target_page_id` are page IDS (`concepts/<slug>`), not foreign
-- keys: a curated link is an operator decision recorded against the page a reader was
-- shown, and a page that is retired and rebuilt under the same slug must keep its
-- links. The tenant is the Stack, and `stack_id` carries the cascade.
create table if not exists wiki.curated_links (
    stack_id       uuid        not null references public.stacks(id) on delete cascade,
    stable_key     text        not null,
    source_page_id text        not null,
    target_page_id text        not null,
    anchor_text    text        not null,
    anchor_before  text        not null default '',
    anchor_after   text        not null default '',
    provenance     text        not null,
    created_at     timestamptz not null default now(),
    primary key (stack_id, stable_key)
);

-- The overlay loads one page's records on every render, and `links-here` asks the
-- opposite direction; both lead with `stack_id` so each is also the RLS predicate's
-- own index.
create index if not exists idx_wiki_curated_links_source
    on wiki.curated_links (stack_id, source_page_id);

create index if not exists idx_wiki_curated_links_target
    on wiki.curated_links (stack_id, target_page_id);

-- ------------------------------------------------------------
-- 3. Categories and their membership evidence
-- ------------------------------------------------------------
-- `category_id` is the identity minted once from the canonical name and never
-- recomputed: renaming a category patches `canonical_name` and leaves the primary key
-- alone, so links and memberships survive a rename. The identity is the lowercased slug
-- (`categoryIdForName` -> `slugify`, `src/categories/identity.ts` and
-- `src/utils/markdown.ts`), so case-variant names such as `Foo` and `foo` mint the SAME
-- id and are ONE object here -- exactly as they are one object in the file path, where
-- both resolve to `wiki/categories/<categoryId>.md`. There is deliberately NO unique
-- constraint on `canonical_name`: the migration introduces no name-level uniqueness, so
-- it neither creates nor worsens that collapse, and merging two distinct ids to satisfy
-- a constraint would be the collision resolution this assignment forbids.
create table if not exists wiki.categories (
    stack_id            uuid        not null references public.stacks(id) on delete cascade,
    category_id         text        not null,
    canonical_name      text        not null,
    description         text        not null default '',
    inclusion_criterion text        not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    primary key (stack_id, category_id)
);

-- Membership is stored as EVIDENCE, not as a bare id: `reason` is why this page was
-- assigned and `evidence_key` is the canonical key of the criterion (or name evidence)
-- it was judged against, recorded at assignment time and never recomputed. That is
-- what makes membership re-derivable and auditable months later.
--
-- `reason` and `evidence_key` are NOT NULL with a `''` default so this DDL can be
-- replayed over any existing database without inventing a justification: the writer
-- refuses an empty reason (`CategoryValidationError`), which is where that rule
-- belongs, because only the writer knows what evidence it had.
create table if not exists wiki.category_members (
    stack_id     uuid not null,
    category_id  text not null,
    page_id      text not null,
    reason       text not null default '',
    evidence_key text not null default '',
    primary key (stack_id, category_id, page_id),
    constraint category_members_category_fkey
        foreign key (stack_id, category_id)
        references wiki.categories (stack_id, category_id)
        on delete cascade
);

-- "Which categories is this page in?" is asked when a page is rendered; the primary
-- key answers the opposite direction only.
create index if not exists idx_wiki_category_members_page
    on wiki.category_members (stack_id, page_id);

-- ------------------------------------------------------------
-- 4. Tenancy, exactly as every other wiki table does it
-- ------------------------------------------------------------
-- Enabled AND forced, with the policy reading `app.stack_id` through `nullif` so an
-- unset or empty GUC matches nothing instead of raising on a malformed uuid cast.
-- `wiki.pages` already has this treatment in `schema.sql`; it is repeated here because
-- a policy that exists on one database and not on another is exactly the drift this
-- file exists to prevent, and `drop policy if exists` makes re-creating it a no-op.
--
-- The `wiki.pages` policy is recreated with the SAME predicate `schema.sql` gives it
-- (a `using` clause and no `with check`), so applying this file to a migrated database
-- cannot make its policy differ from a fresh install's.
alter table wiki.pages                enable row level security;
alter table wiki.pages                force row level security;
alter table wiki.curated_links        enable row level security;
alter table wiki.curated_links        force row level security;
alter table wiki.categories           enable row level security;
alter table wiki.categories           force row level security;
alter table wiki.category_members     enable row level security;
alter table wiki.category_members     force row level security;

drop policy if exists tenant_isolation on wiki.pages;
create policy tenant_isolation on wiki.pages
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.curated_links;
create policy tenant_isolation on wiki.curated_links
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.categories;
create policy tenant_isolation on wiki.categories
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.category_members;
create policy tenant_isolation on wiki.category_members
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

-- ------------------------------------------------------------
-- 5. Grants (see "The grant trap" in `schema.sql`)
-- ------------------------------------------------------------
-- `alter default privileges in schema wiki` in `schema.sql` already covers tables
-- created there by `aks`, which is why this is usually a no-op. It is stated anyway:
-- a `wiki` table the application role cannot read fails as "the wiki dimension
-- returns nothing", which is indistinguishable from "there is nothing", and that is
-- the one failure mode this schema exists to keep loud.
grant select, insert, update, delete
    on wiki.curated_links, wiki.categories, wiki.category_members
    to llmwiki_app;

