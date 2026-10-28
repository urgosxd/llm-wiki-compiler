# Feature: align the test suite with the wiki-rows / outbox / atomic-transaction reality

## Goal

Make every test that measures the shipped feature measure it honestly. Four tests
are red and several assertions are green for the wrong reason. Each fix below was
chosen because it restores a claim someone would rely on, not because it makes a
number go up.

## Status

**DONE.** Full suite **6384 tests / 0 failed / 8 skipped** (was 4 failed).
`tsc` 0, `npm run build` 0, `test:affected` 686 files / 5092 tests passed,
`fallow` 0 dead code and 0 duplication. Every diagnosis below was measured, not read.

Each new assertion was verified by MUTATION, not by going green: the production code
was broken deliberately and the suite had to fail. Two of my first attempts did NOT
survive that check and were rewritten -- see "What the mutation check caught".

## The full-suite baseline (measured)

`2436 suites / 6378 tests / 4 failed / 8 skipped`. Three red files:

| File | Failed | Class |
| --- | --- | --- |
| `test/connectors/legacy-capacity-parity.test.ts` | 2/3 | Assertion darkness |
| `test/quickstart-concurrency.test.ts` | 1/1 | Missing Stack binding |
| `test/answer-approval-bytes.test.ts` | 1/5 | Stale arity + stale call count |

## Diagnosis, one row per fix

### 1. `legacy-capacity-parity` — `toEqual` on a 5 MB Buffer

`expect(await readFile(...)).toEqual(before)` compares two `Buffer`s element by
element. Measured in isolation: `.toEqual` = **42 155 ms**, `.equals()` = **1 ms**,
for the same pair of buffers. The 30 s test timeout therefore fires on a comparison,
not on the behaviour.

The assertion's INTENT (the archived bytes are byte-identical to the predecessor) is
correct and worth keeping. Only the operator was wrong.

**Fix:** `expect(archived.equals(before)).toBe(true)`, which also prints a useful
failure instead of diffing megabytes.

### 2. `quickstart-concurrency` — the ingest cannot run without a Stack

`compileAndReport` receives **0 calls**. The run dies before compile:

```
LLMWIKI_DIMENSIONS enables "wiki" but AKS_STACK_ID is not set.
```

Every dimension is Postgres-backed now, so an ingest without a Stack identity has
nothing to key a row by. The suite was written before that contract.

**Measured:** the identical test body with `useStackEnv("...")` added **passes**.
**Fix:** bind a Stack, the same way every other ingest suite does.

### 3. `answer-approval-bytes` — two stale numbers in one assertion

Measured call log:

```
call0: ids=["queries/direct"]  argCount=2
call1: ids=["queries/answer"]  argCount=5
```

The assertion expects ONE call with `["queries/answer"]` and THREE arguments. Both
numbers are stale: the save path embeds `queries/direct` too, and
`updateEmbeddingsLockedCore` grew `store` and `pageSource` parameters.

Its own comment says it has been red since before the rows migration and that
widening it to "any call" would stop asserting WHICH page was embedded. That is the
right instinct and the reason this cannot be fixed by loosening it.

**Fix:** assert the call that matters — `["queries/answer"]` with the current arity,
allowing the `queries/direct` call to exist — so the claim "the APPROVED page is what
got embedded" survives.

### 4. `cross-dimension-rollback` — an assertion that inspects nothing

```ts
expect(existsSync(path.join(outcome.root, "sources"))).toBe(false);
```

`outcome.root` is a `mkdtemp` directory that **no dimension in this suite is ever
given**. Probed: the directory enters and exits the run empty. The test says "no
source markdown was written" and actually says "I did not look". It would pass even
if the projection wrote 10 MB into a real root.

**Fix:** assert the property the doubles CAN prove — no dimension that never
committed had its `afterCommit` invoked, so no projection could have run — and move
the file-level claim to a suite that passes a real root. Both are covered below.

## Gaps this feature shipped without coverage

These are not red tests; they are absent ones, which is worse because nothing reports
them.

### 5. `src/dimensions/wiki/source-projection.ts` — zero tests

No file under `test/` imports `projectSourceMarkdown`. The whole compensation path
(`unlink` what this attempt created, restore bytes it overwrote) is unexercised, and
`odd/tasks/ingest-atomicity.md` task 8 explicitly claimed "compensation" was tested.

**Fix:** a suite that injects a `saveSource` failure and asserts both branches of the
compensation, plus the no-op branch where nothing was written yet.

### 6. `scope.tx` on the REAL graph dimension — untested

`kg-dimension.test.ts` calls `commit(prepared)` with no scope.
`ingest-atomicity.test.ts` uses a graph DOUBLE. So `writeGraph`'s
`if (callerTx !== undefined)` branch — "join the coordinator's transaction, never
open your own connection", the central claim of atomic ingest — has no test against
the shipped dimension.

**Fix:** assert that a scoped commit does NOT open a client, and that the writes land
on the handle it was given.

## Not fixed here, and why

### The viewer-handoff tests are skipped permanently, and the skip hides a product bug

`test/quickstart-integration.test.ts` computes:

```ts
const stackAlwaysOn = testDatabaseUrl() !== "";
```

`testDatabaseUrl()` never returns `""` by design (it falls back to the documented
container on 5434). So `stackAlwaysOn` is **always true** and four tests are skipped
forever. Before commit `4277271` the line read
`(process.env.LLMWIKI_TEST_DATABASE_URL ?? "") !== ""`, which correctly meant "no
Stack". A conditional skip became a permanent one.

**Do not simply delete the skip.** Measured with the guard forced to `false`, the
four tests run and all four fail, for three different reasons:

1. `preserves CompileResult.errors verbatim` — asserts `compile.ok === false` after
   seeding a `.llmwiki/lock` FILE. Measured: compile **succeeds** (`"compiled":1`).
   The lock is a Postgres advisory lock keyed by Stack id, so a file contends with
   nothing. The premise is dead, not the assertion.
2. `prints the lifecycle line and hands off` and `suppresses the Next line` —
   measured tree after a Stack-bound quickstart:
   ```
   fixture-source.md
   sources/fixture-source.md
   ```
   No `wiki/` directory at all. `shouldStartViewer` reads
   `collectProjectState(root).conceptCount`, which counts FILES under
   `wiki/concepts`; pages are rows now, so the count is 0 and the handoff never
   fires. The comment claims the fixture is too short for a compile — that is stale.
   The compile produced a page. **This is a product bug**, not a test bug: on a
   Stack-bound project the viewer handoff is unreachable.
3. `preserves a non-view Next recommendation` — same root cause.

Fixing this needs a decision (row-backed state for the handoff gate) that is larger
than a test alignment and belongs in its own feature. Recorded here so the skip is
not mistaken for "nothing to do".

## Tasks

| # | Task | Files |
| --- | --- | --- |
| 1 | Buffer byte-equality with `.equals()` | `test/connectors/legacy-capacity-parity.test.ts` |
| 2 | Bind a Stack for the concurrency forwarding test | `test/quickstart-concurrency.test.ts` |
| 3 | Assert the approved page with current arity | `test/answer-approval-bytes.test.ts` |
| 4 | Replace the vacuous `sources/` assertion | `test/dimensions/cross-dimension-rollback.test.ts` |
| 5 | Compensation tests for the source projection | `test/dimensions/source-projection.test.ts` |
| 6 | `scope.tx` on the real graph dimension | `test/dimensions/kg-dimension.test.ts` |
| 7 | Pin reverse commit order | `test/dimensions/ingest-atomicity.test.ts` |

## What the mutation check caught

Two suites passed for the wrong reason on the first attempt, and only the mutation
test exposed it. Recording both because "green" was not the signal.

1. **`source-projection.test.ts` did not measure compensation.** The injected failure
   threw BEFORE writing, so the destination never changed and "restore the previous
   bytes" was a no-op that could not fail. Emptying `restorePreWrite` left all five
   cases green. Fixed by making the injected failure perform the REAL write and then
   throw, which is also what a mid-write ENOSPC/EIO leaves behind. After the fix, two
   cases fail when either compensation branch is neutralised.
2. **The reverse-order case passed for an unrelated reason.** With the coordinator
   mutated to stop passing `scope`, the graph double threw "received no transaction"
   instead of the wiki throwing, so both row counts were zero because the graph never
   wrote. Pinning the cause (`/wiki blew up after the graph wrote/`) made the case
   sensitive to the ordering it claims to test.

## Verification policy

Per `AGENTS.md`: `npx tsc --noEmit`, `npm run build`, `npm run test:affected`,
`fallow`. Postgres is reachable on 5434, so the atomicity suites run rather than skip.

`test:affected` reports 2 unhandled rejections from `test/commands/host-command.test.ts`
(`process.exit called with "1"` in `serve-bind.ts`). PROVEN PRE-EXISTING: reproduced
with all of this work stashed, and the file's own 3 tests pass. Untouched here.

## Evidence

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | success |
| `npm run test:affected` | 686 files / 5092 tests passed |
| `npx fallow` | 0 dead code, 0 duplication |
| full `npx vitest run` | 2437 suites / 6384 tests / **0 failed** / 8 skipped |
