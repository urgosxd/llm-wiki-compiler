-- ============================================================
-- wiki.profile — the project profile, one row per Stack
--
-- ## What this replaces
--
-- `.llmwiki/profile.json`. Decision 1 answered "per Stack", and this is where that
-- answer becomes true: a profile is per-tenant configuration, so a tenant boundary is
-- what it belongs on.
--
-- ## Why the raw JSON and the digest, not a column per field
--
-- The profile is a nested document (`entities`, `tags`, workflow actions, governance)
-- that `validateProfile` already checks and `profileDigest` already content-addresses.
-- Shredding it into columns would mean a migration per profile schema change and
-- would let the table and the validator disagree about what is legal. The row holds
-- the document, and the SAME validator that guards the file guards the row.
--
-- `digest` is stored rather than recomputed on read because it is what
-- `activeProfileDigest` binds: a projection that verified against a profile must be
-- able to confirm it is still looking at the same one. Recomputing would still be
-- correct but would silently accept a document whose bytes changed underneath a
-- caller that had already checked the digest.
--
-- ## Why the binding conflict still works
--
-- `resolveActiveProduct` calls `profileJsonPresent(root)` to decide whether a product
-- binding and a legacy profile COEXIST -- and coexistence is a fail-closed
-- `ProductAuthorityConflictError`, neither side winning. That check lstat'd the file.
-- Moving the profile into a row without teaching that check about rows would have
-- turned an authority conflict into a silent product-mode win, so
-- `profileJsonPresent` now asks BOTH backends.
-- ============================================================

create table if not exists wiki.profile (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- The validated profile document, exactly as the writer serialized it.
    document jsonb not null,

    -- Content address of `document`, as `profileDigest` computes it. Read, never
    -- trusted blindly: the loader recomputes and compares, so a tampered row is a
    -- load error rather than a silently different authority.
    digest text not null,

    updated_at timestamptz not null default now(),

    primary key (stack_id)
);

alter table wiki.profile enable row level security;
alter table wiki.profile force row level security;

drop policy if exists tenant_isolation on wiki.profile;
create policy tenant_isolation on wiki.profile
    for all
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.profile to llmwiki_app;
