# Proposal: atomic ingest across both dimensions

**Status:** `changes` received (`cd-2026-10-26-01`) with no reason carried; revised
here against `feat/pages-rows-only` and re-proposed as `@4`.
**Author:** `orchestrator-b` (kg-dimension).
**Evidence:** `test/dimensions/kg-runtime-cross-dimension-transaction.test.ts`, 4 tests, all green
against a real Postgres. Branch `feat/orchestrator-b`.

## Revision note: this was first written against a stale tree

The original proposal was measured on `feat/orchestrator-b` (`47f015f`) and assumed
the outbox was a FILE (`src/dimensions/outbox.ts`, `.llmwiki/dimensions/outbox/*.json`).
On `feat/pages-rows-only` it is a TABLE — `public.ingest_outbox`, 276 rows live,
written through `saveRecord(db, stackId, record)`.

That does not weaken the case; it STRENGTHENS it, and moves the argument one step.
Measured on the live container: `public.ingest_outbox`, `public.stack_documents` and
`wiki.pages` are three tables **of one database**. The outbox, the wiki dimension and
the kg dimension are therefore — today, already — in the same transaction space.
The comment at the top of `outbox.ts` on that branch still opens with "the two
dimensions cannot share a transaction", which the shipped storage layout has
outgrown.

What remains true and is NOT proposed to change: **`prepare` stays outside any
transaction** (it makes LLM and embedding calls), so the split the port already has
is still the right one.

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
  /** Stack both dimensions are bound to; REQUIRED when `tx` is absent. */
  readonly stackId?: string;
}

commit(prepared: PreparedWrite, scope?: CommitScope): Promise<CommittedWrite>;
```

`stackId` is included because the branch revision made the tenant explicit on every
call path (`saveRecord(db, stackId, ...)`, `saveSourceDocument(db, stackId, ...)`).
A transaction handed to a dimension is not self-describing about its tenant, and a
`commit` that joined a tx without binding the GUC would fail the policy check rather
than the transaction — the exact failure mode the measurement in case 2 rules out.

Why `unknown` and not a Drizzle type: the port's whole value is naming no storage,
no file path, and no provider (`types.ts` says so). A concrete `Database` type
would leak `drizzle-orm` into a contract both dimensions share, and would make the
port unusable by any future dimension that is not Postgres. Each implementation
narrows `scope.tx` to its own handle and fails closed on a shape it cannot use.

### Per-side work

| Side | Change | Owner | Size |
| --- | --- | --- | --- |
| Port | `commit` gains an optional `scope`; `DIMENSION_PORT_VERSION` → **4** | `orchestrator-main` (`types.ts` is shared) | one optional field |
| `kg` | `writeGraph` uses `scope.tx` instead of `createClient` | `orchestrator-b` (owns `src/dimensions/kg/**`) | small: one function |
| `wiki` | thread the handle through `saveSourceDocument` AND `withTenant`; move `saveSource` out of the write path | `orchestrator-main` (owns `src/dimensions/wiki/**` on that branch) | **NOT small** — see Gap 1 |
| Coordinator | open ONE transaction, bind the Stack, pass it to every `commit` | `orchestrator-main` (`coordinator.ts`) | medium |

Version is **4**, not 3: the `changes` reply invalidated the `@3` proposal before it
was agreed, and `DIMENSION_PORT_VERSION` is already `2` on both branches. A fresh
number keeps every decision traceable to one shape instead of silently redefining
`@3`.

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

A `contract_decision` on `src/dimensions/types.ts@4`, carrying the optional
`commit(prepared, scope?)` shape above.

I am not asking to rewrite the coordinator, and I am not asking for a branch merge.
Approve the interface (or send `changes`) and I will implement only the `kg` side.

## Answering the two gaps `wq-2026-10-26-01` named

Both were correct, and both change the proposal. Evidence:
`test/dimensions/kg-runtime-savepoint-binding.test.ts`, 4 tests green.

### Gap 1 — `wiki` commit is NOT one upsert. Confirmed, and it is a real cost.

Measured on `feat/pages-rows-only`, `store-dimension.ts` calls three things:

| Step | What it opens |
| --- | --- |
| `saveSource(root, …)` | a FILE write, no transaction |
| `saveSourceDocument(db, stackId, …)` | **its own** `db.transaction` (`source-documents-store.ts:193`) |
| `withTenant(db, stackId, …)` | **another** `db.transaction` (`page-store.ts:154`) |

So the wiki commit is not "one upsert that needs to join a tx". It is two
independent transactions plus a file write. Measured on the wire, the difference
is concrete: today's shape takes **2 distinct `txid`s**; one spanning transaction
with two savepoints takes **1**.

This is a scope increase for whoever owns that file, and the proposal never said
otherwise. The work is not "pass a handle" but "thread one handle through three
call sites, two of which currently open their own". The `wiki` side is therefore
**not** a one-line change, and I am not asking anyone to believe it is.

### Gap 2 — `SET LOCAL` under savepoints. Measured, and it favours the design.

Four cases, all green, all under `set local role llmwiki_app` so RLS actually bites:

| Case | Question | Result |
| --- | --- | --- |
| S1 | Does a savepoint INHERIT the outer `app.stack_id`? | **Yes** — inner sees the outer's Stack |
| S2 | Does a savepoint that rebinds and rolls back steal it? | **No** — outer binding intact, outer can still write |
| S3 | Can a savepoint write for the outer's Stack? | **Yes** — the operation a joining dimension needs |
| S4 | Is a FOREIGN write still refused inside a savepoint? | **Yes** — SQLSTATE 42501 |

S4 is the negative control: if inheritance had worked by weakening the policy,
the design would be trading isolation for atomicity. It does not.

**One correction worth recording, because it nearly produced a false answer.** A
first measurement nested `db.transaction` inside `db.transaction` and concluded
savepoints do NOT inherit. That was wrong: drizzle's pool gives the inner call a
DIFFERENT connection, so it is not a savepoint at all. A savepoint requires
`tx.transaction` on the outer handle. The suite pins this distinction in S1 so the
wrong shape cannot quietly return.

**And one constraint the measurement imposed on the design:** a savepoint
inherits an existing binding but does not create one. So the coordinator MUST bind
the Stack on the transaction it opens, before handing it to any dimension. A
dimension that assumed its own `commit` would bind the GUC would fail 42501 inside
the shared transaction, and the failure would look like a permissions bug rather
than an ordering one. That is why `CommitScope` carries `stackId` alongside `tx`.

## What `changes` must carry to be actionable

The `contract_decision` envelope has no `reason` field by design (v2 forbids it on
that type), so a bare `changes` states that the shape is wrong without stating how.
I will not guess at a contract shape: guessing is exactly what the port's frozen
contract rule exists to prevent.

Three questions decide the revision, and any one of them is enough to answer:

1. **Is the objection that `scope` is on the wrong METHOD?** The alternative is a
transaction-owning coordinator that dimensions never see, with `commit` gaining
nothing — cheaper for the port, but it cannot work for `kg`, which opens its own
client inside `writeGraph` and would have to be handed a handle somehow.
2. **Is the objection that `tx?: unknown` is too loose?** The alternative is a
narrower structural interface (an object with a single `execute`) that both
implementations satisfy without naming a driver.
3. **Is the objection that this should be `orchestrator-main`'s implementation
rather than mine?** Then the interface stands and the question is only who writes
the coordinator; I will still take the `kg` side.

## Measured facts the revision rests on

All verified this session against the live container and `feat/pages-rows-only`:

- `public.ingest_outbox`, `public.stack_documents`, `wiki.pages` — three tables,
  **one database**.
- `ingest_outbox` is already populated (276 rows) and RLS-forced.
- `writeGraph` (`src/dimensions/kg/index.ts:212`) still calls `createClient`, which
  is the single line that makes atomicity impossible.
- `saveSourceDocument` (`src/dimensions/wiki/source-documents-store.ts:193`) opens
  its own `db.transaction`, so it has the same shape as `writeGraph`.
- **`types.ts` is byte-identical between `feat/orchestrator-b` and
  `feat/pages-rows-only`**, so the contract proposal is not stale — only my
  surrounding description of the outbox was.

## Also requested, unrelated to the version bump: the harness RLS trap

`test/fixtures/kg-postgres.ts` is `shared-read-only` for this role. It connects as
`aks`, which this session measured to be **SUPERUSER with BYPASSRLS**. Row-level
security is therefore **inert** for every suite built on that fixture, so any
isolation conclusion drawn through it without an explicit `set local role` is
unfounded. The danger is specific: the unsafe path does not fail, it *passes*, and
reads as proof of the tenancy guarantee.

### What I did inside my own scope

Because the hook refuses the fixture edit, I built the safe path in the surface I
do own rather than working around the contract:

- `test/dimensions/kg-runtime-app-role.ts` — `asAppRole()`, which drops to
  `llmwiki_app` inside a transaction, plus `connectionBypassesRls()`, which probes
  `rolbypassrls or rolsuper` on the live connection.
- `test/dimensions/kg-runtime-rls-trap.test.ts` — pins the trap as measured fact:
  the fixture's connection **does** bypass RLS, a cross-tenant write **is accepted**
  there (the trap, stated as behaviour), and the same write **is refused** with
  SQLSTATE 42501 under the helper.

Both suites pass (7 tests). The guard is falsifiable: if the fixture is later
connected as the app role, the first two cases fail and point at the cause.

### What is still needed from the integration role

Add an equivalent helper to `test/fixtures/kg-postgres.ts` and expose it on
`KgPostgresHarness`, so the safe path is the DEFAULT rather than something each
suite must remember. My module is a correct workaround, not the right home: a
shared fixture should not depend on one feature role's test directory.
