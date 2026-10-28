-- ============================================================
-- wiki.artifact + wiki.artifact_member — artifact bundles, as rows
--
-- ## What this replaces
--
-- `artifacts/<type>/<slug>/<fileName>` plus its `<fileName>.manifest.json` sidecar,
-- and — for a member-bearing type — every sibling member leaf in that directory.
--
-- ## Why the filesystem could be the identity, and why a row cannot
--
-- The file store identifies a bundle by the EXACT SET OF FILES in its directory:
-- `resolveArtifactRef` reports `artifact-dangling` when the directory holds a leaf the
-- manifest does not name, and `apply-members` unlinks "obsolete" leaves left by a
-- shrink or rename. That property is enforced today by listing a real directory, and it
-- is the reason `store.ts` carries no-follow-leaf reads, parent-realpath confinement and
-- post-read TOCTOU re-confirmation: a directory is an untrusted namespace shared with
-- whatever else can write to it.
--
-- A row set is a closed namespace by construction. "The directory holds nothing else"
-- becomes "the member rows for this artifact are exactly this set", which the primary
-- key states rather than a directory listing verifies. Obsolete leaves disappear
-- because a delete inside the same transaction IS the removal, not a best-effort unlink
-- that can fail while the batch commits.
--
-- ## Why the raw body, not a normalised one
--
-- `hashArtifactBody` hashes the body bytes and the manifest records `sha256` and
-- `bytes` over them; the member ref is a Merkle root computed over member bytes plus
-- the manifest body core. Any re-encoding changes the hash, which is the artifact's
-- public identity (refs are pinned in events, receipts and workflow state). The body
-- column therefore stores the exact bytes the writer produced, and `sha256`/`bytes` are
-- stored ALONGSIDE it so a reader can re-verify without trusting the column.
--
-- ## Member order
--
-- Member rows carry `position` because the Merkle root folds members in DECLARATION
-- order. Sorting by name would silently change the ref, so the order is explicit rather
-- than implied by whatever order the database happens to return.
-- ============================================================

create table if not exists wiki.artifact (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- The profile-declared artifact type and the artifact slug. Together they are the
    -- identity the file store expressed as a directory path.
    artifact_type text not null,
    slug text not null,

    -- The manifest body core, exactly as written. A member-bearing artifact's ref is
    -- derived from this, so it must round-trip byte-identically.
    body text not null,

    -- Re-verification material, stored so a reader never has to trust these to read but
    -- can always check them: `sha256(body)` and its byte length.
    sha256 text not null,
    bytes bigint not null check (bytes >= 0),

    -- `json` or `text`, from the artifact type declaration. Kept because the body
    -- contract validation branches on it.
    content_kind text not null check (content_kind in ('json', 'text')),

    -- The declared file name the bundle was written under. Retained for export and for
    -- ref parity with the file backend; it is NOT a path any more.
    file_name text not null,

    written_at text not null,

    primary key (stack_id, artifact_type, slug)
);

-- The sidecar manifest the file store kept beside the body. Stored as a JSON document
-- rather than widened into columns because nothing queries its fields individually: it
-- is written whole, read whole, and compared whole.
create table if not exists wiki.artifact_manifest (
    stack_id uuid not null references stacks(id) on delete cascade,
    artifact_type text not null,
    slug text not null,

    manifest jsonb not null,

    primary key (stack_id, artifact_type, slug),

    foreign key (stack_id, artifact_type, slug)
        references wiki.artifact (stack_id, artifact_type, slug) on delete cascade
);

-- One row per member leaf. `position` is the DECLARATION order the Merkle root folds in,
-- not a display hint -- see the header note.
create table if not exists wiki.artifact_member (
    stack_id uuid not null references stacks(id) on delete cascade,
    artifact_type text not null,
    slug text not null,

    file_name text not null,
    position integer not null check (position >= 0),

    -- Member bytes are arbitrary binary; bytea, never text. The file store records
    -- pre-states base64-ALWAYS for exactly this reason.
    bytes bytea not null,

    primary key (stack_id, artifact_type, slug, file_name),

    foreign key (stack_id, artifact_type, slug)
        references wiki.artifact (stack_id, artifact_type, slug) on delete cascade
);

create index if not exists artifact_member_position_idx
    on wiki.artifact_member (stack_id, artifact_type, slug, position);

alter table wiki.artifact enable row level security;
alter table wiki.artifact force row level security;
alter table wiki.artifact_manifest enable row level security;
alter table wiki.artifact_manifest force row level security;
alter table wiki.artifact_member enable row level security;
alter table wiki.artifact_member force row level security;

drop policy if exists tenant_isolation on wiki.artifact;
create policy tenant_isolation on wiki.artifact
    for all
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.artifact_manifest;
create policy tenant_isolation on wiki.artifact_manifest
    for all
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

drop policy if exists tenant_isolation on wiki.artifact_member;
create policy tenant_isolation on wiki.artifact_member
    for all
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.artifact to llmwiki_app;
grant select, insert, update, delete on wiki.artifact_manifest to llmwiki_app;
grant select, insert, update, delete on wiki.artifact_member to llmwiki_app;
