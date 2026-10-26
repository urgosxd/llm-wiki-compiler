-- ============================================================
-- wiki.template_lock — advisory template provenance, as a row
--
-- ## What this replaces
--
-- `.llmwiki/template-lock.json`. A single small JSON document recording which
-- template release a project has installed and, for a remote source, the verified
-- provenance that authorized it.
--
-- ## Why one row per Stack, not one row per lock
--
-- A project has exactly ONE installed template at a time; installing or updating
-- replaces the answer rather than accumulating history. That is a primary key on
-- `stack_id`, not a sequence of rows.
--
-- ## Why this is safe to move off the filesystem even though it is a LOCK
--
-- The name is misleading and the module says so: "Locks help status/update locate
-- releases but never authorize runtime behavior." Nothing gates on its presence, and
-- a forged value cannot grant anything -- the SIGNED package is what carries
-- authority, and this document only records which release was chosen. So a row is not
-- weakening an authorization boundary; it is relocating a cache.
--
-- The strict parser stays authoritative either way: `parseTemplateLock` validates the
-- exact key set and field shapes for each schema version, and this table stores the
-- document it produces rather than a set of columns that would have to re-derive
-- those rules. One storage, one validator, no drift.
--
-- ## Why `jsonb`
--
-- Nothing queries individual fields from SQL: `status`, `update` and `remote-lifecycle`
-- all parse it back into a `TemplateLock` and read it from TypeScript. Widening it into
-- columns would duplicate the schema-version branching (v1 vs v2, and the optional
-- `remote` block) that `parseTemplateLock` already owns.
-- ============================================================

create table if not exists wiki.template_lock (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- The lock document exactly as `buildTemplateLock` produced it. Stored whole so the
    -- strict parser remains the single authority over its shape.
    document jsonb not null,

    -- `sha256` of the canonical document text, so a reader that does not re-parse can
    -- still notice a value that changed underneath it.
    digest text not null,

    updated_at timestamptz not null default now(),

    primary key (stack_id)
);

alter table wiki.template_lock enable row level security;
alter table wiki.template_lock force row level security;

drop policy if exists tenant_isolation on wiki.template_lock;
create policy tenant_isolation on wiki.template_lock
    for all
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.template_lock to llmwiki_app;
