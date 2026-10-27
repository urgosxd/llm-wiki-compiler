# Feature: Atomic ingest across `wiki` and `kg`

## Goal

Make one ingest commit both dimensions or neither, replacing today's
recoverable-but-not-atomic saga with a real Postgres transaction.

Four behaviours the human selected in this session, in their words:

1. Both dimensions commit or neither does.
2. Two attempts of the transaction when it fails.
3. If both attempts fail, the source file is cleaned up.
4. Both dimensions share the same source identity (they already receive one
   `DimensionInput`; this document records the asymmetry that remains).

## Status

**IMPLEMENTED.** Design measured against the live database, not recalled.

## Measurements taken before the change (verified this session)

| Fact | Value | How measured |
| --- | --- | --- |
| Postgres reachable | yes, `llmwiki-kg-db-1` on port 5434 | `nc -z localhost 5434` |
| Connection role | `aks`, **SUPERUSER with BYPASSRLS** | `select rolsuper from pg_roles` |
| Tables in `wiki` schema | 21 | `information_schema.tables` |
| `ingest_outbox` exists | 1 | `information_schema.tables` |
| `ingest_outbox_status_check` | `status = ANY ({pending, committed})` | `pg_get_constraintdef` |

The superuser finding matters: RLS is **inert** on this connection, so every
tenancy assertion must also carry an explicit `where stack_id = ...`. That is
already the rule `page-store.ts` documents, and this change preserves it.

## Why atomicity is available now

`test/dimensions/kg-runtime-cross-dimension-transaction.test.ts` already answers
the feasibility question, with a negative control that makes the answer mean
something:

| # | Case | Result |
| --- | --- | --- |
| 1 | Both dimensions write in ONE transaction, then throw | Both rows absent |
| 2 | Two `set_config('app.stack_id', …, true)` in one tx | Tenant GUC not clobbered |
| 3 | Cross-tenant insert as `llmwiki_app` | Refused, SQLSTATE 42501 |
| 4 | **Control:** two separate `createClient` connections | kg survives, wiki rolls back |

Case 4 is what localises the defect: the transaction handle is the only obstacle.
Not the schemas, not the tenant GUC, not Postgres.

The premise in `coordinator.ts` — "the two dimensions cannot share a transaction"
— is true of the code and false of the infrastructure. `wiki.pages`,
`wiki.source_documents`, `stack_documents` and `ingest_outbox` are four tables of
one database, reached through one pooled client.

## The source identity question, answered with the code

Both dimensions receive the same `DimensionInput` (`source`, `title`, `document`,
`body`). They store it under **different identity models**, and that is
deliberate:

| | `wiki.source_documents` | `stack_documents` (kg) |
| --- | --- | --- |
| Unique key | `(stack_id, source_identity)` | `(stack_id, source_hash)` |
| Stores | full markdown | body |
| Source lands in | `source_identity` | `storage_path` |
| Title changes | update in place | — |
| Content changes | update in place | **new row** (new generation) |

`document-consolidation.ts` explains the graph side: a source whose content
changed is a different document, which is what lets `forget` retire *every*
generation by `source`. Sharing the identity is correct; sharing the *row* is not,
and this change does not attempt it.

## Design

### One attempt, one transaction

```
prepare(wiki) → prepare(kg)          once, handles held in memory
                                     (LLM + embeddings live here, outside any tx)

attempt 1 ─ tx ─┬─ bind app.stack_id
                ├─ saveRecord(pending,     tx)
                ├─ wiki.commit(handle, {tx})   rows only
                ├─ kg.commit(handle,   {tx})
                └─ saveRecord(committed,   tx)
                → COMMIT      ── success ──┐
                → ROLLBACK    ── failure ──┤
                                            │
attempt 2 ─ tx ─ same body            ─────┤   retry reuses handles:
                → COMMIT / ROLLBACK         │   zero provider cost
                                            │
both failed → saveRecord(failed) OUTSIDE the tx, error to caller
                                            │
                                            ↓
                              afterCommit() → saveSource() → sources/<slug>.md
```

`prepare` stays outside the transaction. It runs `chunkAndEmbed` and
`extractGraphFromChunks`, which are seconds of provider latency; holding a
Postgres transaction open across them would pin a connection and invite timeouts.

Because the retry reuses the handles, the second attempt costs no tokens. That is
the whole reason the retry sits around the transaction and not around the run.

### Outbox inside the transaction

`saveRecord` writes to the pool today. Inside a single transaction it must join
the transaction, which means a rollback erases the `pending` record too.

That is the intended consequence, not a loss: with atomicity there is no debt to
record. `reconcileOutbox` stops being the retry mechanism and becomes a sweeper
for `pending` rows written by the previous code.

A **failed** record is written *after* the rollback, outside the transaction,
purely as diagnosis. It requires a new `status` value and therefore a SQL
migration — the constraint measured above rejects `'failed'` today.

### The file is a projection, and it owns its own compensation

`sources/<slug>.md` cannot join a Postgres transaction. `saveSource` is a bare
`writeFile`, and `services/ingest/service.ts` refuses an outcome without
`artifactPath`, so the file cannot simply be dropped either.

So the file moves to `afterCommit`: the transaction commits the rows, then the
wiki dimension writes the file. Consequences:

- Two failed attempts ⇒ **the file was never touched**, so "delete the source" is
  a no-op in the case that matters.
- The residual is the projection itself failing. The wiki dimension compensates
  it: it captures the file's pre-state through `saveSource`'s existing
  `beforeWrite` hook, and on failure restores what was there — deleting a file
  this attempt created, restoring previous bytes for one it updated.
- If the projection fails, the rows stay and the failure is reported. Rows are
  the truth: `compile` discovers work from `wiki.source_documents` whenever a
  Stack is configured (`compiler/index.ts`, `sourceChangeDetection`). Destroying
  good content to "undo" a projection failure would be worse than the failure.

### What the ordering buys, beyond atomicity

`kg`'s replay is not idempotent for entity confidence
(`min(1.0, existing + 0.05)` on every consolidation). With no replay there is no
double consolidation, so that defect stops being reachable through ingest.
Relationships were already safe (`greatest(...)` collapses); rows never duplicated.

## Port change: v2 → v3

`src/dimensions/types.ts` is a frozen contract. This is a contract change, agreed
in this session, and both dimensions move in the same commit.

```ts
/** Transaction a commit must join, when the coordinator provides one. */
export interface CommitScope {
  /**
   * Opaque transaction handle. Each implementation narrows it to its own type;
   * it is `unknown` here because the port names no storage.
   */
  readonly tx: unknown;
}

commit(prepared: PreparedWrite, scope?: CommitScope): Promise<CommittedWrite>;
```

`CommittedWrite` gains the post-commit effect:

```ts
/**
 * Work that must run AFTER the transaction commits, when it cannot join it.
 * Returns the artifact path the projection produced, if any.
 */
readonly afterCommit?: (scope: CommitScope) => Promise<AfterCommitEffect | void>;
```

Both additions are **optional**. A dimension that receives no scope behaves
exactly as today: opens its own connection and commits alone. That is what keeps
the port able to describe a future participant that shares no transaction.

`stackId` is deliberately **not** on `CommitScope`. Both dimensions already hold
their Stack from construction (`options.stackId`), and a tenant threaded through
calls is the forgettable-call-site defect `multi-tenant-storage.md` already
rejected: a tenant captured at construction cannot be omitted later.

## Tasks

| # | Task | Files |
| --- | --- | --- |
| 1 | Port v3: `CommitScope`, `commit(prepared, scope?)`, `afterCommit` | `src/dimensions/types.ts` |
| 2 | Outbox joins a transaction; `failed` status + SQL migration | `src/dimensions/outbox.ts`, `packages/llmwiki-kg/db/migration_ingest_outbox_failed.sql`, `packages/llmwiki-kg/db/schema.sql` |
| 3 | `withTenant` + `saveSourceDocument` accept an ambient handle | `src/dimensions/wiki/page-store.ts`, `src/dimensions/wiki/source-documents-store.ts` |
| 4 | Wiki commit joins the tx; `saveSource` moves to `afterCommit` with compensation | `src/dimensions/wiki/store-dimension.ts` |
| 5 | `writeGraph` uses `scope.tx` instead of opening a client | `src/dimensions/kg/index.ts` |
| 6 | Coordinator: one transaction per attempt, two attempts, failure record | `src/dimensions/coordinator.ts` |
| 7 | Reconciler reports `failed` records instead of replaying them | `src/dimensions/reconcile.ts` |
| 8 | Tests: atomicity, retry, compensation, outbox status | `test/dimensions/` |

## Verification policy for this change

Per `AGENTS.md`: `npx tsc --noEmit`, `npm run build`, `npm run test:affected`,
`fallow`. The full suite belongs to CI.

Postgres **is** reachable locally on port 5434, so the atomicity suites run here
rather than skipping. Note the `aks` superuser trap: any new tenancy assertion
needs an explicit `where stack_id = ...`, or it will pass for the wrong reason.

## Not in scope

- **Unifying the two identity models.** Different keys, different semantics,
  documented above. A separate decision.
- **`/api/ingest` compiling after ingest, outside the transaction.** A compile
  failure still leaves the source ingested and the wiki stale; `/api/ingest`
  already reports `compiled` and `compileBusy` separately precisely because of
  this. Wrapping compile in the ingest transaction would hold a transaction open
  across an LLM pipeline, which is the same mistake `prepare` avoids.
- **Retrying `prepare`.** Selected against: it re-embeds and re-extracts, which
  duplicates provider cost to guard a failure that a caller can retry.
