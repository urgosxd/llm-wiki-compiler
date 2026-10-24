# Feature: Stack-scoped storage — off the local filesystem

## Vocabulary: the product says "Stack", the design says "tenant"

Human decision, 2026-10-24: the isolation unit is **called a Stack**. That is not a
rename of anything in the implementation, because the code never used "tenant" as
an identifier in the first place — the table is `public.stacks`, the code threads
`stackId`, the env var is `AKS_STACK_ID`, and `grep -rn "tenant_id" src/` returns
nothing. The only outlier was this document's prose.

So both words stay, and this is the rule that keeps them from drifting:

- **Stack** names the THING: the row in `stacks`, the value of `stackId`, what a
  user picks. It is the product-facing word, and docs and UI should use it.
- **tenant** names the RELATIONSHIP: the role a Stack plays as an isolation
  boundary in a shared-database design (RLS, the `app.stack_id` GUC, "cross-tenant
  read"). It is a design word, not a second entity.

Read this as "a Stack is the tenant", never as "a tenant owns Stacks" — W1.1 below
settles that direction, and it is the reason a blind search-and-replace across this
file would produce nonsense sentences like "a stack is the Stack".

Any document in `odd/tasks/` that predates this decision and still titles the work
"multi-tenant" means the same thing this file means; the name changed, the work
did not.

## Goal

Make llmwiki stop treating one local directory as its storage medium, so a single
server process can serve **many projects**. Today every command resolves its root
from `process.cwd()` and every artifact is a file under that root.

Status: **WAVE 1 LANDED AND MEASURED; WAVE 3 CODE LANDED (W3.2, W3.3); W3.4
SUPERSEDED; WAVES 2 AND 4 NOT STARTED.** The plan is no longer analysis-only: Wave 1
shipped as `4b08af5` and the live database carries its policies. See
`## Wave 1 — measured state` for what is really done, what the commit overstated,
and the one deployment step that still makes RLS inert. See
`## Wave 3 — reconciled state` for what the database-backed wiki actually delivers,
the one plan claim it refutes, and the wiring that is still not done.

**Direction change, human-ratified on both orchestrator sessions:** Postgres becomes
the only storage backend, so the file-backed wiki dimension is removed rather than
kept selectable. W3.4 is therefore SUPERSEDED, and the roadmap that replaces this
document's Wave 3–4 ordering lives in `odd/tasks/multi-tenant-stack-only.md`. This
file remains the record of WHAT was measured about Wave 1 and Wave 3; it is no
longer the current plan for where storage goes next.

The analysis below was read from the repository, not recalled. Where the shipped
work contradicts the plan text, the measurement wins and the deviation is recorded
rather than quietly rewritten.

## Decisions (human-selected)

| Decision | Value | Consequence |
| --- | --- | --- |
| Deployment model | **Many Stacks per server**, one shared database | Stack isolation is a hard prerequisite, not a later refinement |
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

- [x] **W1.1** Add `tenant_id` semantics: decide whether `stacks.id` IS the tenant
      or a tenant owns stacks. Write the answer down before writing SQL.
      → `odd/tasks/multi-tenant-w1-tenancy.md`. Answer: `stacks.id` IS the tenant.
- [x] **W1.2** Add `SET LOCAL app.stack_id` to `withRequestTransaction`
      (`db.ts:313`) so tenant context is established once per transaction.
      → `bindTenant` (`core/stack_resolver.ts:112`), called from `resolveStack`
      (`:171`). Deviation from plan text below.
- [x] **W1.3** Enable RLS + `FORCE ROW LEVEL SECURITY` + policies on all 8 tables
      in `packages/llmwiki-kg/db/schema.sql`.
      → shipped as `db/migration_rls_tenancy.sql`, not an edit to `schema.sql`.
- [ ] **W1.4** Fix the 15 unfiltered statements. Start with
      `routes/documents/get.ts:28` — it must call `resolveStack` and filter.
      → **NOT DONE as written, and deliberately so; see the measured gap.**
- [x] **W1.5** Cross-tenant test: a transaction scoped to stack A reading stack B's
      document, entity, and chunk rows must return **zero rows**. Mutation-verify
      it by removing the RLS policy and watching it go red.
      → `test/dimensions/kg-rls-tenancy.test.ts`, 4 tests, 4 passed (re-run).

## Wave 1 — measured state

Wave 1 is PARTIALLY landed, and the gap is narrow enough to state precisely.
Everything here was executed against the live database in this session.

### What is genuinely in place

| Fact | Evidence |
| --- | --- |
| RLS enabled AND forced on all 8 tables | `pg_class`: `relrowsecurity=t`, `relforcerowsecurity=t` for all 8 |
| 8 policies exist | `pg_policies where policyname='tenant_isolation'` → 8 |
| `llmwiki_app` exists and cannot bypass | `rolsuper=f`, `rolbypassrls=f` (contrast `aks`: `t`,`t`) |
| Tenant binding exists and is used | `bindTenant` called by `resolveStack`, reached by 7 route files |
| The cross-tenant leak is closed under the app role | `documents/get.ts` query, unbound as `llmwiki_app` → **0 rows**; as `aks` → **1 row** |

### Three claims in `4b08af5` that measurement corrects

1. **"`withRequestTransaction` establishes tenant context once per transaction" is
   not true.** `bindTenant` hangs off `resolveStack`, so the binding exists only on
   the 7 route files that call it. `withRequestTransaction` (`db.ts`) is unchanged.
   This matters because the plan's rationale was "every tenanted query runs under
   RLS without its author remembering to" — that guarantee does not exist.
2. **"RLS covers the 15 unfiltered statements WITHOUT editing any" closes the leak
   but breaks legitimate access.** Measured: with `llmwiki_app` bound to the
   *owner's own* stack, `documents/list.ts`'s manually-filtered query returns 0
   rows, because the route never sets the GUC. The leak is gone and so is the
   feature. 7 of the 16 route files that query a tenanted table call
   `resolveStack`; **9 do not** (`documents/{get,list,upload,delete}`,
   `backfeed/{get,approve}`, `synthesize/description`, `ingest/{request,pipeline}`).
   W1.4 is therefore still open, and it is the blocker on switching the role.
3. **RLS is inert in production today.** `DATABASE_URL` names `aks` in the
   default (`config.ts:67`), `docker-compose.yml:24`, `.env.example:4`, and in the
   live API container (`printenv DATABASE_URL`). Since `aks` is SUPERUSER +
   BYPASSRLS, every policy currently evaluates to "allow everything". The schema
   is in place; the isolation is not in force.

### Why W1.3 moved out of `schema.sql`

The plan said to edit `packages/llmwiki-kg/db/schema.sql`. That file is
`sharedPaths`, i.e. writable by no feature role, and `forbidden` to A and B. A
separate migration is the only shape that could land at all, and it is also the
correct one: `schema.sql` builds a fresh database, while tenancy has to be applied
and later re-applied to a live one. `schema.sql` still creates the 8 tables
WITHOUT policies, so a fresh database comes up ungoverned until the migration runs.
That is a real ordering hazard to keep in view, not a detail.

### W1.4 as written is not implementable for the two by-id document routes

This is the finding that changes W1.4's shape, and it is a conflict between two
requirements that were never compared.

`GET /documents/:doc_id` and `DELETE /documents/:doc_id` carry **no stack
parameter** — verified in `oracle/contracts/openapi.json`, which defines
`/documents/{doc_id}` with no `stack_id`. So the plan's instruction ("it must call
`resolveStack` and filter") has nothing to resolve *from*.

The obvious repair — look up the owning stack by `doc_id`, bind it, then read — is
impossible under RLS, because the lookup that would reveal the tenant is itself
subject to the policy. Measured on the live database as `llmwiki_app` with no
binding:

```
select stack_id from stack_documents where id = '<a real doc id>'
  -> NULL   (cannot be discovered)
```

That is the fail-closed direction working correctly, and it is exactly why the
chicken-and-egg cannot be broken from inside the request.

There is a second, harder constraint: the oracle **deliberately** serves a
document of another stack by id. It is asserted, not accidental —
`routes/documents-read.test.ts:91`, "GET /documents/:doc_id serves a document
belonging to any stack", with the comment "measured on the oracle". This is also
what `4b08af5` meant by "editing the query would have broken fidelity to fix a leak
RLS already closes".

So three requirements cannot all hold:

| Requirement | Source |
| --- | --- |
| By-id routes need no stack in the path | oracle OpenAPI + parity test |
| A tenanted query needs `app.stack_id` set | RLS policies |
| The tenant must be discovered from the doc id | needed to set it |

**What this means for W1.4.** It reduces to a decision, not a task: the by-id
routes must either (a) accept a stack parameter — a contract change against the
oracle, needing a version bump and a parity exception — or (b) keep working and be
unavailable under the app role, which means `DATABASE_URL` cannot move to
`llmwiki_app` for them. The remaining 7 unbound files do have the stack available
(`:stack_id` in the path, or a body field) and are ordinary work:
`documents/{list,upload}`, `backfeed/{get,approve}`, `synthesize/description`,
`ingest/{request,pipeline}`.

This is recorded rather than resolved because it needs an owner decision on oracle
parity, and every file involved is `orchestrator-c`'s surface, not this role's.

### The one blocking decision

Switching the application role is a deployment change, not a code change:

1. Land W1.4 for the 9 unbound route files.
2. Set a password for `llmwiki_app` out of band (it is `nologin` on purpose).
3. Point `DATABASE_URL` at `llmwiki_app`.
4. Add the migration to the fresh-database path so a new deploy is not born ungoverned.

Until step 1 lands, step 3 would take the documents, backfeed, synthesize and
ingest routes to zero rows. That is why the order is not negotiable.

## Wave 2 — L3 control state into the database

**Blocked on surface, not on design.** All four targets are `sharedPaths`, i.e.
read-only for every feature role (verified for a, b and c). Only
`orchestrator-main` (`unrestrictedWrite`) can write them. So Wave 2 cannot be
delegated to a dimension role under the current contract, no matter who is free.

- [ ] **W2.1** Replace the PID lockfile (`src/utils/lock.ts`, ~two-lock
      reclamation) with a Postgres advisory lock or `SELECT ... FOR UPDATE` row.
      This is what currently forbids a second process.
      → `src/utils/lock.ts` is shared-read-only. Needs `orchestrator-main`.
- [ ] **W2.2** Replace the file WAL in `src/trust/journal.ts` with a table.
      Keep the pre-state recording contract identical.
      → shared-read-only. Needs `orchestrator-main`.
- [ ] **W2.3** Move the outbox (`.llmwiki/dimensions/outbox/*.json`) to a table;
      keep `atomicWrite`-equivalent durability semantics via transaction commit.
      → shared-read-only. Needs `orchestrator-main`.
- [ ] **W2.4** Move `embeddings.json` (currently whole-file, 64 MiB cap at
      `MAX_EMBEDDING_STORE_BYTES`) to a vector table. The cap exists only because
      the whole file is read into memory.
      → shared-read-only. Needs `orchestrator-main`.

## Wave 3 — L2 compiled product behind the port

- [ ] **W3.1** Decide the coordinator ordering and rollback story now that both
      dimensions are remote. Two-phase outbox is not enough; either accept a saga
      or pick a single-transaction home for both.
- [x] **W3.2** Implement a `createWikiDimension` backed by the database, keeping
      `saveSource`'s protections (empty-slug guard, collision suffix, identity
      match). Write through the port, not through `collectPages`.
      → `9cda76a`, `src/dimensions/wiki/store-dimension.ts`. Named
      `createWikiStoreDimension` and kept as a SIBLING of the filesystem factory
      rather than replacing it, because the-then-current W3.4 required both (that
      requirement is now SUPERSEDED; the sibling shape it produced is what the
      Stack-only migration replaces). All three protections are asserted against a
      real database in `test/dimensions/wiki-store-dimension.test.ts` (7 tests).
- [x] **W3.3** Implement `createWikiReader` over SQL so listing is one SELECT
      instead of `readdir` + N body reads.
      → `c6e0781`, `src/dimensions/wiki/page-reader.ts`. Named
      `createWikiPageReader`, sibling of `createWikiReader`. Listing is one
      `select … from wiki.pages` (`page-store.ts:200`), not `readdir` + N reads.
- [~] **W3.4** ~~Keep a file-backed implementation selectable behind the same port,
      so local-first stays possible and the server path is not the only one.~~
      **SUPERSEDED — see `odd/tasks/multi-tenant-stack-only.md`.**
      → It WAS delivered: the file-backed pair was untouched and still what
      `src/dimensions/activation.ts` built, and the database pair became reachable
      from outside the wiki directory through `src/dimensions/wiki/database.ts`.
      That delivery is what made the choice visible enough for the human to retire
      it.

      The human then decided Postgres becomes the ONLY backend, which deletes the
      file-backed implementation instead of keeping it selectable. W3.4 and that
      decision cannot both hold, so this requirement is retired rather than
      quietly left ticked: a reader who found `[x]` here would conclude local-first
      is still supported, which is the opposite of the ratified direction. The
      superseding document owns the consequences — accepted cost is that
      `llmwiki compile` now requires a reachable Postgres, recorded there as a
      release-note item rather than a hedge.

### W3 needs a table that does not exist, and no feature role may create it

This is a prerequisite the plan never stated, found by looking for the table W3.2
and W3.3 assume.

**There is no wiki table.** `schema.sql` has 8 tables and every one is KG-side.
`grep -icE "create table.*(concept|wiki_page|pages)"` → 0 (the single hit for
"concept" is a column comment). `entity_pages` cannot stand in: its primary key
is `entity_id uuid references ontology_entities(id)`, so a row requires an
extracted entity, and a compiled wiki concept has none.

W3.2 and W3.3 therefore begin with new DDL under
`packages/llmwiki-kg/db/`, which is `forbidden` to `orchestrator-a` and
shared-read-only to b and c. Again only `orchestrator-main` can write it.

There is a scope question hidden here that the plan should not decide by
accident: **the wiki's storage should arguably not live in the KG package's
schema at all.** Putting compiled wiki pages in `packages/llmwiki-kg/db/` makes
the wiki depend on the vendored AKS package for its persistence, which inverts
the dimension boundary the whole contract is built around. The honest options are
(a) a separate wiki schema/migration outside the KG package, or (b) accept the
coupling and document why. W3.1's ordering decision and this one are the same
decision seen from two sides.

**RESOLVED, and not the way the two options above are written.** The DDL shipped
as `src/dimensions/wiki/schema.sql` (`5f513fc`): a separate `wiki` schema in the
same database, owned by the wiki dimension's own surface rather than by the KG
package. That is option (a) with the migration living in this role's directory
instead of `packages/llmwiki-kg/db/`, so `orchestrator-a` could write it and the
KG package's schema stayed untouched. Applied with
`docker compose exec db psql -U aks -d aks -f src/dimensions/wiki/schema.sql`
after `migration_rls_tenancy.sql`, since it reuses that file's `app.stack_id`
GUC convention and would otherwise create a schema the app role cannot read.

`src/dimensions/wiki/{index,reader}.ts` themselves are `orchestrator-a`'s. The
work was real and belonged to this role once the DDL question was answered — and
it has since been done: the DDL shipped inside this role's own surface, so the
`orchestrator-main` dependency this paragraph names never materialised. See
`## Wave 3 — reconciled state`.

## Wave 4 — L1 raw bytes to object storage

- [ ] **W4.1** Introduce a blob abstraction for `sources/` and `dist/exports` only.
- [ ] **W4.2** S3/MinIO adapter, plus a filesystem adapter for local-first.
- [ ] **W4.3** Content addressing: the wiki already hashes sources
      (`sha256` in `.llmwiki/state.json`), so blob keys can be content-addressed
      without new identity machinery.

Still last by design, and still blocked by the same surface problem as Wave 2:
the seam is `src/utils/constants.ts` (`SOURCES_DIR`, `EXPORT_DIR`), which is
shared-read-only for every feature role.

## Task count

**16 tasks across 4 waves.** Wave 1 is 5 tasks and blocks everything else. Do not
start Wave 4: it is the most visible and the least load-bearing.

| Wave | Tasks | State | Writable by |
| --- | --- | --- | --- |
| 1 — Tenancy | 5 | **4 done; W1.4 open (2 of its 9 files are blocked by a contract conflict)** | partly `orchestrator-c` |
| 2 — L3 control state | 4 | not started | **only `orchestrator-main`** |
| 3 — L2 product | 4 | **W3.2, W3.3 done; W3.4 SUPERSEDED; W3.1 open** | `orchestrator-a` |
| 4 — L1 object storage | 3 | not started, last by design | **only `orchestrator-main`** |

## Decisions taken by the human (this session)

Recorded before any code, because all three change the plan's shape.

1. **W1.4 → add `:stack_id` to the by-id routes.** `GET`/`DELETE
   `/stacks/:stack_id/documents/:doc_id`. Tenancy becomes real rather than
   partial, at the cost of oracle parity: the OpenAPI contract gains a version and
   `documents-read.test.ts:91` ("serves a document belonging to any stack") must be
   INVERTED, not deleted. Owned by `orchestrator-c`.
2. **Waves 2 and 4 → `orchestrator-main` executes them** under
   `unrestrictedWrite`, in the primary checkout on the shared branch. Accepted
   cost: no role branch, no per-wave native review, everything lands directly.
3. **W3's wiki table → a separate `wiki` schema in the same database**, reached
   through the existing KG client/pool rather than a second driver. Rationale
   accepted: no root-level `postgres` dependency (it is absent today), one pool,
   and the wiki does not gain a hard dependency on the vendored AKS package's
   schema file — only on the pooled client it already consumes in process.

### The third blocker (claimed): neither dimension port can carry a tenant

Found while preparing W3.2/W3.3. `DimensionInput` is
`{source, title, document, body}` and `DimensionQuery` is
`{name?, text?, depth?, kinds?, limit?}`. **Neither has a stack/tenant field**, and
both are frozen contracts (`DIMENSION_PORT_VERSION = 2`,
`DIMENSION_READ_PORT_VERSION = 1`).

A database-backed wiki dimension cannot be written without knowing WHICH tenant it
is writing for, so this document concluded that W3.2 and W3.3 both require a port
change:

| Port | File | Field needed | Version today |
| --- | --- | --- | --- |
| `DimensionInput` | `src/dimensions/types.ts` | `stack` (required) | 2 |
| `DimensionQuery` | `src/dimensions/read-types.ts` | `stack` (required) | 1 |

`src/dimensions/types.ts` and `read-types.ts` are `sharedPaths` — read-only for
this role. So the port bump is `orchestrator-main`'s to make, and it must land
before W3.2/W3.3 can start. The plan's "Not changing `DIMENSION_PORT_VERSION`"
non-goal is now void: it was written when the wiki was staying on the filesystem.

**THE CONCLUSION ABOVE IS WRONG, and the code refutes it.** W3.2 and W3.3 shipped
with both ports still at their original versions, and neither needs the field the
table demands. The tenant is bound at CONSTRUCTION:

```ts
createWikiStoreDimension({ db, stackId })   // store-dimension.ts:173
createWikiPageReader({ db, stackId })       // page-reader.ts:126
```

A dimension instance therefore serves exactly one tenant, and a caller serving
several constructs one per stack. This is not a new convention invented to dodge
the bump: `createKgReader({ stackId })` (`src/dimensions/kg/reader.ts`) already
binds its tenant the same way, so the wiki follows the precedent the KG side set.

The consequence worth keeping in view is the argument FOR this shape, not just
that it works: a tenant threaded through every call can be forgotten at exactly
one call site, and that miss silently writes or reads the wrong stack. A tenant
captured at construction cannot be omitted later, because there is no later place
to omit it. `DIMENSION_PORT_VERSION` and `DIMENSION_READ_PORT_VERSION` are
unchanged, which also keeps the frozen-port non-goal above intact.

What this costs: one instance per Stack, so a long-lived multi-Stack server
keeps a dimension per stack instead of one. That is the honest trade, and it is
the one the KG dimension already pays.

### The two blockers are not the same kind

Wave 1's remainder is a **decision** (oracle parity on the by-id routes). Waves
2–4 are a **surface** problem: their targets are shared-read-only, so no feature
role can execute them under the current contract. Delegating W2.1 to
`orchestrator-b` would simply be refused by the enforcement hook.

That leaves exactly two honest routes for Waves 2 and 4, and the human should
pick, not the agent:

- **`orchestrator-main` executes them** under `unrestrictedWrite`, in the primary
  checkout on the shared branch. **DECIDED.**
- **Widen the contract** so one dimension role owns the L3 files. Rejected: scope
  is re-read on every tool call, so editing it with live peers unenforces every
  session at once; it would need a stop/edit/commit/relaunch cycle.

### Execution order now that the decisions are in

Three of the five prerequisites are `orchestrator-main`'s, so they serialise:

| # | Work | Owner | Unblocks |
| --- | --- | --- | --- |
| 1 | ~~Port bump: `stack` on `DimensionInput` + `DimensionQuery`~~ **not needed** | ~~main~~ | nothing — see the refutation above |
| 2 | `wiki` schema migration, outside `packages/llmwiki-kg/db/` | shipped as `src/dimensions/wiki/schema.sql` | W3.2, W3.3 |
| 3 | W1.4: 7 unbound routes + `:stack_id` on the 2 by-id routes + OpenAPI bump | orchestrator-c | moving `DATABASE_URL` to `llmwiki_app` |
| 4 | ~~W3.2/W3.3 database-backed wiki dimension + reader~~ **done** | orchestrator-a | W3.4, done — and W3.4 is now SUPERSEDED |
| 5 | Wire the database backend into activation, and W3.1's commit ordering | main | the server actually using it |
| 6 | W2.1–W2.4, W4.x | main | — |

Steps 1–2 were small and independent of 3; step 1 turned out not to exist at all.
Step 4 is finished.

**This table is no longer the forward plan.** It stops at "wire the DB backend in",
because that is where this document's scope ended. The ratified direction goes
further — the file-backed path is deleted, not kept selectable — and the ordering
for that is in `odd/tasks/multi-tenant-stack-only.md`, which also REVERSES this
document's wave sequence (L2 → L3 → L1 rather than Waves 2–4 in numeric order) for
reasons measured there.

**Honest state of this role: W3.2 and W3.3 are done; W3.4 is superseded; none of it
was ever mine to wire.** The earlier "blocked, with a named dependency" claim in
this document was accurate about the missing schema and wrong about the port. What
remains is not this role's: `src/dimensions/activation.ts`, the
`src/dimensions/index.ts` barrel, `lock.ts`, `journal.ts` and `atomic-write.ts` are
all `sharedPaths`, so both wiring the backend AND the Stack-only migration belong to
`orchestrator-main`.

## Wave 3 — reconciled state

W3.2 and W3.3 are landed, tested, and reachable. W3.4 was landed too and is now
SUPERSEDED by the Stack-only decision. This section records what the code actually
delivers, measured against the plan text above rather than against the commits' own
summaries.

### What is delivered

| Task | Artifact | Reachable from | Tests |
| --- | --- | --- | --- |
| W3.2 | `store-dimension.ts` — `createWikiStoreDimension({db, stackId})` | `src/dimensions/wiki/database.ts` | 7, real Postgres |
| W3.3 | `page-reader.ts` — `createWikiPageReader({db, stackId})` | `src/dimensions/wiki/database.ts` | 7, real Postgres |
| ~~W3.4~~ SUPERSEDED | filesystem pair untouched at the time; both pairs satisfied the same ports | `index.ts` (filesystem), `database.ts` (database) | 2, entry-point guards |

W3.4's artifact is kept in this table rather than deleted because it is what
`test/dimensions/wiki-database-entry.test.ts` still asserts today — including the
assertion that the filesystem barrel does NOT export the database pair. Under the
Stack-only direction that second assertion stops being an import-cost guard and
becomes obsolete, which is a change `orchestrator-main` owns, not this role.

`saveSource`'s three protections are each asserted, and each assertion is a
property a fake store could not show: the empty-slug guard rejects a title of
punctuation, a second source sharing a title lands on `-1` rather than
overwriting, and re-ingesting one source under a new title updates in place
instead of forking. Isolation is asserted against a real second stack, for the
reason `page-store.ts` records: RLS is inert under the harness role, so only a
cross-stack read proves the explicit predicate is doing the work.

### The reachability bug this reconciliation found

Both factories existed, compiled, and passed their own tests, and **nothing could
import them**. Each test file reached its module by path, so the suite could not
detect the gap: a test that imports `./page-reader.js` proves that file compiles,
not that any consumer can obtain it. `src/dimensions/index.ts` re-exported only
the filesystem pair.

Adding two lines to that barrel would have been wrong, measurably so:

- `page-store.ts` imports `sql` from `drizzle-orm` as a **value**.
- `drizzle-orm` is declared in `packages/llmwiki-kg/ts/package.json`, **not** in
the root `package.json` (which lists no `drizzle-orm`).
- `src/dimensions/index.ts` is imported by `src/compiler/index.ts` and
  `src/services/ingest/service.ts`, so barrel exposure puts the query builder on
  every `compile` and `ingest` invocation.

So the entry point is `src/dimensions/wiki/database.ts`, a separate module.
`test/dimensions/wiki-database-entry.test.ts` asserts BOTH halves: the factories
are callable as their ports, and the filesystem barrel still does not export them.
The second assertion is the important one — it makes merging the entry point back
into the barrel a test failure rather than a silent regression in the CLI's import
cost.

### What W3 still does not do

1. **W3.1 is open, and the code makes it sharper rather than solving it.** Both
dimensions can now be remote, so the coordinator's stated rationale for
committing the wiki first — "the wiki write is the cheap, LOCAL, revertible half"
(`coordinator.ts:8-16`) — no longer holds on the database path. A saga with
idempotent compensation is the shape this needs, and it is a decision, not a
patch.
2. **Nothing selects the database backend yet.** `resolveDimensions`
   (`src/dimensions/activation.ts`) still builds `createWikiDimension(root)`
   unconditionally, because that file is a `sharedPath`.
3. **Two migrations must run, in order.** `src/dimensions/wiki/schema.sql` needs
   `migration_rls_tenancy.sql` applied first, since it reuses the
   `app.stack_id` GUC convention and grants `llmwiki_app` access to a schema the
   earlier file never touches. A fresh database that runs only one of them gets
   either a permission error or silent zero rows.
4. **The reader answers no text search.** Bodies are not indexed for search in
   this schema, so a text-only query reports `unavailable` rather than an empty
   result — deliberately, because an empty `chunks` array reads as "nothing
   matched".

### Evidence log — Wave 3

- `npx tsc --noEmit`: exit 0, no errors, from the `orchestrator-a` worktree at
  `4f9752c` plus this change.
- `npx vitest run test/dimensions/wiki-{database-entry,store-dimension,page-reader}.test.ts`:
  16 passed, 0 failed, 0 skipped. The Postgres-backed suites RAN (the schema is
  provisioned in the local stack container), so their assertions are evidence and
  not a vacuous skip.
- Read rather than assumed: both factory signatures, `withTenant`, the
  `listStoredPages` SELECT, `createKgReader`'s tenant-at-construction precedent,
  the root `package.json` dependency list, and every import site of
  `src/dimensions/index.ts`.

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
src/dimensions/wiki/database.ts  OWNED  (elected entry point for the DB pair)
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
- **Wave 1 reconciliation** (`4b08af5`, re-measured in this session): `pg_class`
  RLS flags, `pg_policies` count, `pg_roles` superuser/bypass flags, the live API
  container's `DATABASE_URL`, `bindTenant` call graph, and the 7-bound/9-unbound
  route split. Isolation proven by direct query: the same `documents/get.ts`
  statement returns 0 rows unbound as `llmwiki_app`, 1 row as `aks`, and 1 row as
  `llmwiki_app` bound to the owning tenant. Test suite re-run: 4 passed.
- A first version of that probe silently proved nothing — the fixture insert used
  the wrong column names, so both sides counted 0 and "agreed". Re-run against the
  real schema (`information_schema.columns`) is what the numbers above report.
  Treat any probe whose two sides both return zero as unexecuted, not as evidence.
