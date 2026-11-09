-- ============================================================
-- wiki.review_candidates — pending review candidates, as rows
--
-- ## What this replaces
--
-- `.llmwiki/candidates/<id>.json` and `.llmwiki/candidates/archive/<id>.json`.
-- A candidate is the review workflow's entire durable state: a page proposed but
-- not yet approved, carrying the body to write plus the compile-state snapshot that
-- marks its sources compiled once a human approves.
--
-- ## What the move FIXES, beyond removing a directory
--
-- The store was scoped to a PROJECT. Two hosts reviewing one Stack held two separate
-- queues, so a candidate held on host A was invisible on host B and a reviewer could
-- approve work the other host had superseded. Rows are scoped to the STACK.
--
-- ## What disappears entirely, and why that is not a loss
--
-- `candidate-custody.ts` (483 lines) exists to defend a filesystem store: it binds a
-- directory's `dev`/`ino`, refuses a symlinked leaf, detects parent drift, and fails
-- closed on a cross-device rename. A row has no inode and no parent directory, so
-- every one of those checks holds BY CONSTRUCTION rather than by refusal. The
-- module is not migrated — it becomes unnecessary for this store.
--
-- ## Why the body and the state snapshot are separate columns
--
-- `body` is the page text a reviewer reads and an approval writes verbatim.
-- `source_states` is compile bookkeeping keyed by source, persisted on approval so
-- the sources are not regenerated on the next compile. Merging them would make every
-- review display fetch a state payload it never shows.
-- ============================================================

create table if not exists wiki.review_candidates (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- Stable identifier the review CLI commands use.
    candidate_id text not null,

    -- Where the approved page lands. `concepts` unless an OKF query doc or a typed
    -- profile says otherwise, which is why the typed column sits beside it.
    target_directory text not null default 'concepts'
        check (target_directory in ('concepts', 'queries')),
    target_entity_type text,

    title text not null,
    slug text not null,
    summary text not null default '',

    -- Full page content (frontmatter + body), written verbatim on approval.
    body text not null,

    -- Source filenames that contributed, for display and for the approval's
    -- per-source state replay.
    sources text[] not null default '{}',

    generated_at timestamptz not null,

    -- Every value `ReviewMode` declares: `policy` (held by a rule), `forced`
    -- (--review), `imported` (an OKF bundle stage) and `connector` (a fetched
    -- source). This check listed only the first two at first, which made the row
    -- store unable to hold an imported or connector candidate at all -- the write
    -- failed on the constraint rather than degrading. Kept as a check rather than an
    -- enum type so adding a mode is a statement, not a type migration.
    review_mode text not null
        check (review_mode in ('policy', 'forced', 'imported', 'connector')),

    -- Structured reasons the candidate awaits review. jsonb because the shape is a
    -- discriminated union the reader validates per code.
    held_reasons jsonb not null default '[]'::jsonb,

    -- Trust Guard decision attached at generation, so reviewers see how it routed.
    trust_decision text,

    -- Stale-state guards. A candidate that UPDATES a page carries the target's hash
    -- at propose time; one that expects NO page carries the absent flag. Mutually
    -- exclusive by CHECK, because both at once can never be honestly satisfied.
    expected_target_hash text,
    expect_target_absent boolean not null default false,

    -- Compile bookkeeping persisted on approval: source hash, concepts, compiled-at.
    source_states jsonb,

    -- Digest of the prompt modifiers the candidate was generated under. Compile
    -- skips a source only when the pending candidate covers the SAME selection.
    prompt_modifiers text,

    -- Generation-time lint findings, so `review show` surfaces them before approval.
    schema_violations jsonb,
    provenance_violations jsonb,

    -- Original OKF bundle-relative path, for imported candidates.
    okf_path text,

    -- Conflict parity with the file flags so an impossible precondition cannot be
    -- stored at all, rather than being checked by every reader.
    constraint review_candidates_precondition_exclusive
        check (not (expected_target_hash is not null and expect_target_absent)),

    primary key (stack_id, candidate_id)
);

-- Listing a queue walks one Stack newest-first; that is the review CLI's hot path.
create index if not exists idx_review_candidates_generated
    on wiki.review_candidates (stack_id, generated_at desc);

-- ============================================================
-- Row-level security
-- ============================================================
alter table wiki.review_candidates enable row level security;
alter table wiki.review_candidates force row level security;

drop policy if exists tenant_isolation on wiki.review_candidates;
create policy tenant_isolation on wiki.review_candidates
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

grant select, insert, update, delete on wiki.review_candidates to llmwiki_app;

-- ============================================================
-- Columns the file backend persisted but this table did not
--
-- ## Why these are added with `if not exists` rather than folded into the CREATE
--
-- The CREATE above is `if not exists`, so a database that already has this table
-- skips the whole statement and would never gain a new column. That is exactly the
-- drift this project keeps finding: the developer machine has the table because it
-- was created once, while a fresh environment builds it from this file and gets a
-- different shape. Adding them separately makes the file authoritative for BOTH a
-- new database and an existing one.
--
-- ## What was lost without them
--
-- `compiler/candidates.ts` sets all five on the serialized candidate, and the row
-- store never mentioned them, so wiring the store would have dropped them
-- silently. `citation_manifest` is the one that is not merely informational:
-- `review-publication.ts` compares the candidate body against
-- `citationManifest.bodyDigest` to detect an answer edited after staging. With no
-- column, that integrity check has nothing to compare and every edited answer
-- would pass as unmodified.
-- ============================================================

alter table wiki.review_candidates
    -- Discriminates a reviewed validated answer from every other candidate kind.
    add column if not exists candidate_kind jsonb,
    -- Integrity record for a validated answer: citation list plus the body digest
    -- the publication check re-computes.
    add column if not exists citation_manifest jsonb,
    -- Host-authored provenance for connector-fetched candidates. One of the four
    -- signals `isConnectorCandidate` uses to decide the operator-pin requirement.
    add column if not exists connector_provenance jsonb,
    -- Confidence parsed from the generated page frontmatter, for display.
    add column if not exists confidence double precision,
    -- True when the generated frontmatter declares contradictions; gates the
    -- `contradicted` review mode.
    add column if not exists contradicted boolean;

-- The review_mode check above lives in the CREATE, which is `if not exists` -- so a
-- database that already had this table keeps the OLD two-value constraint and cannot
-- store an imported or connector candidate. Re-stating it here fixes both a fresh
-- database (no-op, the constraint already matches) and an existing one.
alter table wiki.review_candidates
    drop constraint if exists review_candidates_review_mode_check;
alter table wiki.review_candidates
    add constraint review_candidates_review_mode_check
    check (review_mode in ('policy', 'forced', 'imported', 'connector'));

-- A confidence outside 0..1 cannot come from the generator, so a row carrying one
-- means the value was written around the interface. Refusing it at the boundary
-- keeps the display path from having to defend against it.
alter table wiki.review_candidates
    drop constraint if exists review_candidates_confidence_range;
alter table wiki.review_candidates
    add constraint review_candidates_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1));
