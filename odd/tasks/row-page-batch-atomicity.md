> **STATUS (2026-11-05): IMPLEMENTED — this document is a historical record.**
>
> A row-backed page batch now commits as ONE transaction, not one per page.
>
> - The batch carries its transaction in an ambient scope:
>   `src/dimensions/wiki/page-batch-transaction.ts` (`withPageBatchTransaction`,
>   `activePageBatchTransaction`).
> - `applyBatch` (`src/trust/executor.ts:176-194`) wraps its per-mutation loop in
>   that scope when the caller supplies one, and the row sink joins it:
>   `src/dimensions/wiki/page-write-sink.ts:60-66` passes
>   `activePageBatchTransaction()` as `callerTx` to `upsertStoredPage`, which is
>   the parameter that makes the batch atomic
>   (`src/dimensions/wiki/page-store.ts:337-386`).
> - A store therefore opens its own `db.transaction` only when no batch scope is
>   active — `src/dimensions/wiki/page-store.ts:172-179`.
> - The regression test that proves it is
>   `test/dimensions/row-page-batch-atomicity.test.ts`.
>
> **Everything below this banner is preserved verbatim as the record of the problem
> as it stood when this document was written. Do not read it as current state.** The
> "defect, measured in source" citations below point at line numbers that have since
> moved; the code above is the authority.
>

# row-page-batch-atomicity — a row batch is N transactions, not one

## Goal

Make one approved page batch land as ONE database transaction on a Stack-backed
project, the way the file backend lands it as one journal batch. Today it lands as
one transaction PER PAGE, so a failure halfway through leaves half the batch
durable — the exact failure the journal exists to prevent on the file backend.

This is Stage 3 of `lint-row-awareness.md`, re-scoped. That document recorded
Stage 3 as "a product decision (does `journal-health` apply to a row corpus at
all?)" on the premise that *a row is already inside a transaction and needs no
pre-state snapshot*. The premise is true for a SINGLE page and false for a BATCH.
The decision it was waiting for was answerable, and the answer is "the rule is
not vacuous, it is reporting something real about the file backend that the row
backend silently lacks".

## The defect, measured in source

The claim this corrects lives in two places, and both are wrong for a batch:

- `test/dimensions/journal-skipped-on-rows.test.ts:10` — *"the database already
  gives all-or-nothing for free through its transaction — so
  `applyPageMutationLocked` deliberately SKIPS the journal when a `pageSink` is
  present. That reasoning is written down in `executor.ts` and is correct."*
- `src/trust/executor.ts:88-91` — *"a row has no such pre-state to capture …
  the transaction already gives all-or-nothing"*.

The dispatch that falsifies both:

```
applyApprovedMutationsLocked            executor.ts:206
  └─ applyBatch                          executor.ts:151   ← a FOR loop, not a transaction
       └─ applyPageMutationLocked        page-apply.ts:334
            └─ storeRowLocked            page-apply.ts:392
                 └─ pageSink(...)        PageSink, a bare function
                      └─ createPageWriteSink   page-write-sink.ts:59
                           └─ upsertStoredPage page-store.ts:348
                                └─ withTenant(db, stackId, work)   ← no callerTx
                                     └─ db.transaction(...)      page-store.ts:176
```

Every level is correct in isolation. `applyBatch` iterates because the file
backend needs one `recordPreState` + write per target inside a single open batch,
and the row backend inherited the identical loop while dropping the batch. So:

| Backend | N pages, failure on page 3 | What survives |
| --- | --- | --- |
| Files | journal batch stays `pending`; `replayJournal` restores all pre-states | nothing |
| Rows | pages 1-2 committed by their own transactions | **pages 1-2** |

`needsJournal` (`executor.ts:175`) returns `false` whenever a `pageSink` is
present, so no journal file exists either. There is no recovery record, because
the design assumed there was nothing to recover.

The same shape exists on the delete path: `deleteRows`
(`src/wiki/delete-page.ts:160`) loops `pageRemover`, and each
`deleteStoredPage` (`page-store.ts:388`) opens its own transaction through the
same `withTenant` call.

## Why this was not caught

Not a gap in care — a gap in what the tests could see. The only row-backend
`pageSink` test (`test/dimensions/journal-skipped-on-rows.test.ts`) uses a
`recordingSink()` that pushes to an array, so no transaction is involved at all
and the assertion "no journal directory" is true for a reason unrelated to
atomicity. `test/dimensions/page-delete-rows.test.ts` does use the real Postgres
harness, but deletes ONE page, so one transaction and one page are
indistinguishable.

A test that proves atomicity must fail a write in the MIDDLE of a batch and then
observe whether the earlier pages survived. Nothing in the suite does that.

## Design

### The executor gains a transaction capability, not a database

`PageSink` is a bare function and is structural *on purpose* — the file header of
`page-apply.ts` records that the trust path must stay usable with no database and
no Stack. The executor must not learn to import `llmwiki-kg`. So the new option
is a capability, in the same spirit:

```ts
/** Run a set of page mutations as ONE all-or-nothing unit. */
export type PageBatchTransaction = <T>(fn: () => Promise<T>) => Promise<T>;
```

Supplied beside `pageSink` in `ApplyOptions`, exactly as `pageRemover` already
travels beside it (and for the same documented reason: a writer without its
companion is a shape worth making hard to express). `applyBatch` wraps its loop
in it when present; when absent the loop is unchanged, which is every current
file-backend caller.

### The scope, not the argument, carries the transaction

`upsertStoredPage` and `deleteStoredPage` take an optional `callerTx`, forwarded
to the `withTenant` parameter that already exists for the atomic-ingest
coordinator (`page-store.ts:163`). That parameter's docstring already explains
why a nested `db.transaction` is wrong — a pool hands the inner call a DIFFERENT
connection, so it commits separately and "a later failure leaves half the ingest
visible". That sentence describes this defect precisely; it was written for
ingest and never applied to the page batch.

An `AsyncLocalStorage` scope carries the open transaction to the sink, the same
mechanism `linter/corpus.ts` uses for the page corpus and `utils/output.ts` for
quiet mode: one resolution per run, nested scopes cannot leak, and a concurrent
run cannot corrupt another. The sink joins the scope's transaction when one is
open and keeps its current behaviour when none is.

Chosen over threading a `tx` parameter through `PageSink`: the sink is a bare
function at five call sites, and widening it to carry a handle would churn all
five for a fact none of them decides.

### `journal-health` is not vacuous — it is the wrong question, now with an answer

With the batch atomic, the row backend does not need a revert journal: the
database supplies what the journal supplies. So `checkJournalHealth` on a row
corpus correctly reports nothing — and that silence now has a PROOF behind it
instead of an assumption. Stage 3 closes as: *the rule reads disk, a row project
has no journal directory, and none can exist because the thing a journal guards
cannot happen — asserted by a test that fails a mid-batch write.*

`RULES_UNAVAILABLE_ON_ROWS` gains nothing: `journal-health` is not unavailable,
it is answered by "absent", which is what the rule reports for a healthy project.
What the parity suite gains is one assertion that a row corpus produces no
`journal-health` finding AND that the atomicity test that earns the silence is
green.

### Explicitly not in scope

- **`review-approve.ts:346`** calls `applyApprovedMutationsLocked(root, planned)`
  with NO `pageSink`, so on a Stack it would write files. Separate defect, separate
  fix; named here so it does not look like an oversight.
- **`checkJournalHealth` reading rows.** The answer is "not applicable", not
  "read `wiki.activity_log`" — those are different data (see the retraction
  already recorded in `lint-row-awareness.md`).
- **Cross-store atomicity** (page rows + audit event + index refresh). The
  executor's own header already declares that boundary as a Phase-5 concern.

## Tasks

| # | Task | Checks |
|---|------|--------|
| 1 | Failing test: a 3-page row batch whose 2nd write throws leaves ZERO pages | `npx vitest run test/dimensions/row-page-batch-atomicity.test.ts` red |
| 2 | Failing test: a 2-page row DELETE batch whose 2nd removal throws leaves BOTH rows | same file, red |
| 3 | Failing test: no `journal-health` finding on a row corpus, paired with task 1's proof | `test/lint-corpus-parity.test.ts` red |
| 4 | `upsertStoredPage` / `deleteStoredPage` accept `callerTx` | focused suite green |
| 5 | `PageBatchTransaction` type + `ApplyOptions` field; `applyBatch` wraps its loop | `tsc --noEmit` |
| 6 | Transaction scope in `page-write-sink.ts`; sinks join it | focused suite green |
| 7 | Wire compiler + `sources/removal.ts` to supply the capability | focused suite green |
| 8 | Correct the two false "for free" claims in source and test headers | review read |
| 9 | Rewrite Stage 3 in `lint-row-awareness.md` with this finding | review read |
| 10 | Package checks | `npx tsc --noEmit`, `npm run build`, `npm run test:affected`, `fallow` |

## Acceptance

1. A row batch of N pages is all-or-nothing: a failure at any position leaves no
   page from that batch, verified against the real Postgres harness on 5434.
2. A row delete batch is all-or-nothing in the same way.
3. The tests are non-vacuous: neutralising the transaction wrapper must make them
   fail. A test that passes for the wrong reason certifies the bug.
4. The file backend is byte-identical: with no `pageSink`, behaviour and the
   frozen parity suites are unchanged.
5. A row corpus produces no `journal-health` finding.
6. `npx tsc --noEmit` clean, `npm run build` green, `npm run test:affected` green,
   `fallow` reports no new dead code, duplication or complexity breach.

## Risks

- **The trust path must stay database-free.** The new option is a structural
  function type, not a `Database`. A future caller that reaches for the handle
  here would break the property the file header defends.
- **Nested transactions are the known trap.** `withTenant` documents that a nested
  `db.transaction` silently gets a different connection. Reusing `callerTx` is the
  only correct path, and the atomicity test fails loudly if the scope is bypassed.
- **A batch that spans stores** (page rows plus an artifact or a relation) is out
  of scope and stays refused by the existing shape guard.
- **Blast radius**: `executor.ts` and `page-apply.ts` are imported by the compile,
  review, promote, relation, lifecycle and removal paths. Tasks 1-3 are written
  FIRST so any behaviour change surfaces as a red test rather than as a silent
  regression in a distant surface.

## Evidence

Recorded per task below as work-unit commits.
