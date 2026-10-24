# Feature: Multi-tenant storage — off the local filesystem

## Goal

Make llmwiki stop treating one local directory as its storage medium, so a single
server process can serve **many projects**. Today every command resolves its root
from `process.cwd()` and every artifact is a file under that root.

Status: **PLAN. ANALYSIS COMPLETE. NO IMPLEMENTATION.** Every claim below was read
from the repository in this session, not recalled.

## Decisions (human-selected)

| Decision | Value | Consequence |
| --- | --- | --- |
| Deployment model | **Multi-tenant**, many projects per server | Tenancy is a hard prerequisite, not a later refinement |
| S3/MinIO | **An option, not a constraint** | Backend is chosen per layer on merit, not because infra exists |

## The question this document rejects

"Move the filesystem architecture to a server, maybe a DB or S3/MinIO" is three
decisions wearing one coat. They have different answers:

| Layer | What it stores | Today | Correct backend |
| --- | --- | --- | --- |
| **L1 raw bytes** | `sources/` (pdf, html, md inputs) | filesystem | object store (S3/MinIO) |
| **L2 compiled product** | `wiki/concepts`, `queries`, `<entity>/`, `index.md`, `graph/` | filesystem | database |
| **L3 control state** | `.llmwiki/`: lock, journal, state, embeddings, outbox | filesystem | database |

S3 first because "simpler" makes an object store act as a mutex: worst of both
worlds. L3 needs compare-and-set and transactions. L1 is the only layer where S3
is obviously correct.

## Verified constraints

Measured in this session; commands are reproducible.

| Constraint | Value | Evidence |
| --- | --- | --- |
| Files in `src/` importing `node:fs` | **102** | `grep -rl 'from "node:fs' src/` |
| `root: string` threaded through the API | **1459** | `grep -rn "root: string" src/` |
| `process.cwd()` call sites | **113** | `grep -rn "process.cwd()" src/` |
| Path constants | **25** | `src/utils/constants.ts` |
| KG content-table SQL statements | **123** | scan over `packages/llmwiki-kg/ts/src/**` |
| …of those, **without** a `stack_id` filter | **15** | same scan |

### The port already exists — this is not a greenfield port

- `src/dimensions/types.ts` — `Dimension` port, v2, frozen:
  `prepare` / `commit` / `discard` / `forget`. Its header states the port "names
  no file path, no database, and no provider."
- `src/dimensions/read-types.ts:134` — `DimensionReader.read(query)`.
- `src/dimensions/kg/index.ts:120-151` — `writeGraph()` opens Postgres and runs
  `db.transaction()` over three consolidation calls. **One dimension is already
  server + database, in production.**
- `packages/llmwiki-kg/db/schema.sql` — 8 tables, 17 `stack_id` references,
  `vector`, `pg_trgm`, `pgcrypto`, HNSW index on `vector(768)`.

The migration is therefore "move the **wiki** dimension onto the model the **kg**
dimension already uses", not "filesystem to server".

### Blocker A — listing requires reading everything

`src/pages/list.ts:341-350` (`collectPages`) reads the body of **every** page so
wikilinks can be extracted, after `scanWikiPages`
(`src/compiler/indexgen.ts:83`) already `readdir`-ed and frontmatter-parsed each
file. Local disk: free. S3: one GET per page per listing. Database: one SELECT.

This is why the database is the better L2 target, not merely a neutral swap.

### Blocker B — durability is built on POSIX rename+fsync

- `src/utils/atomic-write.ts` — temp leaf, `link`, `rename`,
  `fsyncDirectoryChain`, `realpath` confinement.
- `src/utils/lock.ts` — PID lockfile, two-lock stale reclamation, create-only
  publication.
- `src/trust/journal.ts` — file WAL whose recovery story is rename+fsync.

None translate to object storage. All have clean database equivalents.

### Blocker C — tenancy does not exist in the wiki, and is convention in the KG

`grep -rn "tenant|projectId|workspaceId" src/` returns only unrelated SDK workflow
fields — nothing that scopes wiki content.

The KG has `stacks(id, name, domain)` as a tenant, but **no row-level security**:

```
grep -in "row level security|create policy|enable rls" packages/llmwiki-kg/db/schema.sql
→ (empty)
```

Isolation is a foreign key plus whatever each query remembers to filter by. The
15 unfiltered statements above are where that convention already leaks:

- `packages/llmwiki-kg/ts/src/routes/documents/get.ts:28` — selects
  `stack_documents where id = $1` and **never calls `resolveStack`**. Fetching a
  document by id crosses stacks entirely. `doc_id` is a UUID, so this is an IDOR
  requiring a known id, not an open dump — still a real tenancy leak.
- `packages/llmwiki-kg/ts/src/core/page/context-read.ts:76` — joins
  `entity_source_documents` to `stack_documents` filtered only by `entity_id`.

### Blocker D — process-wide singletons defeat multi-tenancy

- `packages/llmwiki-kg/ts/src/db.ts:209` —
  `export const client: Sql = createClient(config.DATABASE_URL)`: one pool, one
  URL, chosen at import time. `withRequestTransaction` is bound to that pool
  (`db.ts:313`).
- `src/workflows/stage-output.ts:11` — `const legacyHost = createLocalWorkflowHost()`:
  one host, module-level, shared process-wide.
- `src/viewer/types.ts:272` — `ViewerSnapshot` freezes `root`, counts and all
  readable pages **at startup**. A second tenant would be served the first
  tenant's snapshot.

## Tenancy model decision (step 1 — the actual subject of this plan)

Evidence pushes toward **RLS on a shared schema**, not schema- or DB-per-tenant:

**For RLS:**

1. **The query shape is already tenant-scoped by column.** 108 of 123 statements
   filter by `stack_id`. RLS adds a database-enforced backstop under code that is
   already mostly correct, without a rewrite.
2. **Migrations stay single-track.** `packages/llmwiki-kg/db/schema.sql` is one
   302-line DDL applied once. Schema-per-tenant multiplies migration runs by
   tenant count and needs a migration orchestrator that does not exist.
3. **pgvector indexes are per-table.** HNSW on `vector(768)` would have to be
   rebuilt per tenant schema; under RLS a tenant-filtered query uses the same
   index.
4. **The pool stays singular**, which matters because `db.ts:209` is a
   import-time singleton. One pool + `SET LOCAL app.stack_id` per transaction is a
   small change; per-tenant pools contradicts the current architecture.

**Against RLS, honestly:** it only works if every transaction sets the tenant
GUC, and a missed `SET LOCAL` silently widens scope to *nothing* (with a null
GUC) or requires `FORCE ROW LEVEL SECURITY` to also bind the table owner. It is a
mechanism that fails closed only if configured right — which is exactly why step 1
carries a test that proves cross-tenant reads return zero rows.

**Rejected:** database-per-tenant. It gives the strongest isolation but every
dimension call would need connection routing, and `createClient(config.DATABASE_URL)`
plus the 10s `DB_CONNECT_TIMEOUT_SECONDS` handshake in `writeGraph` make
per-tenant connection setup a per-ingest cost.

## The ordering assumption this breaks

`src/dimensions/coordinator.ts:8-16` commits the wiki first, and says why:

> "The wiki write is the cheap, local, revertible half; the graph write is the
> expensive, remote half... Committing the graph first would leave the only
> recovery path a remote delete, which is exactly the fragile direction."

Moving the wiki to a database **inverts this**. Both dimensions become remote,
compensation stops being "local and reliable", and the two-phase outbox is no
longer sufficient: cross-store rollback becomes a saga with idempotent
compensations. `src/dimensions/reconcile.ts` replays pending records but does not
guarantee it. This must be decided explicitly in Wave 3, before code moves.

## Non-goals

- No rewrite of `root: string` (1459 sites). The port makes that avoidable; doing
  both at once makes the change unreviewable.
- No commitment to S3/MinIO beyond L1.
- No new CLI surface. No HTTP client in the compiler.
- Not changing `DIMENSION_PORT_VERSION` in this plan; a port change is a contract
  change and needs its own proposal.

## Wave 1 — Tenancy foundation (no storage moved)

- [ ] **W1.1** Add `tenant_id` semantics: decide whether `stacks.id` IS the tenant
      or a tenant owns stacks. Write the answer down before writing SQL.
- [ ] **W1.2** Add `SET LOCAL app.stack_id` to `withRequestTransaction`
      (`db.ts:313`) so tenant context is established once per transaction.
- [ ] **W1.3** Enable RLS + `FORCE ROW LEVEL SECURITY` + policies on all 8 tables
      in `packages/llmwiki-kg/db/schema.sql`.
- [ ] **W1.4** Fix the 15 unfiltered statements. Start with
      `routes/documents/get.ts:28` — it must call `resolveStack` and filter.
- [ ] **W1.5** Cross-tenant test: a transaction scoped to stack A reading stack B's
      document, entity, and chunk rows must return **zero rows**. Mutation-verify
      it by removing the RLS policy and watching it go red.

## Wave 2 — L3 control state into the database

- [ ] **W2.1** Replace the PID lockfile (`src/utils/lock.ts`, ~two-lock
      reclamation) with a Postgres advisory lock or `SELECT ... FOR UPDATE` row.
      This is what currently forbids a second process.
- [ ] **W2.2** Replace the file WAL in `src/trust/journal.ts` with a table.
      Keep the pre-state recording contract identical.
- [ ] **W2.3** Move the outbox (`.llmwiki/dimensions/outbox/*.json`) to a table;
      keep `atomicWrite`-equivalent durability semantics via transaction commit.
- [ ] **W2.4** Move `embeddings.json` (currently whole-file, 64 MiB cap at
      `MAX_EMBEDDING_STORE_BYTES`) to a vector table. The cap exists only because
      the whole file is read into memory.

## Wave 3 — L2 compiled product behind the port

- [ ] **W3.1** Decide the coordinator ordering and rollback story now that both
      dimensions are remote. Two-phase outbox is not enough; either accept a saga
      or pick a single-transaction home for both.
- [ ] **W3.2** Implement a `createWikiDimension` backed by the database, keeping
      `saveSource`'s protections (empty-slug guard, collision suffix, identity
      match). Write through the port, not through `collectPages`.
- [ ] **W3.3** Implement `createWikiReader` over SQL so listing is one SELECT
      instead of `readdir` + N body reads.
- [ ] **W3.4** Keep a file-backed implementation selectable behind the same port,
      so local-first stays possible and the server path is not the only one.

## Wave 4 — L1 raw bytes to object storage

- [ ] **W4.1** Introduce a blob abstraction for `sources/` and `dist/exports` only.
- [ ] **W4.2** S3/MinIO adapter, plus a filesystem adapter for local-first.
- [ ] **W4.3** Content addressing: the wiki already hashes sources
      (`sha256` in `.llmwiki/state.json`), so blob keys can be content-addressed
      without new identity machinery.

## Task count

**16 tasks across 4 waves.** Wave 1 is 5 tasks and blocks everything else. Do not
start Wave 4: it is the most visible and the least load-bearing.

## Scope constraint for this role

Contract precedence computed in this session over the seams this work touches:

```
src/utils/constants.ts           SHARED-READ-ONLY
src/pages/list.ts                SHARED-READ-ONLY
src/compiler/indexgen.ts         SHARED-READ-ONLY
src/trust/journal.ts             SHARED-READ-ONLY
src/utils/lock.ts                SHARED-READ-ONLY
src/utils/atomic-write.ts        SHARED-READ-ONLY
src/dimensions/types.ts          SHARED-READ-ONLY
src/dimensions/wiki/index.ts     OWNED
```

Consequence: from `orchestrator-a` this plan and its design are the deliverable.
Implementation needs a contract change, and editing the contract with live peers
unenforces every session at once, because scope is re-read on every tool call.

## Evidence log

- Analysis written: this document, no source touched.
- Verified by direct read: port shape and version, `writeGraph` transaction, all 8
  tables and their extensions, absence of RLS, the 15 unfiltered statements,
  `documents/get.ts` skipping `resolveStack`, the import-time pool singleton, the
  module-level workflow host, the startup-frozen `ViewerSnapshot`, and the
  coordinator's ordering rationale.
- Two delegated explorations returned confident **false** claims (one asserted "no
  Postgres in prod" while `src/dimensions/kg/index.ts:124` reads `DATABASE_URL`;
  another cited a nonexistent `github/trust/journal.ts`). Every load-bearing claim
  in this document was re-verified by the parent. Delegated reports were not
  trusted as evidence.
