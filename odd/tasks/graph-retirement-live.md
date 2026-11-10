# graph-retirement-live — make the dead retire path live

**Branch:** `fix/graph-retirement-dead-path`, cut from `main` at base commit `5a31842bfa788971de757ba62b322cf94118696b`.
**Scope:** this slice turns graph retirement on for non-review compiles and keeps it off for review compiles.

## Specs

### S1 — a non-review compile retires a deleted source exactly once

**Requirement (manager, verbatim):**

> Non-review mode retires exactly once. RED today: it retires nothing. `expected [] to have a length of 1`.

### S2 — a review compile retires NOTHING, and that is a guard against the fix itself

**Requirement (manager, verbatim):**

> Review mode retires NOTHING. This is not a preserved behaviour — nothing works there today. It is a **guard against your own fix**: `forgetDeletedSources` sits inside the same `if (!options.review)` guard as `markDeletedAsOrphaned`, and a careless early capture can move the retire call outside that guard and start deleting graph documents the wiki is still serving. The code's own comment says why: *"a held-back run must not retire documents the wiki has not stopped serving yet."* Write the test so that hoisting the call out of the guard fails it.

**Why this S must fail a mutation:** the mutation to demonstrate is the **two-step** one — first hoist the identity capture above the `if (!options.review)` guard, then move the retire call out of it — and **not** the single-step hoist of the retire call alone. Once the capture lives inside the guard (the shape `S5` prescribes and `L4` records as adopted), the captured identities do not exist at the call site until the capture is hoisted too, so the single-step move does not compile. A mutation that does not compile proves nothing about a test: a type error is not a red assertion, and pinning "we moved a line and tsc complained" as evidence would launder a build failure into a behaviour claim. `T6` therefore demonstrates the two-step mutation, and `S2`'s test must go red **at an assertion**, not at `tsc`.

### S3 — the already-absent source path neither retires twice nor throws

**Requirement (manager, verbatim):**

> Also cover the `orphan.ts:54` early-return path (source already absent) — it must not retire twice or throw.

### S4 — the helper's docstring is corrected, because the wrong docstring is why this survived

**Requirement (manager, verbatim):**

> The helper's docstring at `:1475` (`@param state - State BEFORE this run, which still holds the missing sources`) is **factually wrong about its argument**. Fix the docstring as part of the change, because a wrong docstring is what let this survive two verifiers.

### S5 — identities are captured before the live state is mutated

**Requirement (manager, verbatim):**

> Capture the deleted sources' identities **before** `markDeletedAsOrphaned` mutates the live state, and have `forgetDeletedSources` consume the captured identities instead of reading live state. That is the shape the previous lead proposed and it is the one to start from — **verify it against the code rather than adopting it**, and say if a different shape is correct.

### S6 — the upgrade is findable in one search

**Requirement (manager, verbatim):**

> **CHANGELOG**: one bullet stating that graph documents for deleted sources are now actually retired, that they were not before, and why (the state was mutated before it was read). An upgrade that starts deleting rows must be findable in one search.

### S7 — the new deletion is proven, not asserted

**Requirement (manager, verbatim):**

> **A base-vs-head differential** on a real database: run the same delete-then-compile scenario against a `git archive` of the base and against your tree, and show what differs. If the only difference is the rows now being removed, say so; if there is any other difference, that is a finding.
>
> **Prove the tenant boundary holds**: retirement must only touch the named Stack's rows. Assert it, do not assume it.

**Measured facts to reuse** — re-derived at base `5a31842` with the commands quoted, because the brief's own figures were partly stale and one of them was wrong:

- **Retirement is one statement.** `packages/llmwiki-kg/ts/src/core/document-consolidation.ts:563` declares `forgetDocumentRows`, and its whole body is the template at `:568`–`:571`: `delete from stack_documents`, `where stack_id = ${stackId} and storage_path = ${source}` — that is `$1 = stackId`, `$2 = source` in the placeholder form the brief used. Measured: `git grep -n 'forgetDocumentRows\|delete from stack_documents' -- packages/llmwiki-kg/ts/src/core/document-consolidation.ts` (exit 0). There is **no `returning` clause and no affected-row count**, so a differential cannot read the number of retired rows out of this call: it must query `stack_documents` before and after.
- **The Stack comes from `options.stackId`.** `packages/wiki/src/dimensions/kg/index.ts:463` declares `deleteGraphRows(options, source)` and `:473` is the call that binds the tenant: `await forgetDocumentRows(tx, options.stackId, source)`; the `forget` seam reaches it at `:726`. Measured: `git grep -n 'deleteGraphRows\|options\.stackId' -- packages/wiki/src/dimensions/kg/index.ts` (exit 0). The scoping is a `where stack_id = $1`, so the tenant boundary is enforced in the statement itself, not by a caller-side filter — but that is where `S7` asserts it, not where it is assumed.
- **The child tables that cascade from `stack_documents(id)` — CORRECTION to the brief.** Measured: `awk '/references stack_documents/ {printf "%d: %s\n", NR, $0}' packages/llmwiki-kg/db/schema.sql` returns exactly three: `packages/llmwiki-kg/db/schema.sql:82` (`document_chunks.document_id`), `:210` (`entity_source_documents.document_id`), and `:532` (`kg_evidence.document_id`). The brief named `document_chunks`, `entity_source_documents` and **`entity_pages`**, and the third is **wrong**: `entity_pages` (`schema.sql:227`) cascades from `ontology_entities(id)` (`:228`) and `stacks(id)` (`:229`), never from `stack_documents`. Retirement removes `stack_documents` rows and, by cascade, chunk, evidence and entity-provenance rows; it does **not** remove `entity_pages` or `ontology_entities` rows. That is consistent with the design comment at `entity_pages` (`:223`–`:226`) — pages are a cache invalidated implicitly by `graph_version` — but it means a differential must state which tables it measured, and a reader expecting `entity_pages` to shrink is looking at the wrong table. The brief's list is corrected here so `T7` does not assert on a cascade that does not exist.

### S8 — gates

**Requirement (manager, verbatim):**

> `gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` · `lint` (**zero headroom**: literal `566 baseline violations in 402 files across 429 rule/file entries`; **`lint:update` is forbidden**) · `fallow:ci` · `fallow:kg` · `build` · **the artifact tier is `vitest run test/artifact` — `package.json` has no `test:artifact` script, do not cite one** · **`pnpm test` alone**. Known flake: `test/main-subcommand-flags.test.ts:147` SIGTERM — name it if it appears, do not absorb it.

## Tasks

- [x] T1 — author this feature document — S: none — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T2 — RED: write the two retire tests plus the already-absent coverage in `test/compiler/graph-retirement-retires-source.test.ts`, observe and record the failing assertion — S1, S2, S3 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T3 — GREEN: capture identities before orphaning and make `forgetDeletedSources` consume them — S5 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T4 — correct the `forgetDeletedSources` docstring — S4 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T5 — CHANGELOG bullet — S6 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T6 — prove the mutation fails S2's test, then restore — S2 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T7 — base-vs-head database differential and tenant-boundary assertion — S7 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T8 — run every gate and record each exit code — S8 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2
- [x] T9 — pin the tenant boundary as a committed DB-backed test (`graph-retirement-tenant-scope.test.ts`), prove it non-vacuous by mutation, and correct the CHANGELOG bullet for the deselected-source path — S6, S7 — route: gentle-ai-worker — commit: 9c636d32ccc1fcc66771911c050f06c5b85100d2

## Log

**L1 (manager assignment, verbatim)**

> Project assignment for branch fix/graph-retirement-dead-path:
>
> Make a proven-dead data path live. Graph retirement has **never** retired anything through `compile`: the branch executes, resolves its dimensions, and then skips every source. The human has explicitly authorized turning it on, deferred to this slice, with the condition that review mode keeps retiring nothing.

**L2 (measured)** — re-derived at base `5a31842bfa788971de757ba62b322cf94118696b` in `packages/wiki/src/compiler/index.ts`, because the brief's figures drift by slice. Commands: `awk 'NR>=1140 && NR<=1210' packages/wiki/src/compiler/index.ts` and `awk 'NR>=1466 && NR<=1520' packages/wiki/src/compiler/index.ts` (both exit 0).

- `:1149` — `const state = draft.read();`
- `:1185` — `if (!options.review) {` — the guard opening; its body is `:1186`–`:1191`; its closing brace is `:1192` — `}`
- `:1186` — `await markDeletedAsOrphaned(root, buckets.deleted, draft, seams);` — the call that mutates the live state
- `:1189`–`:1191` — the retire call, opened as `forgetErrors.push(` and closing `);` at `:1191`:
  - `:1190` — `...(await forgetDeletedSources(root, buckets.deleted, state, db, env, dimensionsPort)),`
- `:1481` — `async function forgetDeletedSources(` — the declaration; its signature spans `:1482`–`:1488`
- `:1475` — `* @param state - State BEFORE this run, which still holds the missing sources.` — the docstring line `S4` states is factually wrong about its argument
- `:1499` — `const source = state.sources[change.file]?.source;` — the live-state read that always misses

The brief's `:1149` for `draft.read()`, `:1186` for the orphaning call, `:1190` for the retire call, `:1475` for the docstring and `:1499` for the lookup are all **correct at this base**. What the brief did not carry is `:1185`/`:1192` (the guard's exact extent, which `S2` and `L4` turn into a compile-level constraint) and `:1481` (the declaration, alongside the `:1475` docstring).

**L3 (measured)** — the three Step 1 answers, with their commands:

1. **The working tree is clean** at `5a31842`: `git status --short` printed nothing. `git branch --show-current` → `fix/graph-retirement-dead-path`; `git log --oneline -3` → `5a31842b` (head), `64430671`, `db9c7d12`. `odd/tasks/graph-retirement-live.md` did not exist (`ls` → `No such file or directory`), so this document is a create, not an edit.
2. **A Docker daemon is reachable**: `docker info --format '{{.ServerVersion}}'` → `29.7.2`. `docker ps` shows four running Postgres containers (`hardcore_borg:32802`, two `llmwiki-probe-kg-mcp-e2e-*` on `32818`/`32820`, `llmwiki-kg-db-1:5434`) plus `buildx_buildkit_multibuilder0`. **None of them may be adopted** for `T7`: `TESTCONTAINERS_REUSE_ENABLE=false` and freshly provisioned only, with the port read through `docker port <name> 5432/tcp`. That four containers are already live is exactly the false-green hazard the brief names.
3. **Nothing other than `forgetDeletedSources` reads `state.sources[...]` at or after the retire call line — `none`.** Measured `git grep -n '\.sources\[' -- packages/wiki/src/compiler/index.ts` (exit 0) returns exactly two hits: `:644` (`draft.read().sources[result.sourceFile]`, in the resolution phase, far above `:1190`) and `:1499` (inside `forgetDeletedSources`, excluded by the question). **`none`.** The wider census, measured with `git grep -n '\.sources\[' -- packages/wiki/src` (exit 0), also returns `compiler/deps.ts:94`, `:197`, `:295`, `:376`, `:417`, `compiler/extraction-phase.ts:193`, `:214`, `compiler/hasher.ts:135`, `:155`, `compiler/orphan.ts:53`, `compiler/rule-extractor.ts:242`, `compiler/rule-state.ts:71` (a write), `sources/removal-plan.ts:92`, `:129`, and `utils/state.ts:264` (a write), `:274` (the `delete` that causes the defect) — none of which sits at or after the call site in `compile`, and none of which reads a deleted source's entry there; they receive `state` through their own parameters on other phases. Two adjacent facts matter for `S5` and are recorded as measured, not inferred: `:1202` passes the same `state` object into `runExtractionPhases`, so the live reference keeps being consumed after retirement (which is why the fix must capture, not clone-and-substitute, the live state); and `orphan.ts:52`–`:54` is `const state = draft.read();` / `const sourceEntry = state.sources[sourceFile];` / `if (!sourceEntry) return;` — the `:54` early return `S3` names, which reads the entry before removing it and returns without removing when the entry is already gone.

**L4 (decision)** — the adopted shape is: **capture inside the `if (!options.review)` guard, immediately before `markDeletedAsOrphaned`, and have `forgetDeletedSources` take the captured identities instead of a `WikiState`.** Reason: capture and retire call then live in one branch, so the naive single-step hoist of the retire call alone cannot compile — the captured identities do not exist at its new site — which makes `S2`'s mutation necessarily the two-step hoist, and the two-step hoist is the only form that produces a real red assertion. The alternative shape (capture above the guard, call unchanged) was rejected because it hands the reviewer a mutation that fails at `tsc` and calls it proof. `T3` still owes the verification `S5` demands: confirm against the code that this is the correct shape at `:1185`–`:1192` rather than adopting it, and say so if it is not.

**L5 (prescribed reading)** — `odd/tasks/compile-port-threading.md`, cited by line so the next reader finds the original record without re-deriving it: `L22` at lines `297`–`307` (the defect, proven by object identity, with the `orphan.ts:54` unreachability argument and the "pre-existing since `a91774c9`" provenance); `L24` at line `318` (the human's closing ruling that `L22` stays unfixed in that slice and the retire path becomes its own feature with its own document and risk line); and `L25` item 2 at line `326` (review mode is a guard against the fix, not a preserved behaviour, written specifically to stop the obvious-looking shortcut). That document is **append-only and byte-untouched** by this slice; this file is its successor, not a rewrite of it.

**L6 (decision — human, relayed by the manager) — the test mode, because `S1`'s
prescribed no-database mode is impossible.** Recorded in substance: **Option A** — run
the new cases against `test/fixtures/kg-postgres.ts`, with **no `describe.skipIf`**, and
the brief's "no database" acceptance criterion **withdrawn**. The reasoning, kept
because it stops the shape being re-derived as a compromise: `AKS_STACK_ID` is a gate
on THREE things at once, not one — it selects the Stack, it flips every seam to
row-backed (so a file seed is invisible), and it turns on the Postgres advisory lock.
There is no environment where that variable is set and the database is not reached.
Option B (a `skipIf`) is out because a skipped case proves nothing and silent
skipability is already a recorded defect in this area; Option C (mocking the row and
lock seams) is out because C1's whole point is observation through the public
`compileAndReport` interface.

**L7 (measured) — `T3`'s Step-0 census, re-derived by the implementer, and the two
review-mode facts.** Commands and results, all at the base tree with `index.ts`
untouched:

- `git grep -n "state\.sources\|draft\.read()\|forgetDeletedSources\|markDeletedAsOrphaned" -- packages/wiki/src/compiler/index.ts` (exit 0) → `:644` (`draft.read().sources[result.sourceFile]`, resolution phase), `:1149` (`const state = draft.read();`), `:1186` (`markDeletedAsOrphaned(`), `:1190` (`forgetDeletedSources(`), `:1368`/`:1469` (declaration and a docstring mention of `markDeletedAsOrphaned`), `:1481`/`:1499` (`forgetDeletedSources` declaration and its live-state read).
- Reads of `state.sources[...]` at or after the `forgetDeletedSources(` call line, outside the helper: **none**. The only one at or after it is `:1499`, inside the helper.
- `buckets.deleted` is `changes.filter((c) => c.status === "deleted")` (`index.ts:397`), and `changes` gains deletions only from `findDeletedDocuments` (`hasher.ts:172`) / `findDeletedFiles` (`hasher.ts:185`), both `Object.keys(prevState.sources).filter(...)` — **one entry per state key, so the same file cannot appear twice**. The only later addition is `augmentWithAffectedSources` (`index.ts:1360`), which pushes `status: "changed"`. **The captured identity list therefore needs no de-duplication**, and none was added; two different entries naming one identity is still safe because `Dimension.forget` must be idempotent (`dimensions/types.ts:313`).
- The briefed no-database mode was **measured to be impossible**: with `AKS_STACK_ID` set and `AKS_DATABASE_URL=postgresql://aks:aks@127.0.0.1:1/aks`, `compileAndReport` returned `{ deleted: 0, busy: true, errors: ["Could not acquire .llmwiki/lock — another compile is in progress."] }` — `lock.ts` `databaseUrlFor` takes a Postgres advisory lock whenever a Stack is named. That is why `L6` withdrew the criterion.
- **Review mode's `result.deleted` is `1`, measured**, not assumed: a temporary probe asserting `expect(result.deleted).toBe(1)` in C2 **passed**. C2 therefore keeps the reach assertion.

**L8 (measured) — `T2`'s RED, in the corrected mode, with the run itself succeeding.**
Command: `corepack pnpm exec vitest run test/compiler/graph-retirement-retires-source.test.ts --maxWorkers=2`.
Verbatim excerpt:

```
 ❯ test/compiler/graph-retirement-retires-source.test.ts (3 tests | 1 failed) 212ms
   × graph retirement through compile > retires a deleted source from the graph exactly once 120ms
     → expected [] to have a length of 1 but got +0
   ✓ graph retirement through compile > retires nothing when the run is held back for review 32ms
   ✓ graph retirement through compile > retires nothing for a deleted source with no recorded identity 47ms

 FAIL  test/compiler/graph-retirement-retires-source.test.ts > graph retirement through compile > retires a deleted source from the graph exactly once
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ test/compiler/graph-retirement-retires-source.test.ts:202:21
    200|     expect(result.deleted).toBe(1);
    201|     expect(result.errors).toEqual([]);
    202|     expect(retired).toHaveLength(1);
```

The RED is load-bearing: line `200` (`result.deleted === 1`) and `201`
(`result.errors === []`) **executed and passed** before `202` failed, so the run
processed the deletion and succeeded, and only the retirement was missing. C2 and C3
pass by construction at base — they assert absence, which the defect also produced.
The excerpt above was re-observed on the FINAL shipped test file, by restoring
`index.ts` to its base content (`git show HEAD:packages/wiki/src/compiler/index.ts`)
for one run and putting the fixed file back with `sha256sum -c` → `OK`.

The timings in the block above are from that final observation; the earlier observation
of the same RED, before the lint/duplication restructure described in `L10`, printed the
same assertion message at line `211`.

**L9 (measured) — `T3`'s GREEN, plus the neighbouring and related suites.**
`corepack pnpm exec vitest run test/compiler/graph-retirement-retires-source.test.ts --maxWorkers=2`
→ `✓ (3 tests) 199ms`, `Tests 3 passed (3)`.
`corepack pnpm exec vitest run test/compiler/graph-retirement-retires-source.test.ts test/compiler/graph-retirement-port-invocation.test.ts test/compiler/graph-retirement-port-absence.test.ts test/compiler/graph-retirement-dimensions.test.ts test/dimensions/kg-forget.test.ts --maxWorkers=2`
→ `Test Files 5 passed (5)`, `Tests 14 passed (14)`.
`corepack pnpm exec vitest related packages/wiki/src/compiler/index.ts --maxWorkers=4`
→ `Test Files 100 passed (100)`, `Tests 444 passed (444)`.

**L10 (measured) — `T6`'s mutation, and the restore that follows it.** The mutation is
the TWO-STEP hoist (`S2`): the identity capture lifted above `if (!options.review)` and
the `forgetDeletedSources` call moved out of that guard. Result — C1 still passes, C2
fails at an assertion:

```
   ✓ graph retirement through compile > retires a deleted source from the graph exactly once 112ms
   × graph retirement through compile > retires nothing when the run is held back for review 52ms
     → expected [ Array(1) ] to deeply equal []
   ✓ graph retirement through compile > retires nothing for a deleted source with no recorded identity 53ms

 FAIL  test/compiler/graph-retirement-retires-source.test.ts > graph retirement through compile > retires nothing when the run is held back for review
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "https://example.test/deleted-source",
+ ]

 ❯ test/compiler/graph-retirement-retires-source.test.ts:216:21
    214|     expect(result).toMatchObject({ deleted: 1, errors: [] });
    215|     // A held-back run leaves the graph alone: the wiki is still servi…
    216|     expect(retired).toEqual([]);
```

Restored with the exact reverse replacement and verified byte-identically:
`sha256sum packages/wiki/src/compiler/index.ts` →
`6eee00fcfeef23a24bb9652b4e308db3cd0bc14e7ec278372960f1df527cf974` before the mutation,
and `sha256sum -c` → `packages/wiki/src/compiler/index.ts: OK` after restoring it (and
again after the single-step experiment below).

The SINGLE-STEP hoist of the call alone — the mutation `S2` explicitly rejects — was
also measured, from the restored file: `tsc --noEmit` printed
`packages/wiki/src/compiler/index.ts(1197,42): error TS2304: Cannot find name
'retiredIdentities'.` It does not compile, so it would prove nothing about the test,
and the file was restored and re-verified afterwards.

Two gate findings forced structure changes in the NEW test file rather than a ratchet
adjustment, and both changed its shape after RED was first observed: `max-lines-per-function`
(53 > 39) moved the per-case setup into a module-level `runRetirementCompile` helper, and
`fallow:ci` reported **2 clone groups** — the identity-less seed duplicated
`retirement-port-project.ts:43`–`:57`, and C2/C3 shared an identical assertion block. The
seed is now built by stripping the identity from the shared seed's state instead of copying
it, and C2 asserts `toMatchObject({ deleted: 1, errors: [] })`. Both the RED and the
mutation above were re-observed AFTER those edits, on the shipped files.

**L11 (decision) — the final shape, and why it is this one.** `S5` asked for the
capture shape to be verified rather than adopted; this is the verification, and the
shape holds. A helper `deletedSourceIdentities(state, buckets.deleted)` reads each
deleted change's `state.sources[change.file]?.source`, keeps only defined identities,
and is called **inside** the `if (!options.review)` guard **immediately before**
`markDeletedAsOrphaned`, so capture and retire share one branch and neither can
outlive the other's guard. `forgetDeletedSources(root, sources: readonly string[], db,
env, port)` now consumes those identities; its dead `state` and `deleted` parameters
are gone rather than left behind. The live `state` object is still handed to
`runExtractionPhases` unchanged (`index.ts:1202`) — the fix CAPTURES alongside the
mutation instead of cloning or filtering the state, because replacing it would break
the extraction phase that consumes the same object afterwards. No `Set` was added, for
the reason measured in `L7`. The error-collection behaviour is unchanged: one message
per dimension whose `forget` throws, and the run continues. `S4`'s docstring now states
what the function receives, why the identities are captured before orphaning, and that
the old `@param state` line is what let the dead path survive two verifiers.

**L12 (measured) — the implementer's four local sanity gates, after every edit.**
`corepack pnpm exec tsc --noEmit` → exit **0**; `corepack pnpm run typecheck:tests` →
exit **0**, `Test type-check: 1582 files checked; 240 baseline diagnostics in 86 files;
no regression.`; `corepack pnpm run lint` → exit **0**, literal triple
`ESLint ratchet: 1646 files scanned; 566 baseline violations in 402 files across 429
rule/file entries; no regression.` (matches `S8`'s zero headroom, and `lint:update` was
never run); `corepack pnpm run fallow:ci` → exit **0**, `0 dead-code, 0 complexity, 0
duplication introduced since main`. `T8`'s full gate set (`gates:static`,
`typecheck:kg`, `fallow:kg`, `build`, the artifact tier and `pnpm test`) is deliberately
NOT run here: the brief assigns the gate run to a later agent.

**L13 (decision — parent's `S3` ruling, recorded so it is not re-litigated).** The
`orphan.ts:54` early-return path **cannot be reached through `compileAndReport`**, and
`S3`'s coverage is therefore split into `C3` (identity-less source, the nearest
reachable analogue, kept with its unreachability argument) plus a new multi-source case
`C4` for the reachable half — "a retirement that must not happen twice, and must not
name the wrong source". The evidence, re-verified in this working tree rather than
inherited: `buckets.deleted` is keyed from `Object.keys(prevState.sources)` —
`hasher.ts:174` for the rows path and `:191` for the files path — so every deletion the
pipeline sees names a state key that existed when change detection ran; the only thing
that removes such a key between detection and retirement is
`orphan.ts:72` `draft.removeSource(sourceFile)` (reached via
`utils/state.ts:274` `delete state.sources[sourceFile]`), and that runs AFTER
`deletedSourceIdentities` captured the identities at `index.ts:1190`. So a deleted
change whose state entry is already gone cannot arrive at the capture, and a case that
faked that state would be asserting on a shape the public interface never produces.
`orphan.ts:52`–`:54` is `const state = draft.read();` / `const sourceEntry =
state.sources[sourceFile];` / `if (!sourceEntry) return;`.

**L14 (measured) — the corrected citations and `C4`'s GREEN.** Three untrue citations
in the shipped comments were each corrected by reading the target line, not by
arithmetic, and each was re-read after the edit:

- `index.ts:1465` — cited `compile-state-draft.ts:80` for "returns the LIVE internal
  reference, not a copy". Line `:80` is `return this.state;`; the sentence is at
  **`compile-state-draft.ts:73`** (`* WARNING: returns the LIVE internal reference, not
  a copy.`, the docstring of `read()` at `:79`–`:81`). Now cites `:73`.
- `index.ts:1473` — cited `index.ts:1202` for "the extraction phase that consumes this
  same live object afterwards". Line `:1202` is `const frozenSlugs = new
  Set<string>();`; the extraction call is
  **`index.ts:1207`–`:1208`** (`const extractions = await timeStage("compile.extraction",
  () => runExtractionPhases(` and its `root, buckets.toCompile, state, …` argument line).
  Now cites `:1207`–`:1208`.
- `index.ts:1524` — `@returns One message per source that could not be retired` was
  false: the two nested loops at `:1542`–`:1551` push inside a `catch`, so the message
  count is one per **(source, dimension) pair** that threw. Now reads `@returns One
  message per (source, dimension) pair whose `forget` threw.`

`index.ts` changed in those three comment lines only, one-for-one, so the file is still
2172 lines and no citation number shifted; `git diff` against `HEAD` still shows the
`T3`/`T4` code and docstring changes, which are the earlier slices, not this follow-up.

`C4` — `it("retires each of two deleted sources once, under its own identity")` — seeds
`a.md → https://example.test/a` and `b.md → https://example.test/b`, both absent from
disk, compiles non-review through `compileAndReport` with the same recording port, and
asserts `result.deleted === 2`, `result.errors` deep-equal `[]`, and
`expect(retired).toEqual([...TWO_DELETED_IDENTITIES])` — an EXACT ordered array, so a
double retire, a missed source and a source retired under its neighbour's identity each
fail. The seed helper was generalised to `seedRecordedSources(root, record)`: it applies
the parent's `seedDeletedSourceProject`, then replaces the recorded entries with the ones
the case derives, so neither `C3` nor `C4` duplicates the shared seed and the shared
`retirement-port-project.ts` was not touched. GREEN, on the shipped file:
`corepack pnpm exec vitest run test/compiler/graph-retirement-retires-source.test.ts
--maxWorkers=2 --reporter=verbose` → `Tests 4 passed (4)`, the new case at `47ms`;
the five-file batch → `Test Files 5 passed (5)`, `Tests 15 passed (15)`;
`tsc --noEmit` exit 0; `typecheck:tests` exit 0 (`1582 files checked; 240 baseline
diagnostics in 86 files; no regression.`); `lint` exit 0 with the literal triple
`ESLint ratchet: 1646 files scanned; 566 baseline violations in 402 files across 429
rule/file entries; no regression.`; `fallow:ci` exit 0 (`0 dead-code, 0 complexity, 0
duplication introduced since main`). No RED was observed for `C4` and none is claimed:
the behaviour it pins was implemented by `T3` in this same uncommitted change, and its
discriminating power is structural (an exact ordered array against a sink the recording
dimension fills), not a base-vs-head difference. `T7` and `T8` remain unticked.

**L15 (measured) — a fourth stale citation, found while re-reading the test's own
docstring, and the final gate re-run.** `test/compiler/graph-retirement-retires-source.test.ts`'s
`@file` block still cited `compile-state-draft.ts:80` for the live-reference claim —
the same untrue citation corrected at `index.ts:1465` — so it was corrected to
`:73` (`* WARNING: returns the LIVE internal reference, not a copy.`, the docstring of
`read()` at `:79`–`:81`). The `@description` and that section's heading were extended
to name C4. The test file's `@file` docstring now also states the two identities'
purpose, and the file is 300 lines with every case under 40. No `odd/tasks/**`
statement above was rewritten; this entry is the correction of record. Final state, all
re-run after that edit on the shipped files: focused run `Tests 4 passed (4)` (new case
`57ms`); five-file batch `Test Files 5 passed (5)`, `Tests 15 passed (15)`;
`tsc --noEmit` exit 0; `typecheck:tests` exit 0 (`1582 files checked; 240 baseline
diagnostics in 86 files; no regression.`); `lint` exit 0 with the literal triple
`ESLint ratchet: 1646 files scanned; 566 baseline violations in 402 files across 429
rule/file entries; no regression.`; `fallow:ci` exit 0. The verifier scratch tree
`/tmp/verify-retire-XeXZnl` was removed and confirmed absent; nothing else under `/tmp`
was touched.

**L16 (measured) — `T7`'s base-vs-head database differential. It is POSITIVE: the two
trees differ in exactly the rows retirement now removes, Stack B is untouched, and
nothing else differs.**

What follows was observed in this order, and every scratch artifact lived in ONE
`mktemp -d` directory that has since been removed.

**The container and the two databases.** `TESTCONTAINERS_REUSE_ENABLE=false` was
exported for every command. Provisioned `llw-retire-diff-c1476a0e` from the locally
cached `pgvector/pgvector:pg16`
(`imageID=sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f`).
None of the four containers already running (`hardcore_borg`, the two
`llmwiki-probe-kg-mcp-e2e-*`, `llmwiki-kg-db-1`) was adopted, exec'd into or touched.
`docker port llw-retire-diff-c1476a0e 5432/tcp` → `127.0.0.1:32880`; the port was read
from that command and never guessed. Two databases, `diff_base` and `diff_head`, each
created fresh and each given `packages/llmwiki-kg/db/schema.sql` **independently**
(`psql -v ON_ERROR_STOP=1` → `schema OK` for both), yielding the ten tables
`backfeed_queue`, `document_chunks`, `entity_pages`, `entity_source_documents`,
`kg_classification_log`, `kg_evidence`, `ontology_entities`, `ontology_relationships`,
`stack_documents`, `stacks`. DSN shapes: `postgresql://diff:<redacted>@127.0.0.1:32880/diff_base`
and `.../diff_head`. Container stopped and removed afterwards, scratch directory removed,
and `docker ps` is back to exactly the four containers that pre-dated this task.

**The two trees, and the sha proof that they differ by one file.** BASE =
`git archive 5a31842bfa788971de757ba62b322cf94118696b`; HEAD = the same archive with
`git -C <worktree> diff -- packages/wiki/src/compiler/index.ts` applied inside it. Byte
proof that HEAD carries the worktree's file exactly: `sha256sum` →
`fec9282e602b20d0090be88d4360bf6105f680e2f66bc165662415dec6c6d1ba` for BOTH
`<head>/packages/wiki/src/compiler/index.ts` and the worktree file; the pristine base
file is `20027cca11da51f292ad6d321751b2c1e395603075dfc28d22ff729703af1d14`. Whole-tree
proof: `diff -rq <base>/packages <head>/packages` reports **only**
`packages/wiki/src/compiler/index.ts` (node_modules excluded), and
`diff -rq <base>/test <head>/test` reports nothing. So the ONLY COMPILED-SOURCE
difference between BASE and HEAD is `packages/wiki/src/compiler/index.ts`.
`corepack pnpm install --frozen-lockfile --offline` in both trees (warm store, ~1.4 s
each, `Lockfile is up to date`).

The worktree's OTHER uncommitted files are outside every compiled artifact and cannot
affect the differential: `CHANGELOG.md` (a bullet), `test/compiler/graph-retirement-port-invocation.test.ts`
(a `@file` docstring edit only) and `test/compiler/graph-retirement-retires-source.test.ts`
(new, untracked). `tsup.config.ts` builds exactly two entries —
`packages/wiki/src/index.ts` and `packages/api/src/main.ts` — so no test file and no
markdown file enters `dist/`; and the probe imports only
`packages/{wiki/src/compiler/index.js, wiki/src/dimensions/stack-selection.js,
wiki/src/utils/constants.js, wiki/src/utils/types.js}`, none of which is one of those
three files. The probe therefore could not have observed them even if they had been
extracted into the trees. Agreement with the manager's statement, stated explicitly: yes,
`CHANGELOG.md`, `test/compiler/*` and the docs are not compiled.

**One probe, byte-identical in both trees.** `test/compiler/zz-differential-probe.test.ts`,
`sha256sum` → `994389a9bc11f98854426a1b6ef5ba45e859f33f906809bf0dea31aa8dd58232` for the
scratch original AND for `<base>/test/compiler/…` AND for `<head>/test/compiler/…`. It
RECORDS and asserts nothing about the outcome; it writes one JSON report per run. Run in
each tree:
`LLMWIKI_TEST_DATABASE_URL=<dsn> PROBE_DSN=<dsn> PROBE_OUT=<json> corepack pnpm exec vitest run test/compiler/zz-differential-probe.test.ts --maxWorkers=1`
→ `Tests 1 passed (1)` in BASE and in HEAD. Both runs used the REAL kg dimension (no
`dimensionsPort`), so `forget` really executed `delete from stack_documents where stack_id
= $1 and storage_path = $2`.

**Row-count snapshots, every table in the database (BASE / HEAD).**

- BEFORE, identical in both trees: `backfeed_queue 0`, `document_chunks 2`,
  `entity_pages 0`, `entity_source_documents 0`, `kg_classification_log 0`,
  `kg_evidence 0`, `ontology_entities 0`, `ontology_relationships 0`,
  `stack_documents 2`, `stacks 2`.
- AFTER, BASE: unchanged — `document_chunks 2`, `stack_documents 2`, `stacks 2`, every
  other table `0`. The rows SURVIVE, which is the base behaviour `S7` requires.
- AFTER, HEAD: `document_chunks 1`, `stack_documents 1`, `stacks 2`, every other table
  `0`. Exactly one `stack_documents` row and one `document_chunks` row fewer, in the
  table that cascades from it, and nothing added anywhere.

**The rows that differ, by tenant.** `select stack_id, storage_path, count(*) from
stack_documents group by 1,2` AFTER → BASE: two rows, `Stack A |
https://example.test/deleted-source | 1` and `Stack B | https://example.test/deleted-source
| 1`. HEAD: ONE row — `Stack B | https://example.test/deleted-source | 1`. Direction:
REMOVED ONLY. The removed row is Stack A's (`default` domain) document for that
`storage_path`, and with it the `document_chunks` child row inserted under Stack A's
document; nothing was added in either tree, and Stack B's document row AND its child row
both still exist (verified row by row with a `stack_documents join stacks` and a
`document_chunks join stacks` listing in each database).

**The tenant boundary, asserted rather than assumed.** Stack B's count for
`https://example.test/deleted-source` is **1 before and 1 after in HEAD** — unchanged —
and Stack B's `document_chunks` child row also survives (its chunk id is still present
after the run). Retirement is scoped by the statement's own `where stack_id = $1`, and the
differential confirms the scoping holds end to end. Stack B lost nothing: no finding.

**The child row cascaded, and only in HEAD.** `document_chunks` 2 → 1 in HEAD (the chunk
under Stack A's document), 2 → 2 in BASE. So the cascade is observable through the public
path and is exactly the one the cascade references predict — `document_chunks` at
`schema.sql:82`. `entity_source_documents`, `kg_evidence` and `entity_pages` were all `0`
before and after in both trees, which is consistent with `L`§S7's correction: nothing
populated them here, and `entity_pages` is not a cascade of `stack_documents` at all.

**The whole observable, including the run's result object.** Both runs returned, byte for
byte, `{"compiled":0,"skipped":0,"deleted":1,"concepts":[],"pages":[],"errors":[]}` —
in the provisioning compile AND in the measured compile, in BOTH trees. `errors` is empty
in both, so no retirement error string exists in either tree to differ; `CompileResult`
(`packages/wiki/src/utils/types.ts:193`–`:217`) has no dedicated retirement field, so
`errors` is the only retirement-visible channel and it is identical. No error was recorded
by any probe step in either tree (`"ok": true` on every step of both reports).

**Every other difference: NONE.** The literal `diff -u base-report.json head-report.json`
has exactly six hunks. Four of them are random UUIDs (Stack A, Stack B, the two document
ids, the two chunk ids) that differ only because each run seeds a fresh database; they are
not behavioural. The other two hunks are the rows now being removed. With UUIDs masked the
diff is exactly this, and nothing else:

```
      "value": {
        "backfeed_queue": 0,
-        "document_chunks": 2,
+        "document_chunks": 1,
         "entity_pages": 0,
         "entity_source_documents": 0,
         "kg_classification_log": 0,
         "kg_evidence": 0,
         "ontology_entities": 0,
         "ontology_relationships": 0,
-        "stack_documents": 2,
+        "stack_documents": 1,
         "stacks": 2
       }
     },
     "documentsByStack": {
       "value": [
-        "<uuid>|https://example.test/deleted-source|1",
         "<uuid>|https://example.test/deleted-source|1"
       ]
     }
```

`stacks` is 2 in both trees before and after, with the same two domains: no Stack row was
created, renamed or removed by HEAD's retirement. The provisioning compiles are identical
too (`{"compiled":0,"skipped":0,"deleted":1,…}` and, for the empty root, all zeroes) in
both trees.

**L17 (decision) — the one scenario-shape deviation, and why it does not adjust toward the
wanted answer.** `T7`'s step 1 prescribes provisioning the default Stack with one `compile`
on an EMPTY project root. Measured, in BOTH trees: that compile does not provision
anything. It returns through `finalizeNothingToCompile`, whose call site is
`packages/wiki/src/compiler/index.ts:1169` —
`if (buckets.toCompile.length === 0 && buckets.deleted.length === 0)` — which sits BEFORE
the retirement block and therefore before anything reaches
`resolveStackForDimensions` → `ensureDefaultStack`. Both reports record it: the empty-root
run returned all zeroes and `stacksAfterEmptyRootProvision` is `[]` in BASE and in HEAD.
The Stack was therefore provisioned by the cheapest project shape that DOES reach that
code — the same one-deletion project the scenario compiles — which is still "one compile
provisioning the default Stack the way a real run does", just not on an empty root, and is
the only shape that provisions without an extraction provider. This changes how Stack A is
obtained, not what is measured: the seeded document rows are inserted after provisioning
and before the snapshot in both trees, and the base run was allowed to produce whatever it
produced — it produced the expected row SURVIVES result on the first attempt, with no
scenario retuning. Nothing was iterated to reach the wanted answer. A reader who needs the
empty-root fact again: an empty project root never provisions the default Stack, because
nothing reaches dimension resolution at all.

**L18 (measured) — `T8`: the full gate set, run by an independent verifier on the
uncommitted tree, and every gate passed.** Node 24 for every command
(`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`, `node --version` →
`v24.21.0`), every pnpm invocation through `corepack pnpm`, repository root as cwd.
`LLMWIKI_TEST_ALLOW_NO_DATABASE` was `UNSET` in every gate's environment, checked by
`echo "LLMWIKI_TEST_ALLOW_NO_DATABASE=[${LLMWIKI_TEST_ALLOW_NO_DATABASE:-UNSET}]"`
before the suite. `lint:update` was never run, no hook bypass was used, nothing was
committed.

1. `corepack pnpm run gates:static` → **exit 0**, `static gates: all 6 passed in 25.0 s`,
   every labelled block ok: `tsc — ok in 6.8 s`, `typecheck:kg — ok in 6.7 s`,
   `typecheck:tests — ok in 16.6 s`, `fallow:ci — ok in 2.9 s`, `fallow:kg — ok in 1.0 s`,
   `lint — ok in 11.5 s`. Literal lint triple —
   `ESLint ratchet: 1646 files scanned; 566 baseline violations in 402 files across 429
   rule/file entries; no regression.` — i.e. zero headroom preserved. `typecheck:tests`
   printed `Test type-check: 1582 files checked; 240 baseline diagnostics in 86 files; no
   regression.`; `typecheck:kg` printed `KG package type-check: 357 files checked; 0
   diagnostics baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no
   regression.`; `fallow:ci` printed `Fallow CI: 0 dead-code, 0 complexity, 0 duplication
   introduced since main (verdict pass; 0 dead-code, 0 complexity, 0 duplication
   inherited, not counted)` against `local main, not the origin/main merge-base
   82038628`; `fallow:kg` verdict `pass` with `0` introduced in every attribution bucket
   (it also warns `node_modules directory not found` from the kg package root — a
   pre-existing warning, the audit still ran and passed).
2. `corepack pnpm exec tsc --noEmit` → **exit 0**, empty output.
3. `corepack pnpm run build` → **exit 0** (`ESM dist/index.js 105.45 KB`, `ESM dist/api.js
   2.40 MB`, `DTS Build success in 4762ms`).
4. `corepack pnpm exec vitest run test/artifact` → **exit 0**, `Test Files 4 passed (4)`,
   `Tests 20 passed (20)`, `Duration 28.52s`. There is no `test:artifact` script and none
   was cited.
5. `corepack pnpm run test:affected` → **exit 78**, one line:
   `affected: scope resolves to the full unit tier; run \`pnpm test\` instead`. That is the
   documented decline for suite-wide reach, and gate 6 is the run it defers to.
6. `corepack pnpm test` → **exit 0**, `Test Files 813 passed | 3 skipped (816)`,
   `Tests 6134 passed | 4 skipped (6138)`, `Duration 347.62s` (09:05:39 → 09:11:27).
   The known flake `test/main-subcommand-flags.test.ts:147` (SIGTERM) did NOT appear:
   `✓ packages/api/src/main-subcommand-flags.test.ts (4 tests) 5919ms`. No other failure
   occurred, so nothing was absorbed and nothing was re-run to make a number green. The
   three skipped FILES are the four `AKS_TEST_GATEWAY=1`-gated gateway cases
   (`packages/llmwiki-kg/ts/src/routes/pages-gateway.test.ts` `2 skipped`,
   `aks-gateway.test.ts` `1 skipped`, `ingest-gateway.test.ts` `1 skipped`) — an opt-in
   gateway switch, NOT a missing database, and their skip conditions name only
   `state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1"`.
   The new file RAN in the gate of record:
   `✓ test/compiler/graph-retirement-retires-source.test.ts (4 tests) 317ms`.
   The suite connected to a real Postgres: `[test-database] adopted running
   pgvector/pgvector:pg16 container hardcore_borg on
   postgres://test:test@localhost:32802/test`, and `[test-database] keeping reusable
   container hardcore_borg for the next run`. That reusable container is the project's
   own default harness path (`test/global-setup.ts`), pre-existing before this slice;
   the differential below used a freshly provisioned container instead.

Independent probes, all in a `mktemp -d` scratch copy (source copy made with
`tar --exclude=./.git`, never `cp -a`; never `git worktree`/`git stash`):

- **RED at the base source, observed by the verifier.** In the scratch tree, `git -C
  <repo> show 5a31842...:packages/wiki/src/compiler/index.ts > packages/wiki/src/compiler/index.ts`
  (sha256 → `20027cca11da51f292ad6d321751b2c1e395603075dfc28d22ff729703af1d14`) then
  `vitest run test/compiler/graph-retirement-retires-source.test.ts --maxWorkers=2` →
  exit 1, C1 `× … → expected [] to have a length of 1 but got +0`, C4 `× … → expected []
  to deeply equal [ 'https://example.test/a', …(1) ]`, C2 and C3 green. Restored from the
  copy and re-verified `fec9282e602b20d0090be88d4360bf6105f680e2f66bc165662415dec6c6d1ba`.
- **S2's two-step hoist mutation, re-derived by the verifier.** Capture lifted above
  `if (!options.review) {` AND the `forgetErrors.push(...forgetDeletedSources...)` block
  moved below the guard's closing brace → the file COMPILES and the suite runs, exit 1,
  C2 only: `× graph retirement through compile > retires nothing when the run is held
  back for review → AssertionError: expected [ Array(1) ] to deeply equal []`, at
  `test/compiler/graph-retirement-retires-source.test.ts:276:21`. C1, C3 and C4 stayed
  green in the same run. File restored, sha `fec9282e…c6d1ba` re-verified.
- **The rejected single-step hoist does not compile**: with the capture left inside the
  guard and only the call moved out, `tsc --noEmit` → exit 2,
  `packages/wiki/src/compiler/index.ts(1197,42): error TS2304: Cannot find name
  'retiredIdentities'.` — which is exactly why `S2` requires the two-step form.
- **GREEN on the shipped files**: `vitest run
  test/compiler/graph-retirement-retires-source.test.ts --maxWorkers=2 --reporter=verbose`
  → exit 0, `Tests 4 passed (4)`.
- **Independent base-vs-head database differential, POSITIVE and tenant-scoped.** Fresh
  container `llw-verify-diff-1794319949` from the cached `pgvector/pgvector:pg16` image
  (`TESTCONTAINERS_REUSE_ENABLE=false`, none of the four pre-existing containers adopted,
  port read from `docker port llw-verify-diff-1794319949 5432/tcp` → `127.0.0.1:32882`),
  two databases `diff_base` / `diff_head` each independently loaded with
  `packages/llmwiki-kg/db/schema.sql` (`psql -v ON_ERROR_STOP=1`, 10 tables each). BASE =
  `git archive 5a31842...`; HEAD = the scratch copy of this worktree. ONE probe file,
  byte-identical in both trees (sha256 `f7e46af6128236e07c46809983bcca2a418efbd2e33e5167f99eab8659775b11`),
  running the REAL kg dimension (no `dimensionsPort`) through `compileAndReport`, with a
  second tenant Stack (`stack-b-verify`) holding a document AND a chunk under the SAME
  `storage_path` as the default Stack. Row counts BEFORE identical in both trees
  (`stack_documents 2`, `document_chunks 2`, `stacks 2`, every other table `0`). AFTER
  BASE: unchanged (`stack_documents 2`, `document_chunks 2`) — the base keeps the rows.
  AFTER HEAD: `stack_documents 1`, `document_chunks 1`, `stacks 2`, nothing else changed.
  By tenant, AFTER BASE = `default|https://example.test/deleted-source|1` +
  `stack-b-verify|…|1`; AFTER HEAD = `stack-b-verify|…|1` ONLY, and by chunk the same
  shape. So the removed rows are the `default` Stack's document and its cascaded chunk
  and the ONLY difference between the trees; **Stack B lost nothing, before and after 1
  and 1** — the tenant boundary holds end to end. The `run` object is byte-identical in
  both trees (`{"compiled":0,"skipped":0,"deleted":1,"concepts":[],"pages":[],"errors":[]}`),
  so nothing but the removed rows differs. (The provisioning compile consumed the
  deletion, so the probe re-states the deletion before the measured run — the measurer's
  own scenario shape, not a change to the code under test.)

Verifier conclusion: `S8` met; no in-scope spec item left unverified by `T8`. Verifier
scratch directory `/tmp/verify-gate-7dmFibIa` and container `llw-verify-diff-1794319949`
exist at the time of writing and are the parent's to remove.

**L19 (measured) — `T9`: `S7`'s tenant boundary is now a committed test, the test is
proven non-vacuous by mutation, and `S6`'s bullet is corrected for the deselected
path. `T1`–`T9` stay ticked because every gate below passed on the final tree, and
`commit: pending` is unchanged everywhere.**

**The tenant test.** New file `test/compiler/graph-retirement-tenant-scope.test.ts`
(177 lines; the single `it` block spans 28 lines, inside the 40-line house limit, and
its shared setup is extracted into module-level helpers rather than grown inline). It is
DB-backed through `test/fixtures/kg-postgres.ts` with **no `describe.skipIf`** and
`afterAll(() => harness.cleanup())`, and it calls `compileAndReport` with
`{ AKS_DATABASE_URL: DATABASE_URL, LLMWIKI_DIMENSIONS: "kg" }`, `embeddings: false`
and **no `dimensionsPort`**, so the REAL kg dimension executes the SQL predicate. The
second tenant is `harness.stackId` and its rows are inserted with the SAME
`storage_path` (`https://example.test/deleted-source`) on purpose, because
`storage_path` alone is ambiguous between tenants and a delete scoped by it alone
would silently reach the other one. It seeds with the shared
`seedDeletedSourceProject` (untouched), runs one provisioning compile — a compile both
provisions the default Stack and CONSUMES the deletion, so the state is re-seeded
before the measured run — and then asserts, in order, `result.toMatchObject({ deleted:
1, errors: [] })`, the other tenant's `stack_documents` count `1`, its
`document_chunks` count `1`, and the cross-tenant total `totalBefore - 1`. API used
against the real fixtures: `harness.db.execute(sql\`…\`)` with `sql` from `drizzle-orm`
(the shape `graph-retirement-dimensions.test.ts` uses), never the `createClient`
tagged-template of the earlier probe. NOT NULL columns verified in
`packages/llmwiki-kg/db/schema.sql` before inserting: `stack_documents.stack_id`,
`.filename`, `.storage_path`, `.size_bytes`, `.source_hash` (`:35`–`:56`) and
`document_chunks.document_id`, `.stack_id`, `.chunk_index`, `.content`,
`.content_hash` (`:77`–`:94`); every other column defaults or is nullable.

GREEN, from the gate run: `✓ test/compiler/graph-retirement-tenant-scope.test.ts
(1 test) 260ms`, with the first observation of the same case at `228ms`.

**The mutation, and the failing assertion verbatim.** Mutated ONLY
`packages/llmwiki-kg/ts/src/core/document-consolidation.ts`, dropping
`stack_id = ${stackId} and ` from the `forgetDocumentRows` predicate so the statement
scoped by `storage_path` alone:

```
-    where stack_id = ${stackId} and storage_path = ${source}
+    where storage_path = ${source}
```

`corepack pnpm exec vitest run test/compiler/graph-retirement-tenant-scope.test.ts
--maxWorkers=2` → exit **1**:

```
 ❯ test/compiler/graph-retirement-tenant-scope.test.ts (1 test | 1 failed) 316ms
   × graph retirement tenant scope > retires the deleted source only inside the Stack that owns it 303ms
     → expected +0 to be 1 // Object.is equality

 FAIL  test/compiler/graph-retirement-tenant-scope.test.ts > graph retirement tenant scope > retires the deleted source only inside the Stack that owns it
AssertionError: expected +0 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 0

 ❯ test/compiler/graph-retirement-tenant-scope.test.ts:168:51
    166|       expect(result).toMatchObject({ deleted: 1, errors: [] });
    167|       // The other tenant's rows — same `storage_path`, different Stac…
    168|       expect(await documentRows(harness.stackId)).toBe(1);
       |                                                   ^
    169|       expect(await chunkRows(harness.stackId)).toBe(1);
    170|       // And exactly one row left the table: the owning Stack's, no mo…
```

The second tenant lost its row and the test said so at an ASSERTION, not at `tsc`. The
two assertions above it had already passed, so the run itself succeeded and the only
difference was the cross-tenant deletion — the failure is the boundary being crossed,
not a broken run.

**The restore proof.** `sha256sum` BEFORE the mutation →
`db7009ed714a6b0ef2cc592d09adc15e396f507e0401a4323e456780599a7242`, and the same value
for the single-file backup kept outside the repository. After restoring from that
backup: `sha256sum` →
`db7009ed714a6b0ef2cc592d09adc15e396f507e0401a4323e456780599a7242` (identical), and
`git diff packages/llmwiki-kg/ts/src/core/document-consolidation.ts` printed **nothing**
(`git diff --numstat` → 0 lines). Net change to that file: ZERO. The backup directory
and the suite log were the only scratch this task created, both outside the worktree,
both removed.

**The `S6` correction, and the two lines that justify it.** `hasher.ts:194` is
`...(!isSourceSelected(file, selection) ? { reason: "deselected" as const } : {})` inside
`findDeletedFiles`, and `index.ts:397` builds `buckets.deleted` as
`changes.filter((c) => c.status === "deleted")` — reason-blind — while
`deletedSourceIdentities` (`index.ts:1493`–`:1503`) pushes every defined identity it
finds there. So a DESELECTED source whose file is still on disk retires its graph rows
today, and `compile-report.ts:277`–`:278` already tells the operator those
contributions "will be retired". The bullet at `CHANGELOG.md:152`–`:169` now says so
explicitly: the lead sentence names deselection, and the operator sentence reads
"expect `stack_documents` rows to be deleted IRREVERSIBLY in two cases, not one: a
source that was deleted, and a source that was merely DESELECTED and still sits on
disk", citing `hasher.ts:194`, then notes that reselecting and compiling registers
rows again (`writeGraphRows` → `registerDocumentRow`, `dimensions/kg/index.ts:418`)
while nothing restores the rows already removed. One bullet, same shape and wrapping,
no invented version or date, and the same first sentence stays the search anchor.

**Every gate, on the final tree.** Node `v24.21.0`, every pnpm call through
`corepack pnpm`, `LLMWIKI_TEST_ALLOW_NO_DATABASE=[UNSET]`.

1. `corepack pnpm exec vitest run test/compiler/graph-retirement-tenant-scope.test.ts --maxWorkers=2` → exit **0**, `Test Files 1 passed (1)`, `Tests 1 passed (1)`.
2. The six-file batch (`retires-source`, `tenant-scope`, `port-invocation`, `port-absence`, `dimensions`, `test/dimensions/kg-forget.test.ts`) → exit **0**, `Test Files 6 passed (6)`, `Tests 16 passed (16)`.
3. `corepack pnpm exec tsc --noEmit` → exit **0**, empty output.
4. `corepack pnpm run typecheck:tests` → exit **0**, `Test type-check: 1583 files checked; 240 baseline diagnostics in 86 files; no regression.` (1583 = the new file; same baseline).
5. `corepack pnpm run lint` → exit **0**, literal triple unchanged:
   `ESLint ratchet: 1647 files scanned; 566 baseline violations in 402 files across 429 rule/file entries; no regression.` (`lint:update` never run.)
6. `corepack pnpm run fallow:ci` → exit **0**, `Fallow CI: 0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass; … inherited, not counted)`.
7. `corepack pnpm run build` → exit **0**, `ESM dist/index.js 105.45 KB`, `ESM dist/api.js 2.40 MB`, `DTS Build success in 4978ms`.
8. `corepack pnpm test` → exit **0** twice, the second run tee'd so the new file's line is quotable: `Test Files 814 passed | 3 skipped (817)`, `Tests 6135 passed | 4 skipped (6139)`, `Duration 355.06s` (first run: same totals, `369.12s`). BOTH are exactly base `813 | 3 (816)` / `6134 | 4 (6138)` plus this one file and its one test. The new file's line: `✓ test/compiler/graph-retirement-tenant-scope.test.ts (1 test) 260ms`, alongside `✓ test/compiler/graph-retirement-retires-source.test.ts (4 tests) 302ms`. The known flake did NOT appear: `✓ packages/api/src/main-subcommand-flags.test.ts (4 tests) 8488ms`. The three skipped files are still the `AKS_TEST_GATEWAY=1`-gated gateway cases.

**Cleanup.** `/tmp/verify-gate-7dmFibIa` removed; container `llw-verify-diff-1794319949`
stopped and removed (`docker ps` now shows only `hardcore_borg`,
`llmwiki-probe-kg-mcp-e2e-ad8f2b86`, `llmwiki-probe-kg-mcp-e2e-3cbc0162`,
`llmwiki-kg-db-1` and `buildx_buildkit_multibuilder0` — the same set that pre-dated
this task). This task's own scratch (`/tmp/tenant-mutation-yRPmdOye`, the suite log) was
removed too. Nothing was committed.

**L20 (measured) — the slice is committed as `9c636d32ccc1fcc66771911c050f06c5b85100d2`,
and that commit holds exactly the six files the gate runs in `L18`/`L19` measured.**

Files in the commit (`git show --name-only --format= 9c636d32`): `CHANGELOG.md`,
`packages/wiki/src/compiler/index.ts`,
`test/compiler/graph-retirement-port-invocation.test.ts`,
`odd/tasks/graph-retirement-live.md`,
`test/compiler/graph-retirement-retires-source.test.ts` and
`test/compiler/graph-retirement-tenant-scope.test.ts`. `git diff --numstat` at staging
reported `19/0` CHANGELOG, `58/16` `compiler/index.ts`, `9/7` `port-invocation`, `714/0`
this document, `300/0` `retires-source` and `177/0` `tenant-scope`; the commit itself
reports `6 files changed, 1277 insertions(+), 23 deletions(-)`. No file outside those six
entered the commit, so `packages/llmwiki-kg/ts/src/core/document-consolidation.ts` (the
`S7` mutation experiment's target) and `odd/tasks/compile-port-threading.md` are absent
from it and byte-untouched.

**The gate run in `L18`/`L19` was performed on this exact content.** Nothing was edited
between the `T8`/`T9` gate runs and the commit: `git status --short` before staging listed
precisely those six paths and nothing else, the staging step named those six paths
individually rather than using `git add -A`, and `git status --short` is empty after the
commit. The pre-commit hook therefore re-measured the same tree under Node `v24.21.0` and
exited **0**: `pnpm run fallow:ci` reported `Fallow CI: 0 dead-code, 0 complexity, 0
duplication introduced since main (verdict pass; 0 dead-code, 0 complexity, 0 duplication
inherited, not counted)` against base ref local `main`, and `pnpm exec tsc --noEmit`
printed nothing and exited 0. The full suite was NOT re-run for this commit; `L18`'s
`pnpm test` result (`Test Files 814 passed | 3 skipped (817)`, `Tests 6135 passed | 4
skipped (6139)`) stands as the record for this content.
