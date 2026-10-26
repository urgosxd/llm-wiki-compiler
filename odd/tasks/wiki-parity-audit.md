# Functional parity audit — Postgres wiki vs the filesystem wiki

Question: **does a Stack-backed project have every capability the filesystem project had?**

Method: every artifact constant in `src/utils/constants.ts` was paired with a table
in the live database, and its production references were classified as
*row-backed*, *file-only*, or *unwired*. Nothing here is inferred from DDL; the table
and column lists come from `information_schema` on the running database.

Reproduce:

```bash
docker exec -i llmwiki-kg-db-1 psql -U aks -d aks -tAc \
  "select tablename from pg_tables where schemaname='wiki' order by 1"
grep -rn "<CONSTANT>" src/ --include=*.ts | grep -v constants.ts
```

## Verdict

**No. Parity is not there yet.** Five capabilities that exist on the filesystem have
no row equivalent at all, and two more have storage that production never calls.

## 1. Full parity — row-backed in production

| Artifact | Table | Evidence |
|---|---|---|
| `.llmwiki/state.json` | `wiki.source_compile_state` | compile passes `stateRows` → `draft.flush(root, stateRows)` (`compiler/index.ts:907`) |
| `wiki/graph/events.jsonl` + `.llmwiki/events.head` | `wiki.event_log` | `appendEventToRows` / `readEventsFromRows` |
| `wiki/graph/relations.jsonl` | `wiki.relation_edges` | `appendRelationToRows` / `readRelationsFromRows` |
| `.llmwiki/rule-state.json` | `wiki.rule_extractor_state` | `readRuleStateFromRows` (just migrated, `4586f0b`) |
| pages | `wiki.pages` | `PageContentSource` / `resolvePageSeams` |
| `.llmwiki/lint-cache.json` | `wiki.lint_cache` | store exists; production reader is still file-gated (**see §3**) |
| `.llmwiki/pending-embeddings.json` | `wiki.embedding_refresh_marker` | store exists; production reader still file-gated (**see §3**) |
| frozen slugs / entities / prompt modifiers | `wiki.compile_config` | read AND written by `wiki-state-source.ts`, which is what `wikiStateRowsBackend` returns |

## 2. NO row equivalent — the wiki cannot do these on Postgres

**Four** artifacts, verified against `pg_tables` (14 tables in `wiki`, none of them
covers these).

| Artifact | Written by | Consequence |
|---|---|---|
| `.llmwiki/profile.json` | `profile/scaffold.ts:101`, `profile/templates/install.ts:197` | A Stack-backed project still writes its profile as a FILE. Decision 1 answered "per Stack"; that was never implemented. |
| `wiki/index.md` | `compiler/indexgen.ts:59` via `regenerateIndices` | `regenerateIndices` READS from rows but always WRITES the file. Decision 3 answered "rows"; not implemented. |
| `wiki/MOC.md` | `compiler/obsidian.ts:125` | Same as index — unconditional `atomicWrite`, no row branch. |
| `log.md` | `utils/activity-log.ts:123` | Unconditional `appendFile`. Best-effort (warns, never throws), so it fails **silently** on a read-only filesystem. |

> These four are **not** the `stackId === ""` fallbacks. Those at least have a row
> branch. These have no row path at all: a Stack-backed project writes files for
> them regardless.

### 2b. CORRECTION: quarantine DOES have rows — I was wrong

The first draft listed `.llmwiki/quarantined-embeddings.json` here. **That was wrong.**

`wiki.embedding_refresh_marker` carries
`state text not null default 'pending' check (state in ('pending','quarantined'))`, and
`markerStateOf()` maps the marker FILE to that column
(`pending-embeddings.ts:334`). Every access to the quarantine marker goes through
`readPendingMarker` / `writePendingEmbeddings`, which both dispatch to rows first, and
both take the marker file as a parameter. So the two markers are one table with two
states, and quarantine has **full parity**.

Unverified, it looked like a missing backend. Verified, it was already done. The probe
that settled it:

```
ROWS quar: [{"pageId":"concepts/poison","attempts":7}]
ROWS pend: [{"pageId":"concepts/live","attempts":1}]
FILES: none
```

Same mistake as §3b, different artifact: **a single `state` column does the work of
what looks like two tables, and grepping for a table named after the file will not
find it.** Check the DDL's CHECK constraints and the mapper before declaring a
backend missing.

A first probe reported `[]` and "no rows" for both markers. Both readings were wrong
and both had the same cause: the probe used `"quar-one"` as a page id, which
`isValidPageId` rejects, so `normalizeMarker` dropped the entry before any backend
saw it. The second reading — "0 rows in the table" — was the harness cleanup deleting
the Stack after the test ended. **A probe can fail for a reason that has nothing to do
with what it is measuring.**

## 3. Storage exists but production never calls it

| Table | Store | Status |
|---|---|---|
| `wiki.review_candidates` | `dimensions/wiki/candidate-store.ts` | **Only the test imports it.** Candidates still persist through `compiler/candidates.ts:254` (`atomicWrite`). Step 3 was storage-only and never wired. |
| `wiki.page_embeddings` / `wiki.page_chunk_embeddings` | `utils/embeddings-database.ts` | **CORRECTED — full parity.** See the correction note below. |

## 3b. CORRECTION: the embedding corpus IS wired

An earlier draft of this audit claimed the embedding store was file-only and that
`EmbeddingStoreSink` had no database implementation. **That was wrong**, and the
error came from grepping for the wrong identifiers:

- `databaseEmbeddingSink` and `databaseEmbeddingLocation` exist
  (`utils/embeddings-database.ts`).
- `writeEmbeddingStore` accepts a `sink` and dispatches to it
  (`utils/embeddings-store.ts:211,221`).
- Production wires the whole chain:
  `compiler/index.ts:1121` → `embeddingStoreLocation(db)` →
  `safelyUpdateEmbeddings(…, embeddingStore, …)` (`:913`) →
  `refreshEmbeddingsDrainingPending` (`utils/embeddings-refresh.ts:69`) →
  `updateEmbeddingsLockedCore(…, store, …)` → `writeEmbeddingStore(root, stamped, sink)`.

The grep that produced the false claim searched for `databaseEmbeddingSource` and
for `EmbeddingStoreSink` *implementations*, and missed that the pair is composed by
`databaseEmbeddingLocation` and passed down as one value. **A missing grep hit is not
evidence of absence** — the same mistake the audit was written to avoid.

## 3c. Storage that IS genuinely unwired

| Table | Store | Status |
|---|---|---|
| `wiki.review_candidates` | `dimensions/wiki/candidate-store.ts` | **Only the test imports it**, AND the table cannot hold a real candidate. See §3d. |

## 3d. The candidate store is not merely unwired — it is incomplete

Wiring `candidate-store.ts` as it stands would **silently lose five fields** that the
file backend persists (`compiler/candidates.ts:290-298` sets them; the store never
mentions them):

| Field | Column | Consequence if dropped |
|---|---|---|
| `candidateKind` | **missing** | `review-publication.ts:16` can no longer tell a validated answer from anything else |
| `citationManifest` | **missing** | `review-publication.ts:46` dereferences `candidate.citationManifest!.bodyDigest` to detect an edited answer. Without it, **the integrity check before publishing a reviewed answer has nothing to compare** |
| `connectorProvenance` | **missing** | one of the four signals `isConnectorCandidate` uses (`connectors/origin.ts:28`) and what `review-show.ts:106` displays |
| `confidence` | **missing** | display only (`review-show`) |
| `contradicted` | **missing** | `review/policy.ts:88` gates the `contradicted` review mode |

Present columns cover the rest: `review_mode`, `held_reasons` and `body` also feed
`isConnectorCandidate`, so the operator-pin control in `review-approve.ts:167` still
holds even without `connectorProvenance`. That is the one field loss that does NOT
weaken a security check — but only because three sibling signals survive.

So the work is **not** "call the store from production". It is: extend
`migration_wiki_candidates.sql` with the five columns, round-trip them in the store,
then wire it.

## 4. What this means for the migration order

The `stackId === ""` work I was about to continue is the *smaller* half. Removing a
fallback means "stop doing the file thing when you could do the row thing". Five
artifacts above have no row thing to switch to, so removing a fallback there is not
possible — the row path has to be **built** first.

Revised order:

1. **Build the missing row backends**: profile, index/MOC, log, quarantine.
2. **Wire the unwired stores**: `review_candidates`, embedding source/sink.
3. Then continue removing `stackId === ""` fallbacks (markers → seams → events).
4. Lock last.

Step 2 of the old plan ("wire Step 3 candidates to production") stops being a
cleanup item and becomes a prerequisite for deleting any candidate file path.

## 5. The gap this audit did not ask about: whole SUBSYSTEMS

This audit paired `src/utils/constants.ts` artifacts with tables. That question is
"does every FILE have a row?" -- and once the four missing backends were built
(`log`, `index`/`MOC`, `profile`, plus the quarantine correction), the answer became
yes for artifacts.

It was the wrong shape of question. The remaining 63 test files classified as
"genuine file semantics" are not testing artifacts, they are testing **subsystems**,
and four of them have no row path at all:

| Subsystem | Files | Files with any row seam |
|---|---|---|
| `src/preparations/` | 124 | **0** |
| `src/operation-bundles/` | 70 | **0** |
| `src/products/` | 27 | **0** |
| `src/artifacts/` | 16 | **0** |

(Measured by grepping each tree for any of the eight `with*Source` seams or
`AKS_STACK_ID`; zero hits in all four.)

### What that means for the 63 files

37 of the 63 (301 tests) import `src/preparations/` directly. They are not tests with
filesystem ASSUMPTIONS that could be rewritten -- they exercise a subsystem whose
implementation only knows how to write files. Rewriting the test would not help,
because there is nothing on the other side to call.

Note the shapes of records these subsystems keep: preparation runs, operation
bundles, product packages, artifact members. They are all MUTATION JOURNALS AND
MANIFESTS -- the same species as the trust journal (Decision 2: "no files"), which is
already parked for exactly this reason. `src/trust/journal.ts` is 675 LOC with 9
file-write call sites and no row seam.

### The cost of Decision 2, now measured

Before committing to rows for journals/manifests, the blast radius was measured. It is
an order of magnitude larger than the 63 files that raised the question:

| Subsystem | Files importing it in `test/` | Tests |
|---|---|---|
| `src/preparations/` | 236 | 1547 |
| `src/operation-bundles/` | 133 | 761 |
| `src/products/` | 37 | 204 |
| `src/artifacts/` | 39 | 200 |
| **Union (deduplicated)** | **389** | **2381** |

The suite total is 1380 files, so **389 of them — 28% — touch one of these four**.

The journal is not a bystander either: `src/trust/journal.ts` has 24 consumers in
`src/`, including `operation-bundles/lock-gate.ts` (the mutation gate), and
`trust/page-apply.ts` calls `recordPreState` twice. **The journal IS today's
revert mechanism for page mutations**, so migrating it is migrating the undo system
for everything that mutates.

#### What "no files" would actually require

Not "write the run state to a table". Each of these subsystems has a different
revert/recovery contract:

- `preparations` keeps RUN records with phase summaries, gate proofs, effect summaries,
  completeness records and handoff bindings (`run-types.ts`, 10+ `V1` interfaces).
- `operation-bundles` keeps a catalog, payloads and manifests with capacity caps.
- `products` keeps a binding plus an installed package.
- `artifacts` keeps a content-addressed body plus a sidecar manifest, defended by
  no-follow-leaf, parent-confined, capped reads and TOCTOU re-confirmation.

The safety machinery in `artifacts/store.ts` and `journal.ts` exists to make a
DIRECTORY behave like an identity, exactly like `candidate-custody.ts` did. Rows do
not need most of it -- but deciding WHICH parts become unnecessary is per-subsystem
work, not a shared refactor.

#### Recommendation before starting

Migrate ONE subsystem end to end and measure the real delta, rather than opening four
at once. `artifacts` is the smallest (39 test files, 200 tests) and its contract is a
content hash plus a manifest -- the closest analogue to what the wiki already does,
so it validates the shape of the work cheapest.

### Revised meaning of "done"

Artifact parity is achieved. **Subsystem** parity is not, and it is a much larger
piece of work than the remaining test adaptation:

1. The four subsystems above need row backends before their tests can go anywhere.
2. That is the same decision the journal is waiting on (Decision 2 — "no files"),
   so it should be made ONCE for journals/manifests generally, not four times.
3. Until then, the 63 files are not backlog in the sense the plan implied. They are
   correctly testing the only implementation that exists.

The honest status: the WIKI is on rows. The PREPARATION / OPERATION / PRODUCT / ARTIFACT
machinery around it is not, and calling those tests "the 63 remaining" hides that.

## Evidence limits

- Capability parity, not byte parity: a row-backed project round-trips the same
  data, but file *formatting* (key order, indentation) has no row analogue by design.
- `LOC` and reference counts are grep-derived and will drift; the table/column lists
  are queried live.

## The journal's real perimeter: 6 call sites, not 389 files

Decision 2 looked like a 389-file / 2381-test migration. It is not. The journal is
opened in exactly six places:

| Site | What it journals |
|---|---|
| `src/trust/executor.ts` | page writes (file backend only now) |
| `src/trust/lifecycle-apply.ts` | lifecycle steps |
| `src/artifacts/apply.ts` | artifact body + sidecar manifest |
| `src/artifacts/apply-members.ts` | member leaves (base64, budgeted) |
| `src/profile/templates/update-apply.ts` | template lock file |
| `src/wiki/delete-page.ts` | page delete |

The 389 files touch these subsystems, but only these six create pre-states. A
migrated backend at each site removes that site's journal use; nothing else in
those subsystems has to change for the journal to be gone.

### Why the transaction replaces the journal

A journal entry exists to restore PREVIOUS BYTES after a partial failure, because a
set of file writes is not atomic. A row write is already inside a transaction: the
all-or-nothing is the database's, not the journal's. So the row path does not need
a journal backend — it needs the journal to stop being opened. That is what
`9ba51a8` established for the page path, and the same argument applies at the other
five sites once their targets are rows.

Corollary: the journal is not "the fourth subsystem to migrate". It is the *last*
thing left standing, and it disappears site by site as each target becomes a row.
Its 675 LOC of no-follow/parent-confine/TOCTOU machinery is filesystem-as-identity
defence — the same species as `candidate-custody.ts`, which rows made unnecessary by
construction.

## Artifacts: measured cost, and why the first number was wrong

`vitest related src/artifacts/{store,apply,apply-members}.ts` reports **1475 files /
3336 tests**. That is not the cost of migrating artifacts. `vitest related` follows
the import graph, and `src/artifacts/*` is reachable from `core-index.ts`,
`compiler-cli.ts` and `sdk/core.ts`, so "related" sprawls to most of the suite.

The real figure, measured by running the files that actually import `src/artifacts/`
and touch the disk: **85 files / 226 tests, 0 failing**. This is the number to plan
against, and it is 17× smaller than the `vitest related` artefact.

Lesson for the other three subsystems: `vitest related` is right for judging blast
radius of an EDIT, and wrong for sizing a MIGRATION. For sizing, count the files that
import the subsystem and assert its storage.

### Where the filesystem actually is

Four files in a 17-file subsystem:

| File | FS sites |
|---|---|
| `apply-members.ts` | 11 |
| `apply-guards.ts` | 7 |
| `store.ts` | 4 |
| `resolve-members.ts` | 2 |

`resolve.ts`, `members.ts` and `read-verified.ts` read no disk at all; they delegate.
So the migration surface is four files, not seventeen.

### The four properties the directory gave for free

`store.ts` is filesystem-as-identity machinery: no-follow-leaf reads, parent-realpath
confinement, post-read TOCTOU re-confirmation. All of it exists because a directory is
an untrusted namespace. A row set is closed by construction, so each property becomes
an explicit behaviour with its own test (`artifact-store-rows.test.ts`):

1. **The set is closed** — primary keys, not a directory listing.
2. **A shrink leaves nothing behind** — the member set is REPLACED inside the same
   transaction as the insert (`apply-members` had to unlink "obsolete" leaves
   afterwards, where an unlink can fail while the batch still commits).
3. **Order is declaration order** — a member-bearing ref is a Merkle root folded in
   declaration order, so `position` is stored and read back, never re-sorted.
4. **Bytes are bytes** — `bytea`, never text.

### Divergence from the journal-first plan

`src/artifacts/` has **zero** Stack awareness today, so sites 4 and 5 are not hiding a
live defect the way `executor.ts` and `delete-page.ts` were. This is pure migration,
and it costs more than the two bug fixes did.
