# Feature: Stack-only storage — Postgres as the only backend

## Goal

Decide, measure, and design the removal of the local filesystem as a storage
medium, so every layer of the wiki lives in Postgres keyed by **Stack** — the name
the code already uses. The `wiki` dimension stops having a file-backed sibling.

Status: **MEASUREMENT + DESIGN ONLY. NO PRODUCT CODE.** The human selected
"Postgres obligatorio: se borra el camino local" and "Stack, y corregir los docs"
in this session, and then selected "medición + diseño ejecutable para main" as the
deliverable. Nothing here is implemented, because the surface this plan needs is
`shared-read-only` to this role (see `## Scope verdict`), and because the plan
retires a ratified requirement that has to be recorded before anyone writes code.

## Decision record

Recorded before any analysis, because both choices contradict what is currently
ratified and an agent must not quietly rewrite a human decision into a refactor.

| Decision | Value | Date |
| --- | --- | --- |
| Backend model | Postgres is the only backend; the file-backed implementation is removed | 2026-10-24 |
| Tenant name | **Stack** — the word the code already uses; docs aligned to it | 2026-10-24 |
| Deliverable of this role | Measurement + executable design for `orchestrator-main` | 2026-10-24 |

### What must be ratified, not assumed

1. **This retires W3.4.** `odd/tasks/multi-tenant-storage.md` W3.4 is ticked and
   reads: *"Keep a file-backed implementation selectable behind the same port, so
   local-first stays possible and the server path is not the only one."* Deleting
   `createWikiDimension` does not satisfy W3.4; it retires it. W3.4 must be marked
   SUPERSEDED with a pointer to this document, or the two records contradict each
   other and a future reader trusts whichever they opened first.
2. **This changes the product default.** `LLMWIKI_DIMENSIONS` unset currently
   yields `["wiki"]` and `compile` needs no database. After this change a single
   `llmwiki compile` requires a reachable Postgres. That is a product decision with
   release-note consequences, not a storage detail.
3. **`stacks` is already the name.** No identifier changes: the table is
   `public.stacks`, the code threads `stackId`, the env var is `AKS_STACK_ID`, and
   W1.1 already recorded *"`stacks.id` IS the tenant"*. The only outlier is prose
   ("multi-tenant") in documents. Renaming the table would be a migration in
   `packages/llmwiki-kg/db/schema.sql`, which nobody in this contract may write.

## Scope verdict

Computed against `contract-cordination.json` for the paths this plan touches:

| Path | Verdict for `orchestrator-a` |
| --- | --- |
| `src/dimensions/wiki/**` | OWNED |
| `odd/tasks/multi-tenant-*` | OWNED |
| `test/dimensions/wiki-*` | OWNED |
| `src/dimensions/activation.ts` | SHARED-READ-ONLY |
| `src/dimensions/types.ts` | SHARED-READ-ONLY |
| `src/compiler/index.ts` | SHARED-READ-ONLY |
| `src/utils/source-writer.ts` | SHARED-READ-ONLY |
| `src/utils/constants.ts` | SHARED-READ-ONLY |
| `src/utils/lock.ts` | SHARED-READ-ONLY |
| `src/trust/journal.ts` | SHARED-READ-ONLY |
| `src/dimensions/outbox.ts` | SHARED-READ-ONLY |
| `src/services/ingest/service.ts` | SHARED-READ-ONLY |

**Consequence: this role cannot implement this plan.** Every seam is
`shared-read-only`, so only `orchestrator-main` under `unrestrictedWrite` can
execute it. The deliverable here is the measurement and the task breakdown, plus
the parts that are genuinely owned (`src/dimensions/wiki/**` and its tests).

Worth recording as a process note: the first filename attempted for this document
was `odd/tasks/stack-only-storage.md`, and the scope hook refused it correctly,
because this role owns `odd/tasks/multi-tenant-*`, not an arbitrary `odd/tasks/*`
name. The refusal was right and the file was renamed rather than the contract
widened.

## Layering — what "no filesystem" decomposes into

The request "el wiki debe funcionar sin filesystem" is three migrations, not one.
They have different owners, different risks, and one is load-bearing for
correctness in a way the others are not.

| Layer | What it stores | Today | Blocker class |
| --- | --- | --- | --- |
| **L1 — raw bytes** | `sources/` inputs | filesystem | seam reach (`root: string`) |
| **L2 — compiled product** | `concepts/*.md`, `queries/*.md`, index | filesystem via `atomicWrite` | output shape, not durability |
| **L3 — control state** | lock, journal, outbox, state | filesystem | **correctness** |

### The correction that matters most

An earlier reading of this plan called the wiki dimension's DB path "the wiki
without filesystem". It is not. Verified in this session: `grep -rln
"page-store|listStoredPages|upsertStoredPage|store-dimension|page-reader" src/`
outside `src/dimensions/wiki/` returns **empty**.

So the database-backed dimension writes `wiki.pages`, and **no product path reads
or writes that table**. The compiled product is written to disk by `src/compiler/*`
through ten file-writing modules, and `compile` explicitly FILTERS the wiki
dimension out:

```ts
// src/compiler/index.ts:661
const dimensions = resolveDimensions({ root }).filter((entry) => entry.name !== "wiki");
```

The wiki dimension is the SOURCE-ingest writer; the compiler is the PAGE writer.
Different layers, different code, and L2 is not owned by any dimension at all. Any
plan that says "wire the DB dimension into activation and the wiki is server-side"
is wrong by one whole layer.

## Blocker classification

### L3 — control state: the correctness blocker

`src/trust/journal.ts` is not storage plumbing. It is the mechanism that makes
every ingest revertible: a write-ahead record of a target's pre-state, replayed at
startup to undo an interrupted write. `src/dimensions/wiki/index.ts` depends on it
for `discard`, which is exactly the rollback path the coordinator calls.

Replacing it with a table is not a port of a file to a row. It redefines rollback
semantics, and it lands in the same change that removes `src/utils/atomic-write.ts`
— the other durability mechanism. Two independent safety nets removed together
means a defect in the replacement has no fallback.

### L1 — raw bytes: the seam-reach blocker

`sources/` writes go through `saveSource`, and `ingestTextSource(root, input)`
takes an absolute path. `root: string` appears **1461** times and **102** files in
`src/` import `node:fs` (`grep -rn "root: string" src/ | wc -l`, `grep -rl 'from
"node:fs' src/ | wc -l`, both measured here; the 1459 figure circulating in older
documents in this plan is two occurrences stale). This is breadth, not depth: each site is mechanical,
and the migration is reviewable only if it is done per-seam rather than per-file.

### L2 — compiled product: the shape blocker

**A correction to an earlier reading of this file, and it is GOOD news.** L2 was
first described here as "ten file-writing modules under `src/compiler/`". That was
a FILE count from a loose grep, and it overstated the work. Measured properly:

- There is **one write chokepoint**: `applyCompilePageWritesLocked`
  (`src/compiler/compile-write.ts:133`), which routes through
  `planCompilePageWrites` → `applyApprovedMutationsLocked`.
- It has exactly **5 callers**: `src/compiler/orphan.ts:59`, `:95`,
  `src/compiler/seed-pages.ts:70`, `src/compiler/index.ts:238`,
  `src/compiler/resolver.ts:194`, `src/compiler/link-repair.ts:180`.
- The `atomicWrite` calls inside `src/compiler/` are **7 call sites**, and they
  write COMPILE STATE, not pages: `rule-state.ts`, `rule-candidates.ts` (×2),
  `candidates.ts`, `candidate-publication.ts`, `indexgen.ts`, `obsidian.ts`.
- The store to write INTO already exists: `upsertStoredPage`
  (`src/dimensions/wiki/page-store.ts:256`).

So L2 is **not** a 10-module rewrite. It is one function to reimplement plus 5
call sites to keep, and the schema already carries `orphaned`, `archived`,
`updated_at` and `source_identity`.

What genuinely blocks L2 is different from what does the work:

1. **The read side is broad.** 206 test files reference `wiki/concepts` or
   `CONCEPTS_DIR` (`grep -rln 'wiki/concepts\|CONCEPTS_DIR' --include=*.ts test/`).
   Writing rows changes what all of them observe, even though only one function
   writes.
2. **The identity model is a path.** `src/utils/page-id.ts`, `page-registry.ts`,
   `state.ts:154` (`frozenSlugs` joined into a path), `import/okf-collision.ts:36`
   (existence checks via `fileExists`) and `embeddings-collect.ts:104` all derive
   identity from a directory. Rows need `(stack_id, page_directory, slug)`.
3. **`atomicWrite` is used by 69 files across `src/`**, not 46 — the 46 earlier
   was a narrower pattern. But almost none of those are PAGE writes: they are
   run stores, manifests, state, embeddings. This is why T7 (deleting
   `atomic-write.ts`) is much larger than L2 and must not be coupled to it.

## Executable design

### The honest ordering

**L2 → L3 → L1**, which is the reverse of the wave numbering in
`multi-tenant-storage.md`. Reasoning:

1. **L2 first** because it delivers the visible goal (pages in Postgres) without
   touching durability at all. `wiki.pages` exists, the store exists and is tested,
   and the compiler's write surface is bounded. If the project stops after L2 it has
   a real feature and no lost safety net.
2. **L3 second** because it is the risky one and must be done with L2 stable, not
   simultaneously. It also cannot be tested honestly until pages live in the
   database, since a journal over rows has different failure modes than one over
   files — and because `JournalEntry.targetPath` is a filesystem path, it cannot be
   redesigned until T2 defines what a page target IS.
3. **L1 last** because it is pure breadth, its only cost is seam count, and doing
   it first would touch 1461 `root: string` occurrences before any risky logic is
   settled.

Doing L3 and L1 before L2, as the wave numbering implies, puts both durability
removals ahead of the layer that would reveal their defects.

### Per-task breakdown for `orchestrator-main`

Each task states its seams, its verification, and an explicit **must not**, so the
executor does not widen scope by improvisation. Ordered by the sequence above.

#### T1 — Read page identity from `wiki.pages` (L2, read path only)

- **Seams**: `src/compiler/index.ts:349` (`listExistingPageIds`, `readdir` over
  `CONCEPTS_DIR`/`QUERIES_DIR`).
- **Shape**: teach the created/updated split to READ identity from `wiki.pages`
  while still writing files. Read path only, independently testable.
- **Verification**: one compile fixture yields identical page IDs from both
  sources; rows inserted by hand are visible to the split.
- **Must not**: change the write path, touch the journal, or alter `Dimension`.

#### T2 — Write compiled pages to `wiki.pages` (L2, write path)

- **Seam — exactly one**: `applyCompilePageWritesLocked`
  (`src/compiler/compile-write.ts:133`). Its 5 callers keep their signatures:
  `orphan.ts:59`, `orphan.ts:95`, `seed-pages.ts:70`, `index.ts:238`,
  `resolver.ts:194`, `link-repair.ts:180`.
- **Shape**: reimplement that one function to upsert through the existing
  `upsertStoredPage` (`src/dimensions/wiki/page-store.ts:256`) instead of
  `applyApprovedMutationsLocked`. The store, schema and 14 real-Postgres tests
  already exist and are owned by this role.
- **Verification**: the wiki suites plus a compile fixture asserting ROWS; orphan,
  index and link-repair generation unchanged. Budget for the read side: **206 test
  files** reference `wiki/concepts`/`CONCEPTS_DIR`.
- **Must not**: touch `atomic-write.ts` (69 files depend on it for run stores,
  manifests, state and embeddings — almost none of which are page writes), and do
  not attempt to change `page-id.ts` identity in the same task.

##### Two gaps found in T2 before it starts

Both were found by reading the two shapes against each other, and both are pinned
by tests in `test/dimensions/wiki-page-store.test.ts` so a later schema or store
change cannot quietly reopen them.

**Gap 1 — `index.md` and `MOC.md` are not pages.** `CompilePageWrite.namespace` is
exactly `"concepts" | "queries"` (`src/compiler/compile-write.ts:55`), which matches
the `wiki.pages` CHECK (`schema.sql:73`), so every PLANNED page fits. But the
compiler also writes two artifacts that are not pages at all:
`INDEX_FILE = "wiki/index.md"` (`src/utils/constants.ts:387`) via
`indexgen.ts:45`, and `MOC_FILE = "wiki/MOC.md"` (`:388`) via `obsidian.ts:117`.
Neither has a `slug` in a page directory, so **neither can be a `wiki.pages` row**
without inventing a fake namespace — and widening the CHECK to allow one would
corrupt the meaning of the column. T2 must decide explicitly: generate them from
rows on read, keep them as the last files, or give them their own table. Silence
here would produce a half-migrated wiki where the index is a file and the pages
are rows.

**Gap 2 — the body shapes differ.** `CompilePageWrite.body` is **frontmatter +
prose** (`compile-write.ts:63`), while `Page.body` is **prose only**, with `title`
and `summary` as separate fields (`src/pages/list.ts:43-59`). So T2 must split on
the way in via `parseFrontmatter` (`src/utils/markdown.ts:101`) and take `title`
and `summary` from it. Both halves are now asserted against a real database.

**One thing that is NOT a gap, measured rather than assumed.** After a compile
upsert, a page keeps the `source_identity` that `store-dimension.ts` wrote, because
`upsertStoredPage` simply omits the column from `do update set` — Postgres
preserves it. So the two writers do not fight over the column and the next
re-ingest still finds its page. This mattered because the dimension looks pages up
BY `source_identity` (`store-dimension.ts:120`) while the compiler path never sets
it; had the upsert nulled it, every compile would detach a page from its source and
fork a duplicate on the next ingest. It does not, and there is now a test saying so.

#### T3 — Retire the file-backed wiki dimension (the W3.4 reversal)

- **Seams**: `src/dimensions/activation.ts:102`, `src/dimensions/wiki/index.ts`,
  `src/dimensions/index.ts:34`, `test/dimensions/wiki-dimension.test.ts`,
  `test/dimensions/cross-dimension-rollback.test.ts`.
- **Shape**: `resolveDimensions` builds `createWikiStoreDimension({db, stackId})`
  and errors without a Stack, exactly as `kg` already does.
- **Verification**: `LLMWIKI_DIMENSIONS` unset must fail naming `AKS_STACK_ID`
  rather than silently doing something else.
- **Must not**: rename the `stacks` table, or rename `DimensionName` ("wiki" stays
  the name of the SOURCE dimension even though its backend changed).

#### T4 — Advisory lock for L3 mutual exclusion

- **Seams**: `src/utils/lock.ts` (4 exports: `acquireLock`, `acquireLockBlocking`,
  `releaseLock`, `LockBusyError`) and **52 source callers**.
- **Shape**: keep the four export SIGNATURES identical so the 52 callers do not
  change; replace the implementation with a Postgres advisory lock keyed by Stack.
  The liveness question the four-step reclamation protocol answers needs an explicit
  human decision: a `lock_holder` table with `heartbeat_at`, or accept that a crashed
  holder blocks until timeout.
- **Verification**: the adversarial suites must pass or be rewritten WITH the human's
  decision recorded. `lock-pid-reuse`, `lock-blocking-fifo`,
  `lock-publication-race`, `lock-owner-liveness-classification`,
  `lock-release-confined`, `lock-hardening` encode semantics an advisory lock may
  not reproduce.
- **Must not**: delete a test to make the suite green. A deleted assertion is a lost
  requirement, not a passing build.

#### T5 — Journal as a table (the risky one)

- **Seams**: `src/trust/journal.ts:92` (entry shape), `src/trust/executor.ts:169`
  (replay), **25 source files**, **35 test files**.
- **Shape**: ~~`JournalEntry.targetPath` is an absolute path and `JournalBatch`
  carries `root` (`journal.ts:103-107`), so a target becomes a
  `(stack_id, page_directory, slug)` tuple.~~ **MEASURED FALSE — see below.**
  This cannot be designed before T2 settles page identity.
- **CORRECTION (measured)**: the journal is not a page journal. Its recorded
  targets belong to FOUR classes, and three are not pages: artifact
  `bytesPath`/`manifestPath` (`artifacts/apply.ts:91-92`), content-addressed
  binary members (`artifacts/apply-members.ts:117-120`), and
  `TEMPLATE_LOCK_FILE`/`PROFILE_FILE` (`profile/templates/update-apply.ts:107-108`).
  Only `page-apply.ts:258` records a page.
  `JournalEntry` has no identity fields at all — just `targetPath: string` and a
  `preState` — and `journal.ts` carries **13** uses of
  `confineUnderRoot`/`isInsideDir`/`safeRealpath`. The mechanism IS path
  confinement: 9 of its 35 test files deliberately record paths that escape the
  root (`journal-prestate`, `journal-recordprestate-confined`,
  `journal-revert-confined`, `trust-planner`) because refusing them is the
  property under test. A row tuple cannot "escape the root", so converting it to
  a table deletes the security property those files exist to protect.
- **Consequence**: T5 is DOWNSTREAM of T6 and T7, not upstream. A table-shaped
  journal only makes sense once the file writes it guards are gone.
- **Also measured**: `page-apply.ts:258` still writes pages via `atomicWrite`,
  so approval writes files even though `compile` writes `wiki.pages`. That gap
  must close before a page-target journal could exist at all.
- **Verification**: crash-recovery must prove a pending batch reverts across a
  simulated restart. Load-bearing suites: `journal-strict-recovery`,
  `journal-revert-confined`, `atomic-write-post-commit-recovery`.
- **Must not**: land in the same change as the removal of `atomic-write.ts`.

#### T6 — Raw bytes to the Stack (L1)

- **Seams**: `src/utils/source-writer.ts:158` (`saveSource`; exactly two non-comment
  call sites: `src/commands/ingest-session.ts:57`, `src/dimensions/wiki/index.ts:77`),
  `src/utils/constants.ts:165` (`SOURCES_DIR`), `src/services/ingest/service.ts`.
- **Verification**: text and file ingest both land rows; re-ingest of one identity
  updates in place.
- **Must not**: attempt all 1461 `root: string` sites. Convert the seam, keep the
  parameter, let the remainder follow.

#### T7 — Delete `atomic-write.ts` and the file-backed paths

- **Shape**: only after T2, T5 and T6 have landed and been stable.
- **Verification**: full suite, plus a fresh-database bootstrap producing a wiki
  end to end.
- **Must not**: run before T5. This is the step where the second safety net
  disappears.

## Measurement — results

Every number below came from a command quoted beside it, run in this worktree.
Delegated exploration was a cross-check, never the source: an earlier wave of this
plan accepted two confident false claims from delegated exploration, so only
re-verified numbers are recorded.

| Mechanism | Files under `src/` | Test files | Command |
| --- | --- | --- | --- |
| `src/utils/lock.ts` | **52** | **79** | `grep -rl 'utils/lock' --include=*.ts src/ \| wc -l` |
| `src/trust/journal.ts` | **25** | **35** | `grep -rl 'trust/journal' --include=*.ts src/ \| wc -l` |
| `atomic-write` | **69** | **21** | `grep -rl 'atomicWrite' --include=*.ts src/ \| wc -l` |
| `node:fs` importers | **102** | — | `grep -rl 'from "node:fs' src/ \| wc -l` |
| `root: string` | **1461** occurrences | — | `grep -rn "root: string" src/ \| wc -l` |

The first three rows are the finding that should change how this is sequenced.
Removing L3 is not three file edits: it reaches 52 source files and invalidates
questions asked by 79 test files. `lock.ts` alone has more dependent test files
than any other surface this measurement touched, and they are adversarial by
design — `lock-pid-reuse`, `lock-publication-race`, `lock-blocking-fifo`,
`lock-owner-liveness-classification`, `lock-release-confined`, `lock-hardening`
assert specific properties of the file-lock protocol.

### Why `lock.ts` is not interchangeable with an advisory lock

The plan's own words are "the PID lockfile (~two-lock reclamation)", which reads
like a simple file. Its header says otherwise: fresh acquisition publishes the
owner record create-only via a scratch leaf plus link, *"because the staleness
predicate treats an unreadable owner as reclaimable and would let a contender take
the lock away from a live process mid-acquisition"*, and reclamation is a
four-step protocol under a second lock (`src/utils/lock.ts:1-25`).

A Postgres advisory lock gives mutual exclusion but **not** the liveness
classification the reclamation protocol exists for. Deciding whether the current
holder is a live process or a corpse is a question about a PID, and a table of
holders cannot answer it without a heartbeat column and a clock. That is not
disqualifying — it is the actual design work, and why this cannot be a mechanical
port.

### The journal's real coupling

`replayJournal` is the crash-recovery seam, run on startup at
`src/trust/executor.ts:169`. What it replays is a filesystem record:

```ts
// src/trust/journal.ts:92
export interface JournalEntry {
  readonly targetPath: string;   // ABSOLUTE PATH
  readonly preState: PreState;   // what existed at that path
}
```

`targetPath` is an absolute filesystem path, and `JournalBatch` carries `root`
(`journal.ts:103-107`). So the journal cannot move to a table independently of
L1/L2: its identity model IS the filesystem. Second reason the ordering must be
L2 → L3 → L1 rather than by wave number.

### What is measured and what is not

Measured: seam counts above; the journal record shape; the replay call site; the
path constants (`EXPORT_DIR = "dist/exports"`, `SOURCES_DIR = "sources"`,
`CONCEPTS_DIR = "wiki/concepts"`, `QUERIES_DIR = "wiki/queries"` at
`src/utils/constants.ts:162-167`); and that `saveSource` has exactly two
non-comment call sites.

Both items previously listed as NOT measured are now measured, and both changed a
conclusion:

| Item | Measured | Effect on the plan |
| --- | --- | --- |
| `atomicWrite` call sites in `src/compiler/` | **7**, all compile STATE | L2 is one chokepoint, not 10 modules |
| Tests referencing compiled pages on disk | **206** files | L2's real cost is read-side blast radius |
| `atomicWrite` files across `src/` | **69** | T7 is much larger than L2; keep them decoupled |
| Page-write chokepoint | `applyCompilePageWritesLocked`, **5 callers** | the whole write path is one function |

A delegated exploration was launched for these and returned a fragment of its own
reasoning rather than a report, so it contributed **no** evidence; every figure
above was produced by the parent with the command quoted beside it. That is the
second time a delegated report on this plan proved unusable, which is why the
parent-measures rule is stated at the top of this section rather than buried.

## Non-goals

- No `stacks` table rename. It is KG-side DDL, no role here may write it, and the
  code already uses the name.
- No change to the KG dimension's own storage.
- No HTTP client in the compiler.
- No preserved offline mode. That is the accepted cost of this decision and it
  belongs in the release notes rather than in a hedge here.

## Evidence log

- **This document.** Written from source reads and measured commands only. No
  product code touched: the whole plan lands on `shared-read-only` seams, so its
deliverable is the measurement and the breakdown, not an implementation.
- **A delegated exploration produced no usable evidence.** It was launched for the
  per-module call-site counts and returned a fragment of its own reasoning
  (`Now let me search for files that import node:fs...`) instead of a report. Every
  figure in `## Measurement — results` was therefore produced by the parent with
  the command quoted beside it. This is the second delegated report on this plan to
  prove unusable, after the two confident false claims the Wave 1 notes record.
- **Two of my own figures were wrong and were corrected, not quietly replaced.**
  L2 was first written as "ten file-writing modules"; the real shape is ONE write
  chokepoint with 5 callers, plus 7 `atomicWrite` calls that write compile STATE.
  The `atomicWrite` file count was 46 under a narrow pattern and 69 under the right
  one. The `root: string` count in older documents (1459) is 1461 today.
- **Numbers re-verified in this worktree**: 52/79 lock, 25/35 journal, 69/21
  atomic-write, 102 `node:fs` importers, 1461 `root: string`, 206 test files
  touching compiled pages, 5 callers of `applyCompilePageWritesLocked`, and the
  `JournalEntry` shape at `src/trust/journal.ts:92`.
- **Bootstrap check**: `npx tsc --noEmit` exit 0 at `4f9752c` before this work, and
  exit 0 after the wiki entry-point change in `5210027`. This document adds no
  code, so it changes neither.

## What the human must decide before T4 and T5 start

Two decisions are not the executor's to make, and both block the risky half:

1. **Lock liveness.** An advisory lock excludes; it does not classify a holder as
   alive or dead. Choose either a `lock_holder` table with `heartbeat_at` (closer
   to today's semantics, more moving parts) or a timeout (simpler, changes what a
   crashed process means for a waiting one). Six adversarial test suites encode
   today's answer.
2. **What a journal target IS once pages are rows.** `JournalEntry.targetPath` is
   an absolute path today. If pages become `(stack_id, page_directory, slug)`, the
   pre-state snapshot must be a row image rather than a file image, and the
   revert path changes with it. This cannot be designed before T2 lands.

Until both are answered, T1–T3 are safe to schedule and T4–T7 are not.

### T6 status (measured)

| Step | Commit | State |
|---|---|---|
| Tables | `39cbbab` | done |
| Row store | `8200361` | done |
| Detection by query | `acff82c` | done |
| Writer writes rows | `2db3edf` | done |
| Extraction reads rows | `2db3edf` | done |

Two ends are wired and agree: detection hashes a key, extraction reads by that same
key. Five disk reads were removed from the compile path by hashing content already in
memory.

**Writer runs on every ingest, including a no-op file write.** The two stores start
empty relative to each other: a project migrating in has files but no rows, so
skipping the row when the FILE was unchanged would leave the compiler seeing an empty
Stack and retiring every document.

#### Remaining before `sources/` can be deleted

1. **Rule extractor** (`extractRuleCandidates` -> `changedSources` -> `extractForSource`
   -> `readFile`). No `db` anywhere in that chain; single caller `commands/rules.ts:64`.
2. **Citation validation** (`linter/rules-citations.ts:115`) does
   `path.join(sourcesDir, filename)` and reads the file to count lines. Found during
   T6, not in the original W4 map. It is the review path.

### T6 closed — decision (2026-02)

T6 is closed with `sources/` still on disk. The COMPILE path no longer needs a
directory; other paths still do. That split is deliberate, not a postponement.

#### What reads rows now (compile path)

| Stage | Commit |
|---|---|
| Ingest writes a row | `2db3edf` |
| Change detection lists rows | `acff82c` |
| Extraction reads a row | `2db3edf` |
| Rule extraction reads a row | `fb03607` |

Verified pairing: detection hashes a key and extraction reads by that same key.
A test reads from root `/nonexistent-root` to prove no directory is consulted.

#### What still reads `sources/` — measured

29 files reference `SOURCES_DIR`. The ones that read CONTENT, and so genuinely
block removal:

| File | disk reads |
|---|---|
| `src/mcp/resources.ts` | 6 |
| `src/eval/citation-support.ts` | 5 |
| `src/linter/rules-citations.ts` | 4 |
| `src/freshness/index.ts` | 3 |
| `src/eval/source-utilization.ts` | 3 |
| `src/eval/candidate-evidence.ts` | 2 |

#### Why citation validation is its own job, not a T6 step

`checkBrokenCitations` validates `^[file.md:42-58]` spans by reading the cited file
to count its lines. It cannot do that once bytes are rows.

The blocker is structural, not mechanical:

```
type LintRule = (root: string) => Promise<LintResult[]>
```

The signature carries no `db` and no options, and ~15 rules are registered in an
array of that shape. Threading a source reader means changing the shared `LintRule`
type and every entry, or opening a handle inside the rule itself.

It is also the REVIEW path, not compile. Wiring a compiler seam and redesigning the
linter contract are two concerns; mixing them would put an unrelated interface
change in a storage commit.

Semantics to preserve when it is done: a citation names a FILENAME, so the lookup
must be `(stack_id, filename)` — not identity. That is only sound because the row
store now disambiguates basename collisions (`b412d1d`); before that fix, filename
was ambiguous and the lookup would have had no correct answer.

#### The guarantee that was lost and restored

`8200361` claimed the row store preserved every `saveSource` guarantee. It did not:
basename-collision disambiguation (#36) was dropped, so `alpha` and `Alpha!` both
became `alpha.md` in one Stack. Latent while the table is empty; a silent ambiguity
in every citation once populated. Restored in `b412d1d`, proven red-then-green.
