# Plan: the wiki lives in Postgres, one Stack at a time

This is the CURRENT plan. `multi-tenant-stack-only.md` is now the measurement and
correction log behind it — read it for evidence, not for sequence.

## The goal, stated so it can be checked

Two properties, each independently verifiable:

1. **No filesystem.** A wiki command works with `wiki/`, `sources/` and `.llmwiki/`
   deleted, against a reachable database.
2. **Multi-tenant by StackId.** Two Stacks in one database never see each other's
   rows, enforced by the database, not by the application remembering a filter.

A step is done when a test proves it by using a root that has no such directory —
"the directory happened to exist" must not be able to make an assertion pass.

### How property 2 is proven today

The dangerous way to "prove" isolation is to test the dimension's own reads: those
carry an explicit `where stack_id = ...`, so they pass whether or not RLS works. The
suite that exists does the opposite — it issues a RAW query with no stack predicate
as `llmwiki_app`, an unprivileged role, and asks whether the database alone stops it.

That matters because the shared pool connects as `aks`, which is SUPERUSER **and**
BYPASSRLS; every policy is invisible from there. Both suites pass (7 tests:
`wiki-stack-isolation` 3, `kg-rls-tenancy` 4), and a mutation that drops the policy
turns them red while removing the explicit predicate does not — which is the correct
result: the wiki is protected twice and neither layer is load-bearing for the other.

## Scoreboard

Sixteen tables carry wiki and graph state, every one with `stack_id` and
RLS enabled AND forced. Measured against the live database, not inferred
from the DDL:

```
wiki.pages                      wiki.source_documents
wiki.concept_aliases            wiki.source_compile_state
wiki.page_embeddings            wiki.embedding_store_meta
wiki.page_chunk_embeddings
+ 9 graph tables (stacks, stack_documents, document_chunks,
  ontology_entities, ontology_relationships, entity_source_documents,
  entity_pages, backfeed_queue, ingest_outbox)
16 tables · 16 with RLS forced · 0 without
```

### Done

| Capability | Where it lives now | Proof |
|---|---|---|
| Raw documents | `wiki.source_documents` | change detection by query |
| Compiled pages | `wiki.pages` | compile reads AND writes rows; no file written |
| Page identity | `(stack_id, page_directory, slug)` | registry answers from rows, takes no root |
| Embeddings + chunks | `wiki.page_{,chunk_}embeddings` | compile persists, search reads |
| Ingest outbox | `ingest_outbox` | per-Stack rows, not per-project files |
| Mutual exclusion | `pg_advisory_lock` | cross-process test with a real child |
| Tenant isolation | RLS policy on all 16 | raw predicate-free query as `llmwiki_app` |
| Search / query / MCP | rows via one seam | four entry points wired |
| Index / MOC | derived from rows | content from rows, artifacts still written |

### Remaining, measured

Every row below is state that is still a FILE today. `Files` counts source files
that reference the constant.

| # | Artifact | Files | Why it is still a file | Blocking? |
|---|---|---|---|---|
| A | `state.json` | 6 | **Half-migrated**: the per-source hashes already live in `source_compile_state`; `frozenSlugs` + `promptModifiers` do not have a home | no |
| B | `relations.jsonl` | 4 | Typed graph edges + hash-chained event log | no |
| C | `events.jsonl` | 4 | Append-only event chain with `prevHash` | no |
| D | `candidates/` | 9 | Review candidates before approval | no |
| E | `pending-embeddings.json` | 4 | Marker for a partially-written store | no |
| F | `profile.json` | 7 | Product authority + template install | **yes — see Decision 1** |
| G | `last-lint.json` | 4 | Lint result cache | no |
| H | `rule-state.json` | 2 | Rule extractor position | no |
| I | `journal` | 24 | Pre-state snapshots for revert | **yes — see Decision 2** |
| J | `lock` | 6 | Superseded by the advisory lock; file is the fallback | no |
| K | `wiki/index.md`, `wiki/MOC.md` | — | Deliberately still written: a browsing human and the OKF bundle read them | **see Decision 3** |

That is **10 artifacts and 46 file references** to their path constants
(`grep -rl <CONST> src/ --include=*.ts | wc -l`, summed). The number is the point:
this is finite and enumerable, not open-ended.

## The sequence

Ordered by (value delivered) ÷ (risk carried), not by layer.

### Step 1 — `state.json` → rows (A) — **STORAGE LAYER DONE**

> Landed: `wiki.compile_config` (new table, RLS forced), `source_compile_state`
> widened to carry the fields it was missing, `compile-config-store.ts`,
> `wiki-state-source.ts`, and an optional row backend on `CompileStateDraft`
> (`load`/`flush`). 244 tests in `test/dimensions/`, `tsc` 0, build 0, zero
> regressions. What remains is flipping the DEFAULT for a Stack-configured project
> and deleting the file path.
>
> Two corrections to the sizing below, both measured:
> 1. `source_compile_state` was NOT "already modelling" this — it held 5 columns for
>    an 8-field shape and had **zero rows and zero TypeScript references**. It was
>    dead DDL. It is now widened (`extraction`, `entities`, `output_language`,
>    `source_ref`) and used.
> 2. "Three callers" counted the seam, not the consumers: ~20 modules read
>    `state.sources[...]`. That is fine, and is the reason the seam is where it is —
>    they all read the in-memory `WikiState`, so only `load` and `flush` changed.

The cheapest win and the one that removes a whole class of bug. The hash bookkeeping
is already in `source_compile_state`; what is missing is a home for `frozenSlugs`,
`frozenEntities` and `promptModifiers`. One new table
(`wiki.stack_compile_config`, `(stack_id)` primary key) and `state.ts` becomes a
reader/writer over it.

Measured size: `readState`/`writeState` have **three** real callers outside the
module (`review-approve`, `recover`, and the compiler pipeline), and `indexHash` — the
one field with no obvious column — is neither read nor written to make a decision
anywhere; it exists only in the type and in validation. So the migration is smaller
than the field list suggests: two coordination fields need a column, one field can go.

Why first: `state.json` is read by freshness, lint, view, export and the MCP server.
Removing it removes the last reason any of them needs `root` for state.

Verification: a compile against a root with no `.llmwiki/` produces identical
freshness and stale-refresh decisions.

### Step 2 — `relations.jsonl` + `events.jsonl` → tables (B, C) — **STORAGE LAYER DONE**

> Landed: `wiki.event_log` and `wiki.relation_edges` (RLS forced on both),
> `event-log-store.ts`, `relation-edge-store.ts`, migration `migration_wiki_graph.sql`.
> 258 tests in `test/dimensions/`, `tsc` 0, build 0.
>
> **The chain survives without line order.** A file got ordering free from byte
> position; a table needs it explicitly, so `seq` is a per-Stack gapless counter
> allocated as `max(seq)+1` inside a transaction holding the Stack's advisory lock.
> Two properties IMPROVE: two hosts appending to one Stack's file each held their own
> copy and forked the chain silently, and a crash could leave a torn tail. Neither is
> possible now. `.llmwiki/events.head` becomes unnecessary — a committed row IS the
> seal the head anchor existed to represent.
>
> **The checksum guarantee is reused, not reimplemented**: `eventChecksum` and
> `recordChecksum` come from the same modules the file path uses, so a row and a line
> describe a record identically. Asserted, including a tampering test.
>
> **The dedup key is preserved exactly**: endpoints + type + `contentHash`, with
> evidence inside `contentHash`. An edge that GAINS evidence is a separate edge — the
> test asserts two rows, because collapsing them would lose provenance.
>
> Append-only discipline preserved by never deleting: compaction marks
> `superseded_by`, so a superseded edge still verifies and history stays readable.

Do them together: an edge and the event that recorded it must land in one
transaction, or a crash can leave a relation with no provenance. Both already carry
`stack_id`-shaped identity (`relationType`, endpoints, evidence) and a hash chain.

Why here: this is the GRAPH of the wiki — the thing `relate`, `query --typed` and the
viewer depend on. It is also the last big read that takes a `root`.

Verification: the relation dedup key, the evidence fingerprint and the hash chain all
survive a round trip; replaying the event log reproduces the relation store byte for
byte.

### Step 3 — `candidates/` → table (D) — **STORAGE LAYER DONE**

> Landed: `wiki.review_candidates` (RLS forced), `candidate-store.ts`,
> `migration_wiki_candidates.sql`, plus `harness-lifecycle.ts` for the probe-stack
> setup three suites were copying. 269 tests, `tsc` 0, build 0, `fallow` 0 above
> threshold, zero regressions.
>
> **`candidate-custody.ts` (483 lines) is not migrated — it becomes unnecessary.**
> It exists to defend a filesystem store: bind a directory's `dev`/`ino`, refuse a
> symlinked leaf, detect parent drift, fail closed on a cross-device rename. A row
> has no inode and no parent directory, so every one of those properties holds BY
> CONSTRUCTION. That is the largest single block of code this plan deletes without
> writing a replacement.
>
> **What it fixes**: the file store was scoped to a CHECKOUT, so two hosts reviewing
> one Stack kept two queues and neither saw the other's candidates — a reviewer on A
> could approve work B had already superseded. Asserted by a cross-Stack test.
>
> **Parity is the hard part, not the schema**: `ReviewCandidate` distinguishes an
> ABSENT optional from an empty one and `review show` prints them differently, so
> every optional column spreads conditionally rather than assigning `undefined`.
> `expectTargetAbsent` is stored as a real boolean but only spread back when TRUE,
> preserving the omission.

Nine files touch candidate custody, and candidates are the review workflow's whole
durable state. A Stack-scoped table also fixes a real defect: candidates are
currently per-checkout, so two hosts reviewing one Stack see different queues.

Verification: a held candidate is visible from a second host on the same Stack, and
invisible from a different Stack.

### Step 4 — the small markers (E, G, H) — **DONE (storage + wiring)**

> Landed: `wiki.embedding_refresh_marker`, `wiki.lint_cache`,
> `wiki.rule_extractor_state` (all RLS forced), `marker-store.ts`,
> `migration_wiki_small_markers.sql`, and the seams in `pending-embeddings.ts`,
> `linter/cache.ts` and `rule-state.ts`. 282 tests, `tsc` 0, build 0, `fallow` 0
> above threshold, zero regressions.
>
> **The two embedding marker files became ONE table.** `pending-embeddings.json` and
> `quarantined-embeddings.json` had one shape (`{pageId, attempts}[]`) and differed
> only in what the list meant — retried versus aged out. A `state` column carries
> that without duplicating the schema, the readers and the caps.
>
> **Two no-op traps caught by asserting**: `clearPendingEmbeddings` unlinked a file
> and never touched rows (a settled id would stay queued forever), and
> `writeLintCache` ran an unconditional `mkdir` before the backend check, leaving an
> empty `.llmwiki/` on every Stack-backed run — the tell of a half-done migration.
>
> **`fallow` caught a duplicate export**: `marker-store` exported `readLintCache`
> and `linter/cache.ts` already did. Renamed to `readCachedLintResult`, because two
> exports with one name is how a caller imports the wrong one silently.

`pending-embeddings.json`, `last-lint.json`, `rule-state.json`. Each is one table or
one column. Grouped because separately they are not worth a review.

### Step 5 — `lock` fallback removal (J)

Keep the advisory lock; delete the file path once no project can be Stack-less. That
last condition is a product call (Decision 4).

**Keying is fixed; the fallback is not removed.** The advisory lock was keyed on
`realpath(root)`, so two hosts serving one Stack held different keys, both acquired,
and both compiled one corpus — the exact collision the lock exists to prevent. The key
now derives from `stackId` in one place (`lockKeyFor`) that acquire, release and the
FIFO all use. `releaseLock` also resolves under either key, because a `finally` block
or a test teardown does not carry the Stack environment acquire used.

**Why the file path survives, measured.** Forcing the lock to require a Stack turned
**2017** tests red, all on `AKS_STACK_ID is not set`: 26 `stackId === ""` gates remain
across 12 modules, so the code it guards is still legitimately Stack-less.

### Markers: measured one at a time

| Marker | Gates | New failures if forced | Outcome |
|---|---|---|---|
| `compiler/rule-state.ts` | 1 | **11** in 4 files | **Done** (`4586f0b`) |
| `linter/cache.ts` | 2 | **79** in 22 files | Reverted |
| `utils/pending-embeddings.ts` | 1 | not yet measured | — |

`rule-state` was cheap because its four suites touched one seam and a shared
fixture (`useTempRoot`) accepted a Stack with no test redesign. `linter/cache` is
expensive for the opposite reason: lint runs inside viewer, host and e2e flows, and
22 files assert `.llmwiki/last-lint.json` by name. Forcing it deletes assertions
rather than adapting them.

The lesson is not "markers are safe". It is that **cost tracks how many suites assert
the file**, not how many gates a module has. Measure each marker before touching it.

Test scaffolding added: `test/fixtures/stack-env.ts` with `withStackEnv` (wrap one
body) and `useStackEnv` (whole file). Both snapshot and restore `process.env`,
because a Stack left installed makes an unrelated suite run against it.

### Class B: tests that read the candidate file directly

**27 files.** These do not need a fixture change — they need rewriting, because they
read `.llmwiki/candidates/<id>.json` themselves and assert the bytes. Forcing the
rows path turns each into an ENOENT rather than a semantic failure.

Each was classified by asking one question: *is the property under test a property of
the CANDIDATE, or of storing one candidate per FILE?*

| File | Cases now | Portable to rows | Why the rest cannot move |
|---|---|---|---|
| `eval-candidates` | 11, **all green on rows** | 11 | 2 removed as unrepresentable (below); the queue itself is now read from rows |
| `candidate-id-safety` | 15 | 5 | 10 are filename properties: reserved stems, ASCII-case aliases, filename/id disagreement, legacy collisions |
| `answer-candidate-rejection` | 8 | 3 | 5 are symlink and file-race guards |
| `candidate-identity-binding` | 7 | **0** | all 7 assert a filename disagreeing with its embedded id; `toCandidate` derives `id` from the column, so the state is unrepresentable |

Two removals inside `eval-candidates`, with reasons rather than convenience:

- *"skips a valid record copied under a different file id"* — the primary key makes
  two records under one id unrepresentable.
- *"assesses a record with an unknown target directory"* —
  `review_candidates_target_directory_check` refuses `'elsewhere'` at the boundary.

Both properties are now **enforced**, which is stronger than being tested as
tolerated.

`candidate-identity-binding` is the clearest case of a suite that dies with its
backend rather than needing a rewrite: every one of its seven cases plants a file whose
name and embedded id disagree, then asserts the refusal. A row stores one id in one
column, so "disagreement" cannot be constructed. That is not lost coverage — it is a
class of bug the old design had to defend against and the new one cannot have.

#### Two real defects found by asking the portability question

Neither was reachable by reading code; both needed a test that ran on a Stack.

1. **`eval/candidates.ts` assessed an always-empty queue.** `collectPending`
   inventoried `.llmwiki/candidates` with `resolveConfinedCandidatesDir` +
   `listCandidateFileIds`. On a Stack-backed project that directory does not exist,
   so `evaluateCandidates` reported zero candidates forever. Fixed by reading the
   seam. `5e9be62`
2. **`review reject` reported a hostile id as absence.**
   `loadRejectableCandidateOrFail` short-circuits to a rows lookup and that branch
   skipped `assertWritableCandidateId`, so `review reject ../outside` printed
   "Candidate not found" instead of raising `UnsafeCandidateIdError`. Nothing was
   corrupted (a row is addressed by a bound parameter) — the diagnosis was wrong,
   which is still a defect because it hides a caller error as a missing record.
   `1deed03`

A third property that survived and is now pinned on rows:
**slug hardening** (`36b7898`). Traversal, separator, deep-traversal and oversized
slugs are refused before anything is persisted. Mutation-verified: bypassing
validation on the rows path turns 4 of 5 red while the safe round trip stays green.

### Probe: 1 store, 431 new failures (reverted)

Made `events/store.ts` require a Stack and ran the suite.

| Metric | Baseline | After 1 store |
|---|---|---|
| Failing tests | 79 | **510** |
| Files with new failures | — | **121** |

The graph stores are **not leaves**. Five modules emit events
(`trust/lifecycle-apply.ts`, `relations/store.ts`, `artifacts/apply-guards.ts`,
`connectors/run.ts`, `connectors/audit.ts`) and every mutation path runs through them.
Emitters are **blocking**, so a mandatory audit event drags its whole caller into
needing a Stack.

Two consequences for the plan's ordering:

1. **Events go last, not first.** The leaf-first order below was wrong: it put the
   most transversal store at the head of the queue.
2. **CI cannot cover it.** `.github/workflows/ci.yml` runs `npm test` with no Postgres
   service and dimension tests use `skipIf(!harnessReachable)`. Forcing a Stack in a
   transversal path does not move that coverage to CI, it deletes it. 113 of the 121
   newly-failing files run in-process, so no inherited environment fixes them.

> **The remaining fallbacks are one product decision, not twelve independent chores.**
> "May a Stack-less project compile?" has to be answered before any of them moves,
> because the answer determines whether CI keeps testing 113 files.

### Not scheduled without a decision

- **F — `profile.json`.** Decision 1.
- **I — `journal`.** Decision 2.
- **K — `index.md` / `MOC.md`.** Decision 3.

## Decisions — ANSWERED (2026-02)

| # | Question | Answer | Consequence |
|---|---|---|---|
| 1 | Is the profile global, per Stack, or both? | **Per Stack** | `profile.json` becomes a Stack row; a template upgrade is a per-tenant migration |
| 2 | What does "revert" mean when three of four journal targets stay files? | **No files** | The three non-page classes must ALSO stop being files before the journal moves — so the journal is last, not merely parked |
| 3 | Do `index.md`/`MOC.md` become rows, files, or disappear? | **Rows** | They stop being written as files; the viewer and the OKF bundle read rows |

Decision 2 does not pick between the two candidate journal shapes — it removes the
need for a hybrid. With no file targets left, the journal has ONE target class and
the polymorphic shape collapses to a row identity. That is a real simplification, and
it reorders the plan: the journal is now gated on Steps 1–4 plus the artifact/profile
migrations, not on a design question.

## Decisions the human owns — original text, kept for context

`profile.json` declares the product's entity types, relation types and workflows. Two
Stacks serving two products need different profiles; but a Stack is also just a
tenancy boundary, and forcing every Stack to carry a full profile copy means a
template upgrade becomes a migration across every tenant.

This is a product question, not an implementation one.

### Decision 2 — What does "revert" mean when three of four journal targets stay files?

The journal records a target's PREVIOUS BYTES so a crash can restore them. Its four
target classes are: artifact bytes+manifest, artifact binary members,
`TEMPLATE_LOCK_FILE`/`PROFILE_FILE`, and pages. Only the last is (or will be) a row.
A row has no previous bytes to snapshot, so a page journal entry cannot exist in the
same form.

Until this is answered, the journal cannot move. Two candidate shapes:

- **Polymorphic target**: an entry is either a path or a `(stack_id, directory,
  slug)` tuple, with one recovery pass dispatching on the discriminator.
- **Two journals**: a file journal and a row journal, with recovery over both in a
  defined order.

Both require re-specifying `journal.ts`'s confinement contract — 13 uses of
`confineUnderRoot`/`isInsideDir`/`safeRealpath`, and 9 of 35 test files deliberately
record paths that ESCAPE the root because refusing them is the property under test.

### Decision 3 — Do `index.md` and `MOC.md` become rows, files, or disappear?

They are the only two artifacts that are genuinely derived AND genuinely read by a
human or an external bundle. Options: keep writing them as an export (current), give
them their own table, or drop them and let the viewer render from rows.

### Decision 4 — May a Stack-less project still compile?

Today `LLMWIKI_DIMENSIONS` unset yields a file-backed wiki. Every remaining fallback
in this plan exists for that project. Making Postgres mandatory deletes ~half of the
remaining work and is a release-note-level product change.

## What is NOT in scope, and why

- **Deleting `atomic-write.ts`.** Measured: 49 call sites across 19 modules, 26
  passing `confineRoot`, 12 `durable`, 1,072 lines, 13 test files. Exactly **one**
  call site writes a page. It is the project's durability primitive, not a page
  writer. The page case has already moved; the module stays.
- **Renaming the `stacks` table.** It is KG-side DDL and the code already uses the
  name.
- **Rewriting `root: string` (1,458 occurrences).** Breadth, not depth; each site is
  mechanical and must be converted per-seam, when its artifact moves.

## Known defects, recorded and unfixed

1. **The lock keys on resolved PATH, not Stack.** Two checkouts of one Stack both
   acquire, which is the cross-machine collision the advisory lock exists to prevent.
   Fix: key on `stackId` when configured, path only for the file fallback.
2. **A Stack-configured project without `AKS_DATABASE_URL` silently uses the file
   lock**, because `databaseUrlFor` requires both variables while `config.ts` already
   defaults the DSN.
3. **A row-only page batch opens and commits an EMPTY journal.** Noise, not damage.
