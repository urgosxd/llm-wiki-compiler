-- ============================================================
-- wiki.project_config — the Stack-scoped replacement for `.llmwiki/config.json`
--
-- ## What moves, and why it is per-Stack
--
-- `.llmwiki/config.json` holds settings that describe HOW one Stack's wiki is
-- built and reviewed:
--
--   review    — which findings hold a candidate for human review
--   sources   — whether source discovery recurses, and what it excludes
--
-- Neither is a property of a document, and neither is a property of a checkout.
-- They are properties of the STACK: two checkouts serving one Stack must review
-- and discover the same way, and the file-backed answer let them disagree
-- silently. That is the same defect the rest of this migration series removes —
-- a Stack whose behaviour depends on which machine asked.
--
-- ## Why a JSONB column and not one column per setting
--
-- `config.json` is explicitly EXTENSIBLE: `requireConfigRecord` retains unknown
-- keys precisely so one consumer does not erase another's settings, and the
-- versioned envelope exists to let the shape grow. Flattening `review` and
-- `sources` into columns would freeze a document the code deliberately keeps
-- open, and every new setting would need a migration.
--
-- What lands here is therefore the validated ENVELOPE (`{"version": 1, ...}`),
-- read through the same `normalizeProjectConfig` the file path uses. The database
-- stores the document; the code keeps owning its meaning.
--
-- ## Why `version` is also a column
--
-- The envelope's own `version` is inside the JSON, but a column makes an
-- incompatible document cheap to find (`where version <> 1`) without parsing
-- every row, and makes the constraint expressible at the schema rather than only
-- in application code. The two are written together and must agree; the store
-- refuses a document whose inner version disagrees with its column.
-- ============================================================

create table if not exists wiki.project_config (
    stack_id uuid primary key references stacks(id) on delete cascade,

    -- The validated config document, exactly as `.llmwiki/config.json` held it.
    -- Unknown keys are preserved: consumers retain what they do not understand.
    document jsonb not null,

    -- Mirrors `document->>'version'`. A mismatch is a bug in the writer, not a
    -- state a reader should try to interpret, so the store rejects it.
    version integer not null,

    updated_at timestamptz not null default now(),

    -- A config document is a small JSON record. A multi-MB one is either a
    -- mistake or an attempt to make every read expensive; both are refused here
    -- rather than at every consumer.
    constraint project_config_document_size
        check (pg_column_size(document) <= 65536)
);

alter table wiki.project_config enable row level security;
alter table wiki.project_config force row level security;

drop policy if exists tenant_isolation on wiki.project_config;
create policy tenant_isolation on wiki.project_config
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.project_config to llmwiki_app;
