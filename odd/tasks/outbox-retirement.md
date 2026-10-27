# Feature: Retire the ingest outbox

## Goal

Delete the ingest outbox. Cross-dimension atomicity is already provided by the
single Postgres transaction in `coordinator.ts`; the outbox no longer contributes
a guarantee, and it costs a table, a reconciler, a startup hook, and a full-text
copy of every ingested document.

## Why (measured, not assumed)

Evidence gathered by reading the code and running the suites, before any change.

| Claim | Evidence |
| --- | --- |
| Atomicity comes from the transaction, not the outbox | `coordinator.ts:170` opens one `db.transaction`; `pending` is written **inside** it at `:175`, dimensions join via `scope.tx`, `committed` written at `:184`. A `prepare` failure writes no record at all. |
| Nothing ever becomes `pending` in a v3 run | A crash aborts the transaction, which erases the `pending` row with it. The migration itself admits `pending` is "pre-v3 rows": `packages/llmwiki-kg/db/migration_ingest_outbox_failed.sql`. |
| The reconciliation outcome is discarded | `src/host/server.ts:310` awaits `reconcilePendingIngests(...)` and throws away the returned `ReconcileOutcome`. No log, no CLI command, no endpoint reads `unresolved`/`failed`/`unreadable`. |
| The outbox leaks full document text | `document` and `body` are stored per ingest (`outbox.ts:197`). The only sweeper of `committed` rows is `reconcileOutbox`, invoked only from `startHost`. A CLI-only project never sweeps. |
| A `failed` record can overwrite a committed one | `recordFailure` (`coordinator.ts:241`) uses `saveRecord`, which is `on conflict (ingest_id) do update` (`outbox.ts:201`). On an ambiguous commit, a row that landed is relabelled `failed` and never replayed. |
| Replay repays the provider | `finishRecord` calls `dimension.prepare(input)` again (`reconcile.ts:83`), which is where embeddings and extraction live. |

## Decisions (user-selected)

| Decision | Choice |
| --- | --- |
| Outbox fate | Delete it entirely |
| Failure diagnostics | Structured log to stderr in the coordinator's catch — no table |

## Non-goals

- The source-projection hole (`afterCommit` failing after COMMIT) is a separate
  feature, `odd/tasks/source-projection-before-commit.md`. It touches the port
  contract and deserves its own review.
- No change to the retry policy (`MAX_TX_ATTEMPTS = 2`) or to the dimension port.

## What must stay true after this feature

These are the invariants the deletion must not weaken:

1. One transaction per attempt, retried twice, reusing prepared handles.
2. Both dimensions commit together or neither does.
3. A `prepare` failure writes nothing and leaves no artifact.
4. A failed transaction leaves no `pending` debt — now trivially, because there
   is no debt table at all.

## Tasks

| # | Task | Surfaces |
| --- | --- | --- |
| T1 | Coordinator stops writing the outbox; logs a structured failure line to stderr instead. Drop `IngestOutcome.record` (no production reader) and the `mintIngestId` dependency. | `src/dimensions/coordinator.ts` |
| T2 | Delete `outbox.ts` and `reconcile.ts`; remove their exports and types from the dimension barrel. | `src/dimensions/outbox.ts`, `src/dimensions/reconcile.ts`, `src/dimensions/index.ts` |
| T3 | Delete the host startup reconciliation and its now-dead imports; document that startup no longer touches ingest state. | `src/host/server.ts` |
| T4 | Ship a migration that drops `ingest_outbox`; retire the two obsolete creation migrations so a fresh install never creates it. | `packages/llmwiki-kg/db/` |
| T5 | Delete the two obsolete suites and the harness; repair imports in the three surviving suites that still import outbox helpers. | `test/dimensions/`, `test/host/` |

## Verification

- `npx tsc --noEmit`
- `npm run build`
- `npm run test:affected`
- `fallow`
- Targeted: `test/dimensions/ingest-atomicity.test.ts`,
  `test/dimensions/coordinator.test.ts`,
  `test/dimensions/cross-dimension-rollback.test.ts`

## Open risk

Dropping the table is destructive for a live database that carries pre-v3
`pending` rows. The migration must be explicit about that, and the feature must
not run against a database until the operator has had the chance to read those
rows. Recorded here so it is not discovered at deploy time.

## Found while implementing (T4) — two breakages outside the task's surfaces

Measured against the dev container (`llmwiki-kg-db-1`, port 5434) before any change
was applied to it:

| status | rows |
| --- | --- |
| `pending` | 513 |
| `failed` | 148 |
| `committed` | 13 |

All 674 rows have a live `stack_id`; `created_at` spans 2026-10-25 to 2026-10-27.
So this database is exactly the case the open risk describes, and the drop must not
run against it before those 513 `pending` rows are read.

1. **`scripts/apply-schemas.sh` now hard-fails.** It lists
   `packages/llmwiki-kg/db/migration_ingest_outbox.sql` in `SCHEMA_FILES` and
   `public.ingest_outbox` in `REQUIRED_TENANT_TABLES`, and the runner exits 1 when a
   listed file is missing (`apply-schemas.sh:152`). T4 deletes that file, so the
   schema runner — and therefore CI (`ci.yml:84`) — breaks until the two entries go.
   The file is not in this task's edit surfaces.
2. **Stale references to the table survive elsewhere.** `src/dimensions/types.ts`
   (the port's own doc, and deliberately out of scope here), plus comments in
   `src/dimensions/wiki/schema.sql`, `src/dimensions/wiki/migration_page_embeddings.sql`
   and `src/utils/embeddings-database.ts` cite `ingest_outbox` as an RLS exemplar.
   Comments only — no behaviour depends on them.

Both need a decision: either these paths are added to this feature, or a follow-up
owns them. The `apply-schemas.sh` one cannot be deferred past the commit that
deletes the migration.
