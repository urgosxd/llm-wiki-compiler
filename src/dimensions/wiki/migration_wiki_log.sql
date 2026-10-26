-- ============================================================
-- wiki.activity_log — the append-only journal (log.md), as rows
--
-- ## What this replaces
--
-- `log.md`: one markdown file, blank-line separated entries, each a heading
-- `## [YYYY-MM-DDThh:mm:ssZ] operation | description` optionally followed by
-- `- detail` bullets. Three writers append to it (ingest, query, compile) and two
-- consumers read it (the OKF export, and a human with `grep "^## \[" log.md`).
--
-- ## Why store fields instead of the rendered entry
--
-- The file's value is its RENDERED markdown: the OKF bundle parses headings with
-- `parseLlmwikiLog`, and the gist recipe greps them. Storing the rendered string
-- would make the row a cache of a formatting decision and hide which part is data.
-- Storing `operation`, `description`, `details` and `at` keeps the data, and the
-- reader re-renders through the SAME `formatLogEntry` the file writer uses, so both
-- backends emit byte-identical markdown from the same facts.
--
-- ## Why `seq` rather than `at` alone
--
-- Two entries can share a timestamp to the second (the file renders second
-- precision, so equal headings are already possible). A file gets its order from
-- byte position; a table needs it explicitly. `seq` is per-Stack and gapless,
-- allocated as `max(seq)+1` inside a transaction holding the Stack's advisory lock,
-- so a second appender waits instead of reading the same maximum.
--
-- ## Why `is_export` exists
--
-- The OKF bundle synthesises an "Export" entry when the log is absent or empty
-- (`bundle.ts:113`). That entry is a display fallback, never an operation that
-- happened. Keeping it in the writer and out of the table means a Stack-backed
-- project cannot accumulate fake history rows.
-- ============================================================

create table if not exists wiki.activity_log (
    stack_id uuid not null references stacks(id) on delete cascade,

    -- Per-Stack position. The order the file got from byte position.
    seq bigint not null,

    -- Short operation tag, e.g. ingest / compile / query.
    operation text not null,

    -- Heading detail, already sanitized by the writer (single line, capped).
    description text not null,

    -- Optional `- ` bullet body, in order. Empty array means "no body".
    details text[] not null default '{}'::text[],

    -- The entry timestamp. Rendered to second precision by the reader.
    at timestamptz not null,

    inserted_at timestamptz not null default now(),

    primary key (stack_id, seq)
);

create index if not exists idx_activity_log_at
    on wiki.activity_log (stack_id, at desc, seq desc);

alter table wiki.activity_log enable row level security;
alter table wiki.activity_log force row level security;

drop policy if exists tenant_isolation on wiki.activity_log;
create policy tenant_isolation on wiki.activity_log
    for all
    using (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid)
    with check (stack_id = nullif(current_setting('app.stack_id', true), '')::uuid);

-- The log is APPEND-ONLY, and appending is enforced where it actually can be: the
-- grant. An RLS policy is permissive and additive, so omitting a DELETE policy does
-- NOT deny DELETE -- it only stops OTHER tenants from deleting. Revoking the
-- privilege is what makes "nobody rewrites history" true for this tenant too.
-- Cleanup still happens through the `on delete cascade` from `stacks`, which is
-- ownership ending, not history being edited.
grant select, insert on wiki.activity_log to llmwiki_app;
revoke update, delete on wiki.activity_log from llmwiki_app;
