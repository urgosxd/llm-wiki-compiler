-- ============================================================
-- wiki.derived_artifact — rendered navigation artifacts, as rows
--
-- ## What this replaces
--
-- `wiki/index.md` and `wiki/MOC.md`. Both are DERIVED: they are rendered from the
-- page registry and carry no information the registry does not already hold. Nothing
-- in `src/` reads either one back — the only consumers are a browsing human, the
-- Obsidian vault, and the OKF export. They were files because everything was.
--
-- ## Why ONE table and not two
--
-- The two artifacts differ only in which name they are stored under and what the
-- renderer emitted. A `kind` column carries that difference without duplicating the
-- schema, the RLS policy and the grants, which is the same reasoning that put the two
-- embedding markers in one table behind a `state` column.
--
-- ## Why the rendered markdown, not the model behind it
--
-- Unlike the activity log -- where the OKF export PARSES headings, so the field/data
-- split matters -- nothing reads these back. Storing the rendered text is therefore
-- the honest representation: the row holds exactly what the writer produced, and a
-- future reader is not forced to re-derive it from a model that may have changed.
--
-- If a reader is ever added, it should read the RENDERED text and not reconstruct it,
-- because the renderer is allowed to change while a stored artifact is not.
-- ============================================================

create table if not exists wiki.derived_artifact (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- Which artifact: `index` (wiki/index.md) or `moc` (wiki/MOC.md). Deliberately
    -- not the filename: the storage key should not encode where the file used to be.
    kind text not null check (kind in ('index', 'moc')),

    -- Exactly what the renderer emitted, byte for byte.
    content text not null,

    updated_at timestamptz not null default now(),

    primary key (stack_id, kind)
);

alter table wiki.derived_artifact enable row level security;
alter table wiki.derived_artifact force row level security;

drop policy if exists tenant_isolation on wiki.derived_artifact;
create policy tenant_isolation on wiki.derived_artifact
    for all
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.derived_artifact to llmwiki_app;
