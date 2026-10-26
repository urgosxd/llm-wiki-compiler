# Proposal: atomic ingest across both dimensions

**Status:** proposal, awaiting a `contract_decision` from `orchestrator-main`.
**Author:** `orchestrator-b` (kg-dimension).
**Evidence:** `test/dimensions/kg-runtime-cross-dimension-transaction.test.ts`, 4 tests, all green
against a real Postgres. Branch `feat/orchestrator-b`.

## The premise this proposal challenges

`src/dimensions/types.ts` states the current contract:

> There is no shared transaction to fall back on -- `wiki` writes rows through its
> own tenant-bound transaction and `kg` opens its own connection and commits
> separately -- so a single transaction spanning both is not available without
> rebuilding both dimensions around a handle neither currently accepts.

and

> The guarantee this port offers is RECOVERABILITY, not atomicity [...]
> Choosing atomicity over this would mean coupling both dimensions to one
> transaction, which buys that window away at the cost of the independence the
> port exists to provide.

Both sentences are correct **about the code as written**. The first is no longer
correct about the code's *capabilities*, and that is what this proposal measures.

The claim was written when `wiki` was a local directory and `kg` was a remote
database — genuinely two systems. It is not that anymore:
`src/dimensions/wiki/schema.sql` puts compiled pages in a `wiki` schema **beside**
the graph tables in `public`, in the same database, reached through the same
pooled client.

## What was measured, not argued

`test/dimensions/kg-runtime-cross-dimension-transaction.test.ts` answers the
feasibility question directly. All four cases pass.

| # | Case | Result |
| --- | --- | --- |
| 1 | Both dimensions write in ONE transaction, then throw | **Both rows absent.** Atomicity holds. |
| 2 | Two sequential `set_config('app.stack_id', id, true)` (wiki, then kg) in one tx | Both rows readable inside the tx AND both survive COMMIT. The tenant GUC is not clobbered. |
| 3 | Cross-tenant insert under `set local role llmwiki_app` | Refused with SQLSTATE **42501** (`insufficient_privilege`). RLS genuinely bites. |
| 4 | **Negative control:** two SEPARATE `createClient` connections (today's shape) | kg row **survives** while wiki rolls back. |

Case 4 is the one that makes the rest meaningful. A passing "both roll back" test
proves nothing alone — it could pass because the two writes never really shared a
transaction in a way that matters. Case 4 reproduces the product's current
topology and shows the divergence. Together the two localize the defect precisely:
**the transaction handle is the only thing standing between the current saga and
real atomicity.** Not the schemas, not the tenant GUC, not Postgres.

## The minimal change

One field on one method.

```ts
/** Ambient transaction a dimension must join, when the coordinator provides one. */
export interface CommitScope {
  /**
   * Transaction the commit must run inside, or `undefined` for a standalone
   * commit. A dimension that receives one MUST NOT open its own connection.
   */
  readonly tx?: unknown;
}

commit(prepared: PreparedWrite, scope?: CommitScope): Promise<CommittedWrite>;
```

Why `unknown` and not a Drizzle type: the port's whole value is naming no storage,
no file path, and no provider (`types.ts` says so). A concrete `Database` type
would leak `drizzle-orm` into a contract both dimensions share, and would make the
port unusable by any future dimension that is not Postgres. Each implementation
narrows `scope.tx` to its own handle and fails closed on a shape it cannot use.

### Per-side work

| Side | Change | Owner |
| --- | --- | --- |
| Port | `commit` gains an optional `scope`; `DIMENSION_PORT_VERSION` → **3** | `orchestrator-main` (`types.ts` is shared) |
| `kg` | `writeGraph` stops calling `createClient` when `scope.tx` is present | `orchestrator-b` (owns `src/dimensions/kg/**`) |
| `wiki` | `commit` runs its upsert on `scope.tx` when present | `orchestrator-a` (owns `src/dimensions/wiki/**`) |
| Coordinator | opens ONE transaction, passes it to every `commit`, commits at the end | `orchestrator-main` (owns `coordinator.ts`) |

### What does NOT change

- **`prepare` stays outside the transaction.** It runs `chunkAndEmbed` and
  `extractGraphFromChunks` — LLM calls measured in seconds. Holding a Postgres
  transaction open across them would pin connections and invite timeouts. The
  existing `prepare`/`commit` split is already correct; only `commit` joins.
- **`commit` must stay idempotent.** The outbox does not disappear for the file
  projection below, and idempotency is what makes any retry safe.
- **The wiki-first ordering stops mattering.** It exists today precisely because a
  disk write is unrevertible. Inside one transaction, order is free.

## What this does NOT buy: the honest residual

One write is not in Postgres.

`src/dimensions/wiki/store-dimension.ts` calls `saveSource`, which writes
`sources/<slug>.md` with a bare `writeFile` (`src/utils/source-writer.ts:201,220`)
— no journal, no lock, outside any transaction.

So a transaction makes **all four row writes** atomic, and leaves the file as a
**projection**: written after the commit, re-runnable, and self-correcting. If it
fails, the next `compile` re-detects the source because `state.json` flushes only
once, at the end of `finalizeWiki` (`src/compiler/index.ts:788`).

That is a strictly better failure mode than today's, but it is not
all-or-nothing, and this proposal does not claim it is.

## The trade-off `types.ts` names, answered

The port's independence argument is real: a contract that requires a shared
transaction cannot describe a dimension that is a remote API or a plain file.

My answer is that the **optional** shape preserves it. A dimension that receives no
`scope.tx` behaves exactly as today — opens its own connection, commits alone, and
is still covered by the outbox. A dimension that receives one joins it. The port
gains a capability without losing a participant, and the saga remains the fallback
rather than being deleted.

That is why I am proposing an optional field rather than the "rebuild both
dimensions around a handle" that `types.ts` correctly calls the expensive option.

## Two defects found while measuring, independent of this proposal

Both are real today and neither requires a port change.

1. **`kg` commit replay is not idempotent for entity confidence.**
   `document-consolidation.ts:31,132` does `min(1.0, existing + 0.05)` while
   `EXTRACTED_CONFIDENCE` is always `0.7`. Every reconcile replay raises entity
   confidence: 0.7 → 0.75 → 0.8. Relationships are safe (`greatest(...)` collapses),
   rows do not duplicate. But `confidence` is exactly the column the schema
   documents as "increases as more sources corroborate", so the graph overstates
   corroboration after retries. Owned by `orchestrator-b`.

2. **`forget` is partial retirement.** Deleting `stack_documents` cascades to
   `document_chunks` and `entity_source_documents`, but `ontology_entities` and
   `ontology_relationships` reference only `stacks` — so they survive as orphans,
   still carrying confidence. Owned by `orchestrator-b`.

## What I am asking for

A `contract_decision` on `src/dimensions/types.ts@3`, carrying the optional
`commit(prepared, scope?)` shape above.

I am not asking to rewrite the coordinator, and I am not asking for a branch merge.
Approve the interface (or send `changes`) and I will implement only the `kg` side.

## Also requested, unrelated to the version bump

`test/fixtures/kg-postgres.ts` is in `sharedPaths`, so I cannot edit it. It
connects as `aks`, which this session measured to be **SUPERUSER with BYPASSRLS**.
That makes row-level security **inert** for every suite built on the fixture, so
any RLS conclusion drawn through it without an explicit
`set local role llmwiki_app` is unfounded. My suite works around it locally; the
fixture should not require a workaround. Proposal: add a documented
`asAppRole()` helper to the fixture so the safe path is the default one.
