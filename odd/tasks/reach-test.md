# Feature: reach-test (Project 3 of 3)

Fix the reach of the proof, not the proof's wording: a real end-to-end KG MCP probe against a
real Postgres and the real KG API, per-run database isolation so parallel suites cannot move each
other's counts, and a gate that can finally see the KG package. Branch `feat/reach-test`, base
`feat/align-dimension` @ dff1d31 (14 commits, base 2340970 = Project 1's head). It inherits
`odd/tasks/all-tools-without-stackId.md` (L16 gaps, L20 rulings) and `odd/tasks/align-dimension.md`
(L20-L22). English for code, tests, commits and docs. Do not touch `main`, do not push, do not open
a pull request.

## Specs

S1. A REAL END-TO-END KG MCP PROBE. Not an in-memory transport, not a mocked dependency: stand up the KG service for real (Postgres from the existing harness fixtures, the KG API from `packages/llmwiki-kg/ts/src/index.ts`), start the KG MCP server through its real entry (`runStdio()` in `packages/llmwiki-kg/ts/src/mcp/server.ts`), and drive it over an actual MCP handshake with a real client. The probe must prove, against real stored data, that: (a) every KG tool declares `stackId` as required and refuses a call without it with `isError: true` and zero downstream requests; (b) `list_stacks` returns the unified contract agreed in Project 2, identical in shape to the wiki dimension's tool; (c) a call with a valid `stackId` returns real rows from that Stack and never rows from another Stack; (d) a malformed UUID is refused before it reaches Postgres. Assert exact payloads, and assert that a refused call leaves stored data and counters unchanged.

S2. PER-RUN DATABASE ISOLATION. Every suite that touches Postgres gets its own database or schema per run, so a parallel suite cannot move another's counts and a teardown cannot look like a vanishing Stack. This is the durable fix for the class the previous two Projects could only de-flake: apply it to the KG suites and to the shared harness (`test/fixtures/kg-postgres.ts`, `rls-probe.ts`, `source-corpus.ts`, `test/fixtures/test-database.ts`), and prove it by running two suites concurrently that previously interfered.

S3. MAKE THE KG PACKAGE VISIBLE TO A GATE. Today `tsc -p packages/llmwiki-kg/ts/tsconfig.json` reports 20 diagnostics that no gate can see (root `tsc` reaches the package only transitively, `.fallowrc.json` ignores `packages/llmwiki-kg/**`, CI has no `tsc` step, and the package's own `typecheck`/`build` scripts are invoked by nothing). Make it visible: wire a gate that actually runs it (a CI step and/or a root project reference and/or an npm script that existing gates call), and pin a ratchet so new diagnostics fail while the current 20 are baselined. Fix what is cheap to fix; report precisely what remains baselined and why. Do not silently widen an ignore list — that is the defect, not the fix.

S4. `packages/llmwiki-kg/ts/src/db.test.ts:413` flakes under parallel load (`expected +0 to be 1`), green 15/15 isolated. S2 should remove the cause; if it does not, pin it with a deterministic test and explain what still races.

S5. THE FOUR DEAD QUICKSTART EXPECTATIONS. `test/quickstart-integration.test.ts` lines 291, 424, 438, 451 execute in no configuration: the skip predicate is a tautology because `testDatabaseUrl()` never returns an empty string. Project 2 replaced the false predicate with an explicit `it.skip` and the reason. Here you have the real database environment, so resolve them honestly — resurrect them under an explicit opt-in with a correct predicate and make them pass, or retire them with the documented reason they can never be true. Do not leave them skipped "temporarily".

S6. every test you touch asserts every observable effect of its rule (exact error text and argument name, exit codes, and that rejected input leaves stored data and counters unchanged), through public interfaces, never against internal storage.

S7. Test-first: one RED test per rule before implementing it. Every service you start must be stopped by its own teardown, on a port that cannot collide, and must not depend on a service a human started by hand.

S8. Gates, each reported with its exact scope: `npx tsc --noEmit`, `npm run build`, `npm test` (full — `scripts/test-affected.ts:68` resolves a stale upstream base so the affected tier cannot be trusted), `fallow`, and the KG package typecheck wired in S3.

S9. Out of scope, still open, not to be fixed on this branch: the two Project-1 wiki-dimension gaps — `src/compiler/index.ts:1191` with `indexgen.ts:63` and `obsidian.ts:128` as one indivisible change, and `src/utils/lock.ts` needing an env parameter.

## Tasks

T0 — Open this feature document and mirror it in memory. S1-S9. Route: worker. Commit: 7bcacad.
T1 — Provision the worktree's dependencies so any gate can run at all (`node_modules` is absent). S1-S8 prerequisite. Route: worker. Commit: none (install output only).
T2 — Per-run database/schema isolation for every suite that touches Postgres, applied to the four shared fixtures, then to the KG package's own route/core harnesses. S2, S4, S6, S7. Route: worker. Commit: 7f78ecf (shared fixtures), then the seven package harnesses in a53cc22.
T2b — Close the residual shared-database paths: `test/lock-postgres*.test.ts` on the per-run fixture, a comment-only note on the `vitest.config.ts` seed, and a reaper-safety case proving a live sibling and a foreign name are never candidates. S2, S6, S7. Route: worker. Commit: 6b0a805.
T3 — Wire a gate that runs the KG package typecheck and pin a ratchet over the 20-diagnostic baseline without widening an ignore list. S3. Route: worker. Commit: this slice (a commit cannot name its own SHA; the SHA is reported in T9's table).
T4 — The real end-to-end KG MCP probe: real Postgres, real KG API, `runStdio()`, real client handshake, exact payloads. S1, S6, S7. Route: worker. Commit: 1063fb2 (`test/fixtures/ephemeral-postgres.ts`, `test/kg-mcp-e2e/**`; the `export` edits to `per-run-database.ts` had already landed in `cd4b669`).
T5 — `db.test.ts:413` under parallel load. S4. Route: worker. Commit: pending.
T6 — Resolve the four inert quickstart expectations honestly (resurrect under an explicit opt-in with a correct predicate, or retire with a documented reason). S5. Route: worker. Commit: this slice (a commit cannot name its own SHA; the SHA is reported in T9's table).
T7 — Independent verification: one verdict per S#, run against isolated state. S1-S6. Route: gentle-ai-verify. Commit: none.
T8 — Gates: root `tsc --noEmit`, `npm run build`, full `npm test`, `fallow`, KG package typecheck. S8. Route: worker (commands) + Lead (acceptance). Commit: pending.
T9 — Final report: branch and head SHA, per-task commits, verdict per S#, e2e transcript, isolation proof, KG gate wiring and diagnostic baseline, exact test scope and result, blockers/UNAVAILABLE, scratch paths, Risk line. S1-S9. Route: Lead. Commit: none.
T10 — Remove the stray statement terminator that kept a fresh database from being built, and reword the per-run fixture's statement-splitter warning so it reads as unreachable. S2 (the isolation fixture's reason for the workaround), S7. Route: worker. Commit: this slice (a commit cannot name its own SHA; the SHA is reported in T9's table).
T6b — Replace the concept-page assertion that the ingest's own stub row already satisfied with one that pins the page the compile writes. S6, S5's honesty requirement. Route: worker. Commit: 2664ac2.
T11 — Make the build stamp name outputs that exist, so a repeated vitest run skips the ~21 s build and two concurrent runs cannot race inside tsup. S8 (gate integrity), S7. Route: worker. Commit: 35c40f8 (a commit cannot name its own SHA; the SHA is backfilled here, see L15).

## Log

L1 (human request, verbatim):
"Project 3: feat/reach-test
 Corrige el alcanze de la prueba,  Si querés prueba end-to-end del KG MCP con datos reales, hay que levantar Postgres + la API y te armo
 el probe."

L2 (Manager's standing rules, binding on every dispatched Agent, verbatim):
- Deletions are NEVER dispatched to an Agent. Not with literal paths, not pre-scoped, not at the end of a phase. Deletions go to the human as one documented command. Every attempt hits a native host approval prompt and stalls a generation; rule v2 is absolute.
- No command that can raise a native host approval dialog goes into an Agent's instruction. If one is needed, the Agent stops and reports.
- No Agent deletes, moves or cleans up anything: each leaves its scratch in place and reports the absolute paths it created. Teardown inside test code you author is normal test isolation and is not affected by this rule.
- AGENTS.md limits: code files <400 lines excluding comments, functions <40 lines, test files <400 lines, tests <40 lines.

L3 (evidence, recon of this worktree, 2026-11-04): HEAD is `dff1d31` = `feat/align-dimension`, branch `feat/reach-test` is local-only (no remote tracking ref), working tree clean, 14 commits between 2340970 and dff1d31. `odd/tasks/reach-test.md` did not exist. `packages/llmwiki-kg/ts/tsconfig.json` reports exactly 20 diagnostics (15x TS6133, 1x TS6192, 2x TS2344, 1x TS18046, 1x TS2571) across 8 files, all unused imports and unknown-typed locals. Nothing in the repository invokes that config: no CI `tsc` step (`.github/workflows/ci.yml` runs `release:check-docs`, `build`, `apply-schemas.sh`, `test`, `test:pack`, `fallow`), root `tsconfig.json:47-49` includes only `src/**/*` with `paths` mapping `llmwiki-kg` to the package source, `.fallowrc.json:30` ignores `packages/llmwiki-kg/**`, `tsconfig.test.json:9` does not reach the package, and `test-typecheck-baseline.json` has no `llmwiki-kg` entry.

L4 (evidence, defect record): `align-dimension.md` L16-L18's claim that the two route files the rename touched are "error-free" is wrong — `routes/aks/entities.ts` (5 diagnostics) and `routes/aks/traverse.ts` (6) both carry pre-existing unused-import diagnostics. The 20 are genuinely pre-existing (the rename touched 3 lines in those two files), but the sentence must not be trusted as a clean baseline claim.

L5 (evidence, stale pointers): S5's cited `test/quickstart-integration.test.ts` lines 291, 424, 438, 451 are the pre-T0 `skipIf` line numbers. After Project 2's T0 the four inert sites are at 302, 437, 452, 466. The spec quotation is kept verbatim; treat 302/437/452/466 as the operative sites.

L6 (evidence, blocker): this worktree has no `node_modules/` and no `tsc` on PATH, so no gate can run in place until dependencies are provisioned. Every gate result before provisioning is UNAVAILABLE, not green.

L7 (decision): S3's ratchet is a machine-checked baseline file, not a widened ignore list. A gate that greens by ignoring the package is the defect S3 names, so no task here may add `packages/llmwiki-kg/**` to `.fallowrc.json` or to any new ignore list.

L8 (decision): S5's two honest outcomes are both acceptable only with evidence — an opt-in resurrection whose predicate is provably false in the default environment and whose tests PASS under the opt-in, or a retirement that names why the expectation can never hold. "Skipped for now" is a defect, not an outcome.

L9 (evidence, T3 — the KG gate): `npm run typecheck:kg` (root `package.json`) runs `node scripts/kg-typecheck.ts`, which loads
`packages/llmwiki-kg/ts/tsconfig.json` exactly as `tsc -p ... --noEmit` does, collects error diagnostics and compares them
against `kg-typecheck-baseline.json`, keyed by `<repository-relative path> TS<code>` (never by line, so an unrelated edit
cannot rot an allowance); `npm run typecheck:kg:update` is the only way to change it and only accepts a decrease.
`.github/workflows/ci.yml` runs it as the step "Type-check the KG package against its diagnostic ratchet"
(`run: npm run typecheck:kg`), immediately after `- run: npm run build` in the `build-and-test` job — the gate of record.
Baseline before the fixes: 20 diagnostics across 9 entries (15× TS6133, 1× TS6192, 2× TS2344, 1× TS18046, 1× TS2571).
After: **empty** — `{"version":1,"typescript":"5.9.3","configuration":"53797bc6...","counts":{}}` over 225 checked
files, because all 20 were fixed rather than absorbed. Nothing remains baselined. 15 unused imports/locals and the one
all-unused import declaration were removed from `routes/aks/traverse.ts`, `routes/aks/entities.ts`,
`routes/aks-harness.ts`, `routes/ingest-harness.ts` and `routes/ingest-ontology-e2e.test.ts`; the two test-local row
interfaces in `routes/ingest-formation.test.ts` now `extends Record<string, unknown>` so `tx.execute<T>` accepts them; the
two `unknown` indexing sites in `routes/ingest-ontology.test.ts` narrow the jsonb audit blob to `Record<string, unknown>`
at the assertion that reads it. Root `tsc --noEmit` stayed exit 0 with 0 diagnostics; `tsconfig.build.json --noEmit` went
from 15 to 0. No ignore list was widened and `.fallowrc.json` was not touched. A root `tsconfig.json` project reference is
NOT feasible without making the package config `composite` (which forces declaration emit and `.tsbuildinfo`), so the gate
is the npm script plus the CI step.

L10 (evidence, T3 — the ratchet is not vacuous): clean run `npm run typecheck:kg` → "225 files checked; 0 diagnostics
baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no regression." exit 0. With `export const
kgRatchetProbe: number = "probe";` appended to `routes/aks/traverse.ts`: exit 1 and
`packages/llmwiki-kg/ts/src/routes/aks/traverse.ts:110 TS2322 Type 'string' is not assignable to type 'number'.
(packages/llmwiki-kg/ts/src/routes/aks/traverse.ts TS2322: 1 exceeds baseline 0); if this is deliberate, refresh with npm
run typecheck:kg:update`. The probe line was removed (grep count 0) and the clean run restored. The two suites touched by
the fixes ran green against a reachable database: `routes/ingest-formation.test.ts` 16 passed, `routes/ingest-ontology.test.ts`
11 passed. fallow feasibility, one bounded measurement with the `packages/llmwiki-kg/**` ignore line removed in a scratch
config (`/tmp/kg-fallow-probe.zZojWV/fallow-probe.json`): `fallow dead-code` reports 931 issues (722 unused files, 166
unused exports, 31 unused types, 7 unresolved imports, 5 duplicate exports). Making the package fallow-visible is its own
task: it needs the package's real entry points declared before those counts mean anything.

L9 (T2 implemented; mechanism, cost, proof, and the constraint that fixed the code's location):
- MECHANISM. Every test-file PROCESS gets its own Postgres database: created on first use, schema replayed from the list `scripts/apply-schemas.sh` declares (`SCHEMA_FILES` is PARSED from that script, never copied), verified against the tables the suites cannot run without, and dropped when the process ends through an `exit` handler and through SIGTERM/SIGINT. Databases left by a process that never tore down carry a run token in their name and are reaped at creation time once older than 30 minutes; reaping is age-based because dropping every sibling on sight would kill a live parallel worker's database.
- WHERE IT LIVES. Implementation: `packages/llmwiki-kg/ts/src/testing/per-run-database.ts`. Test-side entry: `test/fixtures/per-run-database.ts`, which binds the repository's resolver (`test/fixtures/test-database.ts`, contract untouched) and publishes the created database through `LLMWIKI_TEST_DATABASE_URL` (so sibling fixtures outside T2's surfaces follow it) and `AKS_DATABASE_URL` (so production paths that call `createDimensionsDatabase()` with no argument follow it too).
- WHY under `src/testing/` AND NOT `test/fixtures/`. The first version put the implementation in `test/fixtures/` and `db.test.ts` imported it; `npm run typecheck:kg` (wired in 2229464) then failed with two TS6059 diagnostics, because `packages/llmwiki-kg/ts/tsconfig.json` sets `rootDir: "src"` and a file under `src/` may not import anything above it. The location is the fix, not the config: `tsconfig.json` and the diagnostic baseline were not touched. Moving the implementation back to `test/fixtures/` re-breaks that gate.
- MEASURED COST. One suite database — create + 15-file schema replay + postcondition check — takes 251/227/224 ms, median 227 ms. `npx vitest run packages/llmwiki-kg/ts/src/db.test.ts` is 25.19 s wall clock, of which 21 s is the PRE-EXISTING `globalSetup` tsup build and 99 ms is the tests themselves; the fixture's own share is the ~0.23 s above, paid once per test file.
- CONCURRENCY PROOF. Three consecutive rounds, each running `packages/llmwiki-kg/ts/src/db.test.ts` in TWO concurrent processes: every run 15/15 passed, exit 0, and `expected +0 to be 1` appears in none of the transcripts. `db.test.ts` alone: 15/15 passed, exit 0. The same file under the package's own runner (`packages/llmwiki-kg/ts/vitest.config.ts`): 15/15 passed.
- `db.test.ts:413` OUTCOME: FIXED BY ISOLATION, not pinned. The three `withRequestTransaction` tests and `afterAll`'s `delete from stacks where domain like 't04-route-%'` are byte-identical to base; what changed is that the deletion can no longer match any database but the process's own. The class now has a deterministic assertion instead of a flake: `test/fixtures/per-run-database.test.ts` "leaves the surviving caller's rows and counts intact when another is torn down".
- TEARDOWN DEFECT FOUND BY MEASURING: with an `exit`-only hook, EVERY vitest worker leaked its database — a worker is torn down with a signal and Node does not emit `exit` for a signalled process. Two plain-node callers cleaned up perfectly (34 -> 32 databases), which is what made the difference visible. SIGTERM/SIGINT now drop first and then exit. After the fix, one representative run took `pg_database` from 7 -> 7 with zero per-run databases left, and the 25 databases leaked by the pre-fix iterations were removed by one deliberate pass of the fixture's own reaper (nothing else was running, so no live process could be affected).
- DEFECTS FOUND OUTSIDE T2'S SURFACES, reported, not fixed:
  1. `src/dimensions/wiki/migration_wiki_graph.sql:87` carries a stray `);` (present at the base and at the merge base), so that file cannot be parsed as one string and a FRESH database cannot be built by `scripts/apply-schemas.sh` at all: psql with ON_ERROR_STOP exits there, leaving the last seven schema files unapplied. The fixture replays file by file, falls back to statement granularity when a file will not parse, WARNS loudly naming the file and the failing statement, and then verifies the required tables exist — a genuinely missing table fails the creation.
  2. `scripts/build-stamp.ts` lists `packages/llmwiki-local-workflows/dist/index.js` in REQUIRED_OUTPUTS, and that package does not exist on this branch, so `isBuildFresh()` is false on EVERY run and every vitest invocation rebuilds `dist/` (~21 s). Two concurrent invocations therefore race inside tsup's clean+write and one dies before a single test loads. The concurrency proof above ran both processes with a scratch config (`/tmp/rtsql-concurrency-8TCoqd/vitest.concurrent.config.mts`: this repository's config with `globalSetup` emptied) so that the variable under test was isolation, not the shared build.
- RESIDUAL SHARING (named, not hidden): suites that resolve a DSN without importing any of the four fixtures keep the shared database — `test/lock-postgres*.test.ts` via `testDatabaseUrl()`, and the package's own runner for `src/routes/**` harnesses, which read `AKS_TEST_DATABASE_URL ?? localhost:5434/aks`.
- NO CHANGE NEEDED in `test/fixtures/test-database.ts` and `test/fixtures/rls-probe.ts`: the resolver's contract stays exactly as pinned (`test/test-database-fixture.test.ts` green, never `""`, falls back to DEFAULT_TEST_DATABASE_URL) and the RLS probe takes a database handle, not a URL.
- GATE EVIDENCE (exact scope): `test/fixtures/per-run-database.test.ts` 6/6 (RED first: `Cannot find module './per-run-database.js'`); `test/dimensions` 82 files / 477 tests passed, exit 0; `test/compiler` 5 files / 20 tests passed, exit 0; `npm run typecheck:kg` exit 0 (226 files, 0 diagnostics); `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` exit 0. `test/quickstart-integration.test.ts` + `test/test-database-fixture.test.ts` is CONTAMINATED BY A CONCURRENT WRITER: that file has uncommitted edits outside T2's surfaces that unskip S5's four inert expectations; at the base commit the same command is 15 passed / 4 skipped / 0 failed, and T2 reproduces the same 15 passing. Two T2-caused failures seen mid-work were real and are fixed: the fixture re-resolved its base URL after redirecting the resolver (so it provisioned a SECOND database, and `quickstart`'s ingest and read landed in different ones), and `AKS_DATABASE_URL` initially stayed at the shared value, which failed `rows-only-review-approve` and `rows-only-okf-import` with `review_candidates_stack_id_fkey`.
L10 (evidence, T2 commit): T2's work unit is `7f78ecf` — `test(isolation): give every Postgres suite its own database per run`. It holds `packages/llmwiki-kg/ts/src/testing/per-run-database.ts` (new), `test/fixtures/per-run-database.ts` (new), `test/fixtures/per-run-database.test.ts` (new), the isolation change in `packages/llmwiki-kg/ts/src/db.test.ts`, `test/fixtures/kg-postgres.ts` and `test/fixtures/source-corpus.ts`, and L9. The SHA itself cannot live inside its own commit, so it is recorded here in the commit that follows it, which touches no code.

L11 (evidence, T2b — the residual shared-database paths are closed; measured advisory-lock scope):
- JOB 1 — `test/lock-postgres*.test.ts` off `testDatabaseUrl()`. All three suites (`test/lock-postgres.test.ts`,
  `test/lock-postgres-integration.test.ts`, `test/lock-postgres-crossprocess.test.ts`) now take their DSN from
  `(await perRunDatabase()).url`, and each carries one wiring test that fails if the suite resolves back to the shared
  database: `isPerRunDatabaseName(new URL(DSN).pathname.slice(1))` is true and `DSN !== DEFAULT_TEST_DATABASE_URL`. The
  old `const reachable = DSN !== ""` skip predicate is gone — it was a tautology (`testDatabaseUrl()` never returns
  `""`; its contract is pinned by `test/test-database-fixture.test.ts`), the same class S5 names, and a suite that
  skips proves nothing. Provisioning now either succeeds or throws with the reason.
- ADVISORY-LOCK REASONING — does a private database weaken what these suites prove? An advisory lock is
  DATABASE-scoped, measured on this server with the driver the suites use: two sessions in two freshly created
  databases each acquired `pg_try_advisory_lock(19543, hashtext('/scope/probe'))`
  (`{"dbA_got_lock":true,"dbB_got_lock":true}`) and `pg_locks` held one `advisory` row per database. So a private
  database makes the lock SPACE private, and it weakens nothing the suites assert: every case passes the SAME DSN to
  both parties, so what is proven is that two sessions against ONE database contend for one key — exactly the
  production shape (two hosts sharing one Stack's database) and exactly what `tryAcquirePostgresLock`/`acquireLock`
  promise. What it removes is shared mutable lock state: no parallel suite can hold, leak or release a key in this
  suite's lock space, and `lockRegistry.size` cannot be moved by another file. Cross-process — and therefore
  cross-host — visibility stays covered, by `lock-postgres-crossprocess.test.ts` handing ITS DSN to a real `npx tsx`
  child and asserting the child is refused while this process holds the lock, then gets it after release.
- JOB 2 — `vitest.config.ts`. The `AKS_DATABASE_URL: testDatabaseUrl()` seed is unchanged and one comment line was
  added above it. Comment-only is proven twice: `git diff vitest.config.ts` shows one `+` line and no `-` line, and the
  same suite gives the identical result before and after the edit (`npx vitest run
  test/test-database-fixture.test.ts` — 1 file, 4 tests passed, exit 0, both times).
- JOB 3 — the reaper made provably safe, as three cases in `test/fixtures/per-run-database.test.ts` asserting through
  the fixture's own API (`reapStalePerRunDatabases`, `listPerRunDatabases`, `isPerRunDatabaseName`) plus catalog and row
  reads: (a) a LIVE sibling — a `spawn`ed `tsx` process that provisions its own database and keeps running — is not
  reaped, is still listed, still exists in `pg_database`, and still returns the row this process inserted into it;
  (b) a lookalike carrying the prefix AND a 45-minute-old stamp is not a candidate, because the NAME PATTERN is the
  gate (`isPerRunDatabaseName` false), and a name with an unrelated prefix is never even listed; (c) a stale-looking
  run token that DOES match the pattern is reaped, so (a) and (b) cannot pass against a no-op reaper. The exact
  assertion that makes a live sibling untouchable: `reapStalePerRunDatabases` drops only names matching
  `llmwiki_suite_<base36-stamp>_<pid>_<hex>` whose embedded stamp is more than 30 minutes old, so a database created
  seconds earlier by a running process is never a candidate and no prefix match alone can reach it.
- RED THEN GREEN. The fixture was ALREADY safe, so the cases were written asserting the UNSAFE outcome and then
  flipped. RED, same 4-file invocation: 5 failed / 15 passed — `expected [] to include 'llmwiki_suite_mw32ox1c_3657581_7b6a2e…'`
  (live sibling not reaped), `expected [] to include 'llmwiki_suite_mw31325x_not-a-run-token'` (lookalike not a
  candidate), and three `expected false to be true` from the lock suites' wiring tests (DSN still shared). GREEN after
  the change: 4 files / 21 tests passed, exit 0.
- GATES — `npx vitest run test/fixtures/per-run-database.test.ts`: 1 file / 9 tests passed, exit 0. `npx vitest run
  test/lock-postgres.test.ts test/lock-postgres-integration.test.ts`: 2 files / 10 tests passed, 0 skipped, exit 0.
  `npx vitest run test/lock-postgres-crossprocess.test.ts`: 1 file / 2 tests passed, exit 0. `npx vitest run
  test/test-database-fixture.test.ts`: 1 file / 4 tests passed, exit 0. `npm run typecheck:kg`: exit 0, 227 files
  checked, 0 diagnostics baselined, no regression. `npx tsc --noEmit`: exit 0.
- DEBRIS — queried after the gates, once the other worker sharing this worktree had finished: 0 databases matching
  `llmwiki_suite_%` on the server, 7 databases total (`aks`, `art_scratch`, `mig_scratch`, `postgres`, `template0`,
  `template1`, `tl_scratch`). The single per-run database seen mid-session belonged to that other worker's LIVE
  `test/quickstart-integration.test.ts` worker (`node (vitest 1)`, pid 3695905) and disappeared when its process
  ended — which is the live-sibling case of job 3 observed in the wild.
- STILL SHARED, named and NOT fixed (outside this task's edit surfaces): the KG package's own runner
  `packages/llmwiki-kg/ts/vitest.config.ts` still defaults `src/routes/**` suites to
  `AKS_TEST_DATABASE_URL ?? postgresql://aks:aks@localhost:5434/aks`, i.e. the one shared database, because those
  harnesses resolve their own DSN and the package config is not in this task's surface.
- COMMIT — this work unit is `6b0a805` (`test(isolation): close the residual shared-database paths`): the three
  lock suites, the `vitest.config.ts` comment line, the three reaper cases and this entry, in one slice. The SHA cannot
  live inside its own commit, so it is recorded here in the doc-only commit that follows, exactly as T2's is.

L11 (evidence + decision, T6 — the four inert quickstart expectations, S5/S6/S7). All four `it.skip`
sites in `test/quickstart-integration.test.ts` (L302/437/452/466 before this task) were proven inert
first: `npx vitest run test/quickstart-integration.test.ts --reporter=verbose` printed
`Tests 2 failed | 13 passed | 4 skipped (19)` and four `↓` lines -- none executed.
1. `preserves CompileResult.errors verbatim and reports compile.ok=false` — OUTCOME A, live in the
   default run. Old predicate: `it.skipIf(stackAlwaysOn)` where `stackAlwaysOn = testDatabaseUrl() !==
   ""`, a tautology (`testDatabaseUrl()` never returns `""`, `test/fixtures/test-database.ts:62-65`);
   Project 2 replaced it with `it.skip`. New predicate: NONE -- it runs unconditionally, because the
   only prerequisite (a reachable database carrying the suite's Stack) is what `useStackEnv` already
   provides. Contention is now real: `test/fixtures/quickstart-lock-holder.ts` queues a BLOCKING
   `pg_advisory_lock` behind the child's ingest, deriving the lock's `classid` from the production
   helper (`tryAcquirePostgresLock`) instead of copying the private namespace constant. Holding it up
   front is not an option: the ingest takes the same fail-fast lock (`tryWithOrdinaryMutationLock`), so
   an up-front holder fails the INGEST, not the compile. RED, captured by restoring the old body live:
   `expected true to be false` at `expect(compile.ok).toBe(false)` -- the seeded `.llmwiki/lock` FILE
   contends with nothing, so the compile succeeded. GREEN: 4 consecutive passes, 3 of them isolated
   (`-t "lock contention"`), the whole-file run at 16 passed | 3 skipped. S6: the test asserts the
   exact exit code (0), the exact returned string (`Could not acquire .llmwiki/lock — another compile
   is in progress.`), all four zeroed counters plus `pendingCandidates: 0`, the untouched viewer
   envelope, the exact `next` action, and the stored state (one source document, one concept row --
   the ingest's own stub, per `src/dimensions/wiki/store-dimension.ts`, with no compiled page added).
2-4. `prints the lifecycle line and hands off...`, `suppresses the Next: line...`, `preserves a
   non-view Next: recommendation...` — OUTCOME C, retired in place (`describe "... — RETIRED"`), not
   executed here. Predicate: NONE, because no predicate can make them true: `quickstart` gates the
   handoff on `hasRenderablePages(collectProjectState(root))`, and `collectProjectState`
   (`src/project/state.ts:170-181`) counts pages as MARKDOWN FILES under `wiki/concepts`/`wiki/queries`
   while a compiled page is a Postgres ROW (`src/dimensions/activation.ts:16` -- the file-backed wiki
   dimension is gone). Measured: a run that reports `1 compiled` and `Index updated with 2 pages` still
   collects 0 pages and ends with `next: llmwiki compile`, so the handoff never starts and the `Next:`
   suppression it exercises is never reached. The old comment's reason (a 33-char fixture under the
   compile minimum) is a red herring: the fixture DOES compile a page, and the collector still reports
   zero. Diagnostic proof that the blocker is the page source of truth and nothing else: seeding one
   `wiki/concepts/*.md` file (reverted, never committed) makes the first of the three pass -- the
   lifecycle line, the readiness URL and the handoff all work. Reviving them is a product fix in
   `collectProjectState`/`quickstart` (out of this branch's scope), after which un-skipping suffices.
   Deletion command for the human, NOT executed: `sed -i '489,555d' test/quickstart-integration.test.ts`
   (removes the whole RETIRED describe), then drop the now-unused `useQuickstartProcessLifecycle`,
   `LLMWIKI_DIR` and `LAST_LINT_FILE` imports.
Tautology sweep (repo-wide, `testDatabaseUrl() !== ""` and `DSN !== ""` forms): three sites existed
OUTSIDE this task's surfaces and were REPORTED rather than edited -- `test/lock-postgres.test.ts:15`,
`test/lock-postgres-crossprocess.test.ts:19`, `test/lock-postgres-integration.test.ts:17`, each reading
`const reachable = DSN !== ""` over `DSN = testDatabaseUrl()`, i.e. the constant `true`. While T6 ran,
the concurrent T2 work replaced all three with `const DSN = (await perRunDatabase()).url` and no skip
gate at all; a post-sweep re-scan finds no live `skipIf`/`skip` predicate anywhere in the repository
built on `testDatabaseUrl()`, only comments that name the old tautology. No edit from T6 was needed.
Measured collateral: the same file carried two failures before this task
(`writes the compiled concept page into wiki/concepts/`, `preserves the ingested source and emits
compile.error.code=provider_unavailable`, both `expected 0 to be greater than or equal to 1`) while T2's
fixtures were mid-flight (stderr: `per-run database: src/dimensions/wiki/migration_wiki_graph.sql could
not be replayed as one statement`); once that work settled, both pass with no change from T6.


L12 (T10 — the stray statement terminator in `src/dimensions/wiki/migration_wiki_graph.sql`, fixed; structural proof, fresh-database proof, table-set equality, warning rewording):
- THE DEFECT, STRUCTURALLY. Line 88 held a bare `);` and it belongs to NO surviving statement: it is the terminator of the
  `create table if not exists wiki.relation_edges (...)` that commit `289da5f` ("retire the artifact and relation row
  substrate") deleted line by line. That surgery removed the CREATE's body and its three indexes but not the one line that
  closed the CREATE. The file's own `create table if not exists wiki.event_log (...)` closes at line 76 with its own `);`,
  so line 88 DUPLICATES a terminator instead of closing anything still open, and it is not inside a `$tag$` body, so no
  function or DO block is involved. Context, base file: `75:    primary key (stack_id, seq)` / `76:);` = the event_log
  CREATE, correctly terminated; `85-87` = the `-- Relations: the typed edges the events record` separator whose statement
  was deleted; `88:);` = its orphaned terminator. psql reports `LINE 1: );`, i.e. the empty prefix before the `)` parsed as
  no statement at all, which is what a terminator with no statement looks like.
- ONE MALFORMATION ONLY, verified rather than assumed: with the token gone all fifteen files parse as one string, so no
  other file in the list carries the same residue, and no other statement in this file is touched. The author's intent is
  restored, not approximated: the `);` became a three-line comment recording that the relation statements were removed and
  that their terminator outlived them. `git diff -U2` is a single hunk at 86-88: one line out, three comment lines in.
- RED (before the fix; fresh empty database `red_probe` on a throwaway `pgvector/pgvector:pg16` container, `PSQL` wrapper):
  `./scripts/apply-schemas.sh` applied seven files, then `applying src/dimensions/wiki/migration_wiki_graph.sql` gave
  `ERROR:  syntax error at or near ")"` / `LINE 1: );` and exit 3. Consequence measured, not asserted: 16 tables and 15
  policies, meaning the tail of that file (the event_log RLS policy, its grant, the `alter column at type text`
  convergence) and the last seven files never ran, and `CHECK_ONLY=true` on that database exited 1 with `MISSING RLS:`
  naming `wiki.embedding_store_meta`, `wiki.project_config`, `wiki.event_log`, `wiki.review_candidates`,
  `wiki.embedding_refresh_marker`, `wiki.lint_cache`, `wiki.rule_extractor_state`, then `drift detected.`
- GREEN (same script, fresh empty database `green2_probe`, final bytes): all fifteen files applied, `done.`, exit 0; the ten
  required tables present (`public.stacks`, `public.stack_documents`, `public.document_chunks`,
  `public.ontology_entities`, `public.ontology_relationships`, `public.entity_source_documents`, `public.entity_pages`,
  `public.backfeed_queue`, `wiki.pages`, `wiki.source_documents`); `CHECK_ONLY=true` gave `policies: 25` and
  `ok: every tenant table enforces row-level security.` exit 0.
- TABLE-SET EQUALITY (25 tables, schema-qualified, `information_schema.tables` over `public`+`wiki`), three independent
  databases, `diff` empty on every pair: the real script on the fixed bytes; the fixture's statement-splitter fallback over
  the BASE file (measured by reverting the token for one run and restoring it in the same command); and the fixture's
  whole-file path on the fixed bytes. The workaround was therefore masking nothing else: it produced exactly the schema the
  script produces now, its only other effect being the warning.
- THE FALLBACK STAYS; ITS WARNING NOW SAYS IT IS DEAD. In `packages/llmwiki-kg/ts/src/testing/per-run-database.ts` only
  `applyFile`'s doc comment and `applySchema`'s warning string changed: no branch, no statement order, no logic. The new
  text is `per-run database: UNEXPECTED statement-splitter fallback for <file>. Every file scripts/apply-schemas.sh lists
  is expected to replay as ONE statement, so this path should be unreachable and the file is malformed: N statement(s)
  failed: ...`, and the doc comment states that the path should now be unreachable and stays only as a last-resort guard.
  That is the difference between a diagnostic and a workaround nobody reads.
- GATES (exact scope): `npm run typecheck:kg` exit 0, 227 files, 0 diagnostics; `npx tsc --noEmit` exit 0;
  `npx vitest run test/fixtures/per-run-database.test.ts` 9/9 passed exit 0; `npx vitest run
  test/dimensions/wiki-activation-stack.test.ts test/dimensions/kg-postgres-integrity.test.ts` 2 files / 5 tests passed
  exit 0, neither skipped. Teardown: container `t5a-schema-probe` stopped and removed, `docker ps -a` shows no such name.
- REPORTED, NOT FIXED: two inert comment blocks remain where the relation statements were (the `-- Relations:` separator
  and the `-- Dedup key:` paragraph above the RLS section). They are comments, not SQL, so they are not a malformation;
  the file header already documents that `wiki.relation_edges` was retired, and deleting them would be unrequested scope.
  Scratch left in place: `/tmp/t5a-sql-typo-3636522/` (`psql-probe` wrapper, `fixture-tables.mts`, the three table dumps,
  `fallback-run.log`, `graph-head.sql`).

L13 (evidence, T4 — the end-to-end KG MCP probe; S1, S6, S7). Files: `test/fixtures/ephemeral-postgres.ts` (new),
`test/kg-mcp-e2e/{counting-proxy,kg-api-child,kg-mcp-child,probe-database,probe-harness}.ts` (new),
`test/kg-mcp-e2e/kg-mcp-probe.test.ts` (new), plus the export of two EXISTING helpers in
`packages/llmwiki-kg/ts/src/testing/per-run-database.ts` (`withClient`, `applySchema`; `export` keyword only, no
behaviour change) so the probe replays the same SCHEMA_FILES list and the same statement-granularity fallback instead of
keeping a second copy.
- ENTRY POINT, and why. The API is spawned as a real child: `node packages/llmwiki-kg/ts/dist/index.js` with `PORT` set
  to an OS-granted port. NOT `createApp().listen(0)`: importing `src/index.ts` is impossible (it binds a listener at
  import and `process.exit`s on a bad config), and `listen(0)` on `createApp()` would skip exactly the parts a probe
  must not skip — `PORT` parsing, `validateConfig`, the Drizzle pool built from `DATABASE_URL` at first access. The port
  strategy is the only one that entry allows: bind port 0 on loopback, release it, hand the number to the child as
  `PORT` (a probed free port). The MCP server is spawned by `StdioClientTransport` and started through `runStdio()` from
  `dist/mcp/server.js`, not `dist/mcp.js` — the public surface module does not re-export `runStdio`, which is how the
  first run failed (`TypeError: runStdio is not a function`). Postgres is a container this test owns:
  `docker run -d --name llmwiki-probe-… --publish 127.0.0.1::5432 --label llmwiki-probe=1 pgvector/pgvector:pg16`, port
  read back from `docker port`, so collisions are structurally impossible and nothing a human started is involved.
- COUNTING PROXY. `test/kg-mcp-e2e/counting-proxy.ts` is a transparent `node:http` server on `listen(0)` that records
  `{method, path, body}` and forwards to the real API, returning its status and body verbatim. `AKS_BASE_URL` points at
  it, so `fetchImpl` is never injected and the MCP server cannot tell it apart from the API. Its counter is what makes
  "zero downstream requests" measurable, and one test (`forwards a named Stack to the real API`) proves the zero is not
  vacuous: the same counter reads 1 for `POST /aks/v1/context` when a call DOES carry a valid `stackId`, and the recorded
  body carries that exact id.
- PROOF PER CLAUSE (test names are in `test/kg-mcp-e2e/kg-mcp-probe.test.ts`).
  (a) `advertises stackId as required on every graph tool` — `tools/list` over the real handshake: `required` is
  `["query","stackId"]` for `query_stack`, `["start","stackId"]` for `traverse_stack`, `["stackId"]` for `get_entities`,
  and absent for `list_stacks`. `refuses each graph tool without stackId, with zero downstream requests` — each of the
  three answers `isError: true`, the exact text `Error: 'stackId' must be provided.`, the proxy records no request at
  all, and the four row counts are unchanged.
  (b) `answers list_stacks with the shared {stacks, count} contract` — envelope keys exactly `["stacks","count"]`,
  `count === stacks.length`, each entry's keys exactly `CONTRACT_STACK_KEYS` (the constant the cross-dimension suite
  `test/mcp/list-stacks-contract.test.ts` pins, imported from `packages/llmwiki-kg/ts/src/mcp-harness.ts`), and both
  seeded Stacks compared field for field, `isCurrent` false in both because this dimension has no bound Stack. WHY THIS
  ROUTE: the wiki dimension's equivalent is already driven against that same constant by the cross-dimension suite;
  driving the wiki server again here would need a second server, a second ScratchProjectRoot and a bound Stack, and
  would re-pin a contract that already has its own pin — what S1(b) adds is that the KG side satisfies the SHARED
  contract against a REAL API rather than a recorded body, and that is what this case asserts.
  (c) `returns only the rows of the Stack it was given` and `traverses only within the Stack it was given` — two Stacks
  with disjoint vocabulary (`Alpha …` / `Beta …`) seeded in the container; `get_entities` and `traverse_stack` are
  called once per id and the FULL formatted payloads are compared byte for byte, then each payload is asserted not to
  contain the other Stack's name. `query_stack` is deliberately not asserted on a model answer: its `POST
  /aks/v1/context` path needs an embedding provider and an LLM, which would be a simulated dependency. It is asserted at
  the boundary where its Stack matters — the request it sends — in the `forwards a named Stack` case, and the API's
  providers are configured to an unreachable loopback port so the run stays offline and deterministic.
  (d) `refuses a malformed Stack id before any request reaches the API` — `not-a-uuid` on all four tools answers
  `isError: true` with `Error: 'not-a-uuid' is not a Stack id. Stack ids are UUIDs — call list_stacks to see the ones
  this endpoint can reach.`, the proxy records no request, and the row counts are unchanged.
- TEST-FIRST. RED observed against a deliberately wrong expectation: `MISSING_STACK_TEXT = "Error: 'stackId' is
  required."` failed with `expected 'Error: 'stackId' must be provided.' to be 'Error: 'stackId' is required.'` on
  `query_stack`, i.e. the text came out of a real stdio handshake against a real API. Two further expectations were
  wrong for real reasons and were corrected from the observed payloads: timestamps arrive with microsecond precision
  (`2026-01-01T00:00:00.000000Z`, not `.000Z`), and `traverse_stack` renders depth 1 with a two-space indent
  (`"  • … (depth 1, conf 0.75)"`), not depth 0. GREEN: 7/7.
- MEASURED (ms, three consecutive green runs): package build 4079 / 4151 / 4240 (cold-FS first run: 16.0 s);
  container ready 1336 / 1345 / 1360; schema applied 173 / 175 / 175 (fifteen files, whole-file path, the
  statement-granularity fallback no longer fires after L12); seed 21 / 22 / 29; API ready 739 / 741 / 741; MCP handshake
  188 / 193 / 198; `npx vitest run test/kg-mcp-e2e` 32.0 / 32.5 / 37.0 s wall clock, of which the root `globalSetup`
  tsup build is ~21 s.
- TEARDOWN. `afterAll` calls one `stop()` that unwinds in reverse registration order (MCP child → proxy → API child →
  pool → `docker rm -f`). MEASURED DEFECT AND FIX: with only the success path tearing down, the first run — which failed
  inside the handshake — left `llmwiki-probe-kg-mcp-e2e-ea040fe6` running. `bringUp(undo)` now registers each piece's
  undo the moment the piece exists, so a failure anywhere unwinds what was started; re-measured by pointing the MCP
  entry at a module without `runStdio` on purpose: the suite failed and `docker ps -a --filter label=llmwiki-probe=1`
  came back EMPTY. The MCP child is additionally proven gone (`process.kill(pid, 0)`) before `stop()` resolves.
- GATES (exact scope). `npx vitest run test/kg-mcp-e2e` → 7 passed / 0 failed, 32.0 s. `npm run typecheck:kg` → "227
  files checked; 0 diagnostics baselined across 0 entries; no regression." exit 0. `npx tsc --noEmit` → no output,
  exit 0. `npx vitest run test/dimensions/kg-postgres-integrity.test.ts` → 4 passed, exit 0.
  `docker ps -a --format '{{.Names}}|{{.Status}}'` after the final run → no `llmwiki-probe-*` entry; `llmwiki-kg-db-1`
  untouched (Up 14 hours).
- COMMIT: NOT MADE BY THIS WORKER. Terminal git actions are parent-owned, and a concurrent writer is committing in this
  same worktree, which already caused a real incident: the `export` edits to `per-run-database.ts` were swept into
  `cd4b669` ("fix(schema): remove the stray statement terminator …"), a commit about something else. That export is in
  HEAD, so the parent's slice for T4 is `test/fixtures/ephemeral-postgres.ts` + `test/kg-mcp-e2e/**` + this Log entry.
- SCRATCH LEFT IN PLACE (not deleted, per L2): container `llmwiki-probe-kg-mcp-e2e-ea040fe6` from the pre-fix failed
  run — remove it with `docker rm -f llmwiki-probe-kg-mcp-e2e-ea040fe6`. The package build wrote
  `packages/llmwiki-kg/ts/dist/` (gitignored). No temp directory was created outside the worktree.
- COMMITTED: `1063fb2` — the parent staged only `test/fixtures/ephemeral-postgres.ts` + `test/kg-mcp-e2e/**` and committed
  them as `test(kg-mcp): probe the KG dimension end to end over a real handshake`; this Log entry itself had already
  landed in `8244405` ("test(quickstart): resolve the four inert expectations honestly", a concurrent writer).

L11 (evidence, T2's remaining scope — the KG package's own harnesses; S2, S6, S7):
- WHAT WAS SHARED. The package's own route/core suites were left out of T2 and still resolved ONE
  database: `routes/{aks,pages,ingest,documents,backfeed,stacks}-harness.ts` and
  `core/consolidation-harness.ts` each opened `AKS_TEST_DATABASE_URL ?? postgresql://aks:aks@localhost:5434/aks`
  directly. (Correction to the task brief: all seven already read the variable; `backfeed-harness.ts` and
  `stacks-harness.ts` only split the expression across lines, so a line-26 grep reads them as hard-coded.)
- WHAT THEY DO NOW. Each of the seven provisions this PROCESS's database through the one implementation T2
  built (`src/testing/per-run-database.ts`, reused, not reimplemented) at module load, replacing the bare
  reachability probe. Exported names and shapes are unchanged, so none of the 42 consuming suites needed an
  edit. New export per harness: `TEST_SERVER_URL` (the server). `TEST_DATABASE_URL` keeps its name and now
  holds the per-run URL — that is how a suite reaches its database, and how it can build an environment
  pointing at the right one (`state.client` / `database()` are unchanged).
- TEARDOWN. No suite calls anything new. The database is dropped by the mechanism T2 already owns
  (`perRunDatabase`'s `dropOnExit`: process exit plus SIGTERM/SIGINT); each harness still ends its own pool
  in the `afterAll` it already had.
- `AKS_TEST_DATABASE_URL`. It stops meaning "the database the suites share" and keeps meaning "the server to
  provision on"; it is not obsolete, and it is not sufficient either. MEASURED: `.github/workflows/ci.yml:57`
  sets only `LLMWIKI_TEST_DATABASE_URL` (and `AKS_DATABASE_URL`) at 5432, so before this change every one of
  these suites resolved the absent `AKS_TEST_DATABASE_URL` to the 5434 default, found nothing there in CI,
  and skipped. The harnesses therefore resolve `AKS_TEST_DATABASE_URL`, then the repository resolver's
  `LLMWIKI_TEST_DATABASE_URL`, then the documented 5434 container — the DB is never named by any of them.
- CONCURRENCY EVIDENCE (S7's RED, then GREEN). Two processes running `src/routes/stacks-read.test.ts` at the
  same time, before the change: exit 1, `AssertionError: expected [ 'B', 'C', 'A', 'B', 'C', 'A' ] to deeply
  equal [ 'B', 'C', 'A' ]` at `stacks-read.test.ts:74` — one process read the other's stacks, because both
  harnesses used the one shared database and each `beforeEach(deleteFixtureRows)` deletes by domain prefix.
  Same two processes, after the change: both 2/2 passed, exit 0, transcript
  `/tmp/kg-s2-green.F3iVB3/a.log` and `/tmp/kg-s2-green-b.log` (RED transcript `/tmp/kg-s2-red.B.log`).
- THE DURABLE ASSERTION (new `src/routes/harness-database-isolation.test.ts`, 2 tests). What the suites could
  not express before: (a) `isPerRunDatabaseName(TEST_DATABASE_URL's database)` is true and the name is on the
  server's `pg_database` list — RED was `expected false to be true`; (b) a Stack written through the public
  `POST /stacks` survives a sibling per-run database being created and dropped, and is invisible inside that
  sibling. Both pass after the change.
- SUITE COUNTS, exact scope `cd packages/llmwiki-kg/ts && npx vitest run src/routes src/core`:
  61 files, 488 tests. Clean runs: 58 files passed, 3 skipped, 484 passed, 4 skipped, exit 0 (runs 2, 5, 8, 10).
  The 3 skipped files are the live-gateway suites (`ingest-gateway`, `aks-gateway`, `pages-gateway`), whose
  reason is their own `AKS_TEST_GATEWAY !== "1"` opt-in and is unaffected by this change.
- PRE-EXISTING RACE, FOUND AND NOT FIXED (outside these surfaces). Four of the ten gate runs were red with one
  to three assertion failures, all in the same family: a write's row not yet visible to the next statement.
  Cause: `createRequestTransactionWrapper` (`src/db.ts:341-358`) runs `database.transaction(handler)`, and the
  HANDLER sends the HTTP response, so the commit lands AFTER the client already has its answer — a follow-up
  statement sees pre-commit state. Observed shapes: `stack_documents_stack_id_fkey` (23503) at
  `ingest-harness.ts:250`, `audit = null`, `entities_absorbed: 1` on an "idempotent" second approve, and a 500
  on a repeat upload. It is not database identity: it reproduces with six fully isolated databases (5 of 6
  concurrent single-file runs failed), and two of the red runs overlapped another worker's root vitest + tsup
  build at load average 19 on 16 cores, which widens the same window.
- DEBRIS. After all runs: `pg_database` holds zero `llmwiki_suite_%` names and 7 databases in total, with no
  open session on a per-run database.

L14 (evidence, T6b — one false-positive assertion replaced with the effect it claimed; S6, S5's honesty requirement).
- THE ASSERTION. `it("writes the compiled concept page into wiki/concepts/")` asserted only
  `expect(await countConceptPages(cwd)).toBeGreaterThanOrEqual(1)`. `countConceptPages`
  (`test/fixtures/source-corpus.ts:94-106`) reads the Stack's page rows, and the INGEST's own stub row
  (`commitPageRow`, `src/dimensions/wiki/store-dimension.ts`) already satisfies that count — so a compile that
  wrote nothing still passed.
- THE OBSERVATION THAT DECIDED THE OUTCOME (a temporary probe inside the suite, removed afterwards, which dumped the
  directories and every page row after a printed happy-path run). ON DISK: `wiki`, `wiki/concepts` and `wiki/queries`
  are ABSENT — `{"wiki":"ERROR ENOENT","wiki/concepts":"ERROR ENOENT","wiki/queries":"ERROR ENOENT"}` — so the compile
  writes NO file on this backend and the test's file premise is false. IN THE DATABASE, this Stack's `wiki.pages` holds
  exactly TWO rows: `{"dir":"concepts","slug":"quickstart-concept","title":"Quickstart Concept","summary":"Concept
  produced by aimock for quickstart tests.","tags":["quickstart-test"],"body":"\nBody produced for the quickstart
  test.\n"}` (the COMPILE's page: frontmatter rendered, the stubbed prose) and
  `{"dir":"concepts","slug":"fixture-source","title":"fixture source","summary":"","tags":[],"body":"# Source\n\nA short
  source for the quickstart test.\n"}` (the INGEST's stub row: empty summary, no tags, the source bytes). A row premise
  is therefore true even though the file premise is not, which made this OUTCOME 1: assert the real effect.
- WHAT THE TEST ASSERTS NOW. A local helper `storedConceptPages()` reads the pages one by one through the same page
  read API (`listStoredPagesUnfiltered`) `countConceptPages` uses, reusing the file's existing `boundStackId()` and
  `boundDatabaseUrl()` so no second environment resolution appears. The test pins, exactly: the compiled page's
  title, summary, tags and prose; and a SECOND page — the ingest stub — with an empty summary, no tags, and the
  source's bytes. The compile's page is thus separated from the ingest's by fields only the compile writes
  (`summary`/`tags` from the rendered frontmatter, the stubbed page body) and by the fact that both rows exist.
  The test name no longer claims a `wiki/concepts/` FILE; it claims the Stack's concepts, which is what is stored.
- RED (probe, removed afterwards; commit `2664ac2` contains no trace of it). The same attribution applied to a run
  where the compile provably wrote nothing: `bootLockFixture()` plus `holdProjectLockOnNextRelease()`, which refuses
  the compile. The probe dumped `PROBE_INGEST_ONLY [{"slug":"fixture-source","title":"fixture source","summary":"",
  "tags":[],"body":"# Src\n\nThe compile-lock source for the quickstart integration test.\n"}]` — ONE row, the ingest
  stub — and failed with `AssertionError: expected undefined to be 'Concept produced by aimock for quicks...' //
  Object.is equality`, exit 1. The old `>= 1` passed on that very row, which is the false positive observed.
- GREEN. `npx vitest run test/quickstart-integration.test.ts -t "writes the compiled concept page" --reporter=verbose`
  → 1 passed | 18 skipped (19), exit 0. `npx vitest run test/quickstart-integration.test.ts` → 16 passed | 3 skipped
  (19), exit 0 — identical to the pre-change baseline (16 passed | 3 skipped | 0 failed); the 3 skips are T6's
  RETIRED viewer-handoff expectations and nothing else is skipped. `npx tsc --noEmit` → exit 0.
- COMMIT. `2664ac2` `test(quickstart): stop asserting a compile effect the ingest already satisfies`, staged with a
  pathspec naming ONLY `test/quickstart-integration.test.ts`. The untracked `test/fixtures/ephemeral-postgres.ts` and
  `test/kg-mcp-e2e/` (T4's, not this task's) were left untouched.
- WIDER THAN ONE LINE, REPORTED NOT FIXED: (a) T6's own task line still records no SHA although its work is
  `8244405`; (b) the file already exceeds AGENTS.md's 400-line test limit (555 pre-existing, 620 after this change),
  so its size is a defect this change did not create; (c) three Log labels are duplicated in this document
  (`L9`/`L10`/`L11` appear twice, `L11` three times) because concurrent workers numbered independently — this entry
  uses the next free label, `L14`.

L15 (T11 — the build stamp now names only outputs that exist; S8's gate integrity, S7's no-shared-build-race):
- DETERMINATION: `packages/llmwiki-local-workflows/dist/index.js` was STALE, not a build the repository failed to
  run. Five independent pieces of evidence: (1) root `package.json` `workspaces` is exactly
  `["packages/llmwiki-core", "packages/llmwiki-kg/ts"]`; (2) `ls packages/` is `llmwiki-core`,
  `llmwiki-dev-backend`, `llmwiki-kg`, `llmwiki-limited-isolation-backend` — no `llmwiki-local-workflows`;
  (3) `git log --diff-filter=D -1 -- packages/llmwiki-local-workflows/package.json` names `0374a5f
  refactor!: drop every subsystem outside the wiki and KG dimensions`, i.e. that commit DELETED the package;
  (4) root `tsup.config.ts` builds two entries, `src/cli.ts` and `src/index.ts`, both to `dist/`, and
  `scripts/tsup-command.ts`'s `buildCompilerDependencies` loops over exactly `["llmwiki-core"]`, so no build
  anywhere under this tree writes that path; (5) existence probe of the five required outputs — `dist/cli.js`,
  `dist/index.js`, `dist/index.d.ts`, `packages/llmwiki-core/dist/index.js` all EXISTS after a build, and
  `packages/llmwiki-local-workflows/dist/index.js` MISSING. So no route "make it real" existed: there is no
  package, no manifest entry and no tsup entry to point at a different path.
- ROUTE: drop that ONE stale entry, with the reason recorded in the constant itself. `REQUIRED_OUTPUTS` before:
  `["dist/cli.js", "dist/index.js", "dist/index.d.ts", "packages/llmwiki-core/dist/index.js",
  "packages/llmwiki-local-workflows/dist/index.js"]`. After: the same list without the last entry, plus a comment
  naming commit 0374a5f, the root manifest, and the two symptoms. The list is NOT emptied, `isBuildFresh()` is
  still conditional on stamp + outputs + inputs hash, and no entry was weakened: each survivor is a file a real
  build wrote in this session — `dist/cli.js` (root tsup entry `src/cli.ts`, tsup banner + `onSuccess`
  `scripts/copy-viewer-assets.mjs`), `dist/index.js` and `dist/index.d.ts` (root tsup entry `src/index.ts` with
  `dts: true`), `packages/llmwiki-core/dist/index.js` (`packages/llmwiki-core/tsup.config.ts` `entry.index:
  ../../src/core-index.ts` into `dist/`). `REQUIRED_OUTPUTS` is now exported so a test can hold each `packages/**`
  entry to a workspace the root manifest declares; that export changes no behaviour.
- TEST-FIRST (S7's rule, applied to the stamp itself). RED, `npx vitest run test/build-stamp.test.ts`:
  `Tests 2 failed | 11 passed (13)`, `AssertionError: expected false to be true` at `isBuildFresh` on a tree
  seeded with exactly what a build emits, and `AssertionError: packages/llmwiki-local-workflows/dist/index.js
  names packages/llmwiki-local-workflows: expected [ 'packages/llmwiki-core', …(1) ] to include
  'packages/llmwiki-local-workflows'`. GREEN after the one-entry removal: 13/13 passed, exit 0. The seed in that
  file now lists the four real outputs explicitly and is deliberately NOT read from `REQUIRED_OUTPUTS`, so the
  cases cannot go vacuous; a new case keeps the existence check honest by deleting
  `packages/llmwiki-core/dist/index.js` and demanding `false`.
- FRESHNESS IS REAL, NOT PERMISSIVE (wall clock, `/usr/bin/time`, repo root, real `vitest.config.ts` and real
  `test/global-setup.ts`): COLD — stamp cleared through the module's own `clearStamp()` (`isBuildFresh` printed
  `false`), run `22.53s` vitest duration / `23.22s` wall, i.e. the build ran. REPEAT immediately —
  `412ms` / `1.09s` wall. INVALIDATED — one doc line of `STAMP_VERSION` inside `scripts/build-stamp.ts` (a real
  hashed build input, `INPUT_DIRS` contains `scripts`) edited, run `22.68s` / `23.35s` wall. RESTORED — same line
  reverted by edit, run `22.32s` / `23.05s` wall. REPEAT after restore — `409ms` / `1.11s` wall. So the ~21s
  rebuild now happens only when an input genuinely changed, and the cache still refuses to trust an uncertain
  stamp. Nothing was deleted to produce these numbers.
- THE RACE IS GONE for the case that was broken. Three consecutive pairs, each TWO concurrent
  `npx vitest run test/mcp-stdio.test.ts` processes (backgrounded, `wait`ed, real `vitest.config.ts`, no scratch
  config): pair 1 `A exit=0 | Tests 1 passed (1)`, `B exit=0 | Tests 1 passed (1)`; pair 2 identical; pair 3
  identical. Zero `tsup`/`ESM`/`CLI Building` lines and zero `No test files found` in any of the six transcripts
  (`/tmp/build-stamp-concurrency-0GSPM5/pair{1,2,3}-{a,b}.log`). Before this change every one of those six
  processes rebuilt `dist/`; now all six skip it, so nothing enters tsup's clean+write.
- COUNTERFACTUAL, run once and reported as measured: the same pair with `LLMWIKI_TEST_FORCE_BUILD=1` (both
  processes rebuild) came back `exit=0` twice, `31.28s` and `31.07s`, `Tests 1 passed (1)` each — the tsup race
  did NOT reproduce in that single observation. So the honest statement is narrower than "two builders can never
  collide": what is proven is that the COMMON case (a developer or CI running one suite twice, or in parallel)
  no longer builds at all, and the residual window is the genuinely cold one — two processes starting with no
  fresh stamp, both building, which is pre-existing behaviour this slice does not change. Named as a risk, not
  claimed fixed.
- GATES (exact scope, final state). `npx vitest run test/build-stamp.test.ts` → 13 passed, exit 0, `415ms`
  (build skipped). `npx vitest run test/mcp-stdio.test.ts` → 1 passed, exit 0, `6.59s` wall — that suite spawns
  `node dist/cli.js`, so a skipped build is not a broken `dist`. `npx tsc --noEmit` → no output, exit 0.
  `npm run typecheck:kg` → `227 files checked; 0 diagnostics baselined across 0 entries in
  packages/llmwiki-kg/ts/tsconfig.json; no regression.` exit 0. `isBuildFresh(<repo>)` after the last build →
  `true`; `dist/cli.js`, `dist/index.js`, `dist/index.d.ts`, `packages/llmwiki-core/dist/index.js` all present.
- REPORTED, NOT FIXED (outside this task's surfaces — same deleted package, four more stale references on this
  branch): `package-lock.json:13` still lists `packages/llmwiki-local-workflows` under `workspaces` and
  `@atomicstrata/llmwiki-local-workflows` as a root dependency (line 20); `test/sdk/packaging.test.ts:29` still
  `npm pack`s `packages/llmwiki-local-workflows`; `contract-cordination.json:25` and `.fallowrc.json` still carry
  `packages/llmwiki-local-workflows/**`; `.github/workflows/publish.yml:70,186,192` still publishes and verifies
  it. The first is the one that matters operationally (a fresh `npm ci` against this lock names a directory that
  does not exist); it is a lockfile/CI decision, not a test-cache decision, so it is not this slice's.
- COMMIT: this slice — `scripts/build-stamp.ts`, `test/build-stamp.test.ts`, this entry and T11's task line,
  staged by explicit path. The SHA cannot live inside its own commit, so it is reported to the parent beside L15
  for the doc-only commit that follows, exactly as T2's (`7f78ecf`) and T2b's (`6b0a805`) were.
- SCRATCH LEFT IN PLACE (per L2): `/tmp/build-stamp-concurrency-0GSPM5/` — the six concurrency-pair transcripts
  (`pair{1,2,3}-{a,b}.log`), the single forced-build transcript (`forced-a.log`) and the forced-build pair
  (`coldpair-{a,b}.log`), each with its `.exit` file.

L16 (Project 3 close-out: reconciliation, build-stamp proof, four gates — S8's gate report, plus the C1 record
for S7's no-shared-build-race):
- SCOPE. Deliberately narrow close-out on a branch cut from `feat/reach-test`, whose previous Lead session died
  at the model-execution level. Four units only: reconcile the dead worktree, prove the build stamp, run the
  four gates, report. Out of scope by ruling: fixing any of the five open gaps, reworking per-run isolation,
  `src/dimensions/wiki/**`, and the template-database implementation.
- U1 — RECONCILE THE DEAD LEAD'S WORKTREE: NOTHING TO COPY.
  - `git -C /home/urgosxd/.herdr/worktrees/llm-wiki-compiler/feat-reach-test status --porcelain
    --untracked-files=all` → empty. No uncommitted source, test, or scratch content.
  - Both branch refs point at the same commit `35c40f89ded5a0c5d96628889e2ad3cf0f1607cb`;
    `git rev-list --left-right --count feat/reach-test...HEAD` → `0 0`; `merge-base` = `35c40f8`. Zero divergence.
  - `odd/tasks/reach-test.md` is byte-identical in both worktrees (sha256
    `9134f9bf764c6288ccbe2b6d5bcc2949afe67b29d5e57793678be53695c78a60`, 513 lines).
  - T4 is already committed as `1063fb2`. The dead worktree was read only and modified in no way.
- U2 — BUILD STAMP: ALREADY FIXED AT HEAD, PROVEN HERE.
  - `scripts/build-stamp.ts:53-66` `REQUIRED_OUTPUTS = ["dist/cli.js","dist/index.js","dist/index.d.ts",
    "packages/llmwiki-core/dist/index.js"]` — four real entries, list not emptied; the stale
    `packages/llmwiki-local-workflows/dist/index.js` entry appears only inside an explanatory comment. That is
    commit `35c40f8` ("fix(test): make the build stamp name outputs that exist"). The L9 defect record this
    supersedes described the pre-fix state.
  - ENVIRONMENT: `CI=1 npm ci --no-audit --no-fund` → exit 0, "added 463 packages in 5s", only EBADENGINE
    warnings (node v22.23.2 against `>=24`); lockfile unmodified afterwards. The fallback `cp -a --reflink=auto`
    of the sibling `node_modules` was therefore not needed; `cmp -s` of the two `package-lock.json` files
    returned 0 (identical) and is recorded for completeness.
  - `npx tsc --noEmit` → exit 0, empty output. `npm run build` → exit 0, 19.53 s.
  - `isBuildFresh()` IS `false` immediately after `npm run build` ALONE, because the stamp is written by
    `test/global-setup.ts` and not by the build; it becomes `true` after the first vitest run, with `inputsHash`
    `be3fc2feeaecad5602384e3bda550c05a5320ca3a0469a8e01ad68eaf067ff53`. A bare build therefore does not warm
    the cache.
  - FRESHNESS, real `vitest.config.ts`, `test/build-stamp.test.ts` (13 tests): cold run 19.54 s Duration /
    20.14 s wall; immediate repeat 320 ms Duration / 0.90 s wall; third repeat 0.91 s with `dist/cli.js` and
    `dist/index.js` mtimes UNCHANGED across it. 13/13 passed in all three.
  - CAVEAT FOR FUTURE PROOFS: `grep -ci tsup` on the transcripts returned 0 in all three runs and is NOT
    discriminating, because vitest swallows `globalSetup` child output on success. Freshness must be proven by
    wall time or output mtime, never by tsup line counts.
  - CONCURRENCY, the target that matters, on the real `vitest.config.ts`: two concurrent
    `npx vitest run packages/llmwiki-kg/ts/src/db.test.ts` → both `exit=0`, 15/15 tests each, 2.04 s wall each,
    started the same second, zero tsup lines. No assertion failure and no `23503` /
    `stack_documents_stack_id_fkey` symptom appeared.
  - No source change was needed; `scripts/build-stamp.ts` and `test/build-stamp.test.ts` were left untouched. The
    residual cold-cold race from L15 is unchanged and not claimed fixed.
- U3 — THE FOUR GATES, MEASURED.
  - `npx tsc --noEmit`: exit 0, 5,784 ms, zero bytes of output. PASS.
  - `npm run build`: exit 0, 19,042 ms. All four REQUIRED_OUTPUTS present: `dist/cli.js` 480,693 B;
    `dist/index.js` 425,652 B; `dist/index.d.ts` 6,844 B; `packages/llmwiki-core/dist/index.js` 22,169 B. PASS.
  - `npm test`, RUN A (environment overridden by the runner with a scratch `HOME`): exit 1;
    `Test Files 2 failed | 786 passed | 3 skipped (791)`; `Tests 2 failed | 5997 passed | 7 skipped (6006)`;
    Duration 256.82 s. One of the two failures was ARTIFICIAL: `test/provider-codex-agent-live.test.ts` failed on
    `codex login` because `~/.codex/auth.json` lives in the real HOME; re-run alone with the real HOME it passed
    1/1 in 5.0 s.
  - `npm test`, RUN B (inherited environment, one run, no retries): exit 1;
    `Test Files 6 failed | 782 passed | 3 skipped (791)`; `Tests 8 failed | 5991 passed | 7 skipped (6006)`;
    Duration 276.92 s; wall 277.51 s. The codex file PASSED in this run. Five of the six failing files are new
    relative to run A and all are KG live-database failures; the run's own suite database disappeared mid-run —
    `Unhandled Rejection: PostgresError: database "llmwiki_suite_mw35p5dm_4130922_119c511b" does not exist`, code
    `3D000`. Occurrences of `23503`: zero in the whole log. Run B was NOT on an idle machine:
    `load average: 10.21, 9.29, 6.94` on 16 cores, a stale `node
    …/feat-reach-test/packages/llmwiki-kg/ts/dist/index.js` process (pid 3678593, 86 min elapsed) from the dead
    Lead's worktree alive throughout, and two Postgres clusters up.
  - NO TRUE IDLE-MACHINE FULL-SUITE NUMBER WAS OBTAINED. Named as missing proof, not averaged.
  - GAP IN THIS RECORD, noted rather than filled: run A's non-artificial failure is never named here, and the
    load-independent red floor below is established by its own standalone run, not by run A's log. So "5 of the
    six failing files are new relative to run A" and "1 failed file independent of load" rest on two different
    observations, and this entry does not claim they are the same file.
  - LOAD-INDEPENDENT RED FLOOR, reproduced outside the suite: `test/commands/host-command.test.ts > omits the
    graph routes when the graph is disabled` fails alone at `1 failed | 2 passed` with a 20.02 s timeout and
    `Error: no readiness line in:` at `test/commands/host-command.test.ts:82`. BASE CONTROL at `dff1d31`: exit
    0, 3/3 passed, 2.963 s. Branch-caused. Mechanism observed: `test/commands/host-command.test.ts:88` emits
    `SIGTERM` in-process, which triggers the branch-new `dropOnExit` registration at
    `packages/llmwiki-kg/ts/src/testing/per-run-database.ts:431-438`; its `process.exit(0)` is absorbed by the
    test's `exitSpy`, so the worker survives with its suite database dropped.
  - MEASURED AMPLIFICATION of the load sensitivity, from these two runs: 1 failed file independent of load, 6
    failed files under load, i.e. ~5x. Consistent with the ~5x amplification the close-out brief attributes to
    gap 2.
  - `fallow`: not on PATH (bare invocation exit 127, `command not found`). `npx fallow` → exit 1:
    `✗ 2 exports · 1 unlisted dependency (0.23s)`, `3 issues · 11 suppressed · 0 stale suppressions`. Details:
    unused exports `test/kg-mcp-e2e/kg-mcp-child.ts:42 MCP_ENTRY` and `:78 processAlive`, both from the file added
    in `1063fb2`; unlisted dependency `postgres`, imported by `test/kg-mcp-e2e/probe-harness.ts:25` and
    `test/fixtures/ephemeral-postgres.ts:37` while declared only at `packages/llmwiki-kg/ts/package.json:22`.
    BASE CONTROL: exit 0, `✓ No issues found`. Branch-caused, FAIL. `fallow fix --dry-run` reports it would
    remove the export from `processAlive` and `MCP_ENTRY`; nothing was modified.
  - `test/sdk/packaging.test.ts`: not runnable via `npx vitest run` — `No test files found`, because the file is
    excluded at `vitest.config.ts:68` and was already excluded at base. Its only runner is `npm run test:pack`
    (`vitest run --config /dev/null`), which performs an `npm install` of ~17 registry dependencies; NOT
    EXECUTED → UNAVAILABLE, network prohibited. Static indication it would fail: `packDistribution` at `:26` sets
    `cwd` to `packages/llmwiki-local-workflows`, which `0374a5f` deleted.
  - `npm run typecheck:kg`: exit 0, `227 files checked; 0 diagnostics baselined across 0 entries … no
    regression.` PASS.
- SIXTH OPEN GAP — a dangling reference to a deleted package, with its install question answered.
  - `package-lock.json:13,20` still list `packages/llmwiki-local-workflows` and the dependency of that name while
    `0374a5f` deleted the package. Further references: `test/sdk/packaging.test.ts:29`,
    `contract-cordination.json:25`, `.fallowrc.json`, `.github/workflows/publish.yml:70,186,192`.
  - THE OPERATIVE QUESTION is whether a fresh clone of this branch can install at all. MEASURED ANSWER: yes.
    `CI=1 npm ci --no-audit --no-fund` in this worktree exited 0 with "added 463 packages in 5s" and only
    EBADENGINE warnings; the lockfile was byte-unchanged afterwards (`git status --porcelain` empty).
  - CONSEQUENCE: L15's inference that "a fresh `npm ci` against this lock names a directory that does not exist"
    is DISPROVEN for the install path. The residue is confined to the publish pipeline and to
    `test/sdk/packaging.test.ts`, which is excluded from the suite and cannot run without network.
  - REGENERATING `package-lock.json` was considered and REJECTED for this close-out as an unauthorized delivery
    change (risk item 5) on a branch whose purpose is to run four gates.
- CORRECTION TO INHERITED EVIDENCE. The close-out brief cited a "base 1/6 red vs HEAD 5/6 red" comparison and
  sha256 `2c176f41…` as coming from this document. They are NOT in this document. What L11 actually records is the
  respond-before-commit race at KG-subset scope (`cd packages/llmwiki-kg/ts && npx vitest run src/routes
  src/core`, 61 files / 488 tests): four of ten gate runs red, five of six concurrent single-file runs failed,
  with `stack_documents_stack_id_fkey` (23503) among the observed shapes. The stronger figures exist only in the
  brief and are restated here as brief-supplied, never as measured by this document. (The label `L11` is itself
  duplicated in this file; the entry meant here is the KG-subset one quoted above.)
- RULE FOR FUTURE LEADS ON DELEGATED RECON. A recon claim about a commit, file, or line is unverified unless it
  carries the command that produced it and the output verbatim. Two delegates in this close-out produced claims
  that failed that test: one asserted a `scripts/build-stamp.ts` comment whose wording mirrored the prompt it had
  been given, and one reported `git cat-file -t 0374a5f` failing with exit 128 — `0374a5f` is a real commit. Both
  came from a definition with no `bash`.
- HARNESS DEFECT OBSERVED (for the human, not fixed here). The `gentle-ai-explore` agent definition declares
  `read, grep, find, codegraph, web_*` and no `bash`, so it cannot execute git or any command; repository-history
  recon is impossible for it and it fills the gap from its prompt. Recon for this project must be routed to a
  bash-capable read-only definition (`gentle-ai-verify` was used).
- AUTHORIZED BUT DELIBERATELY NOT IMPLEMENTED — the one named improvement. A per-run template database in
  `test/global-setup.ts` plus `CREATE DATABASE … TEMPLATE` per file. Briefed estimate: provisioning falls from
  ~0.25 s to ~50 ms per suite, shrinking this branch's amplification of gap 2 (measured here at ~5x). STATUS:
  PENDING. Not measured in this close-out, and left out on purpose to keep the assignment small. No prior Log
  entry described it.
- LEFT OPEN AT THE END OF THIS CLOSE-OUT (corrected by `L17`). The five gaps are unchanged. The sixth gap stands
  as recorded above, with its install question answered. The two measured reds recorded here — the
  `SIGTERM`/`dropOnExit` teardown defect (`test/commands/host-command.test.ts`, green at base) and the three
  `fallow` findings — were subsequently authorized by the owner and fixed in the two units recorded in `L17`
  below. What remains open from those units is the set of residual hazards named in `L17`, not the reds. Head at
  the time of writing: `35c40f8`.

L17 (owner-authorized follow-ups — teardown fix, `3D000` diagnosis, `fallow` cleanup):
- OWNER'S RULING. No exemption from AGENTS.md's pre-commit gate: the red gate found two real defects and both were
  fixed as their own units before the documentation commit.
- FIX 1 — PER-RUN TEARDOWN (`packages/llmwiki-kg/ts/src/testing/per-run-database.ts`).
  - CAUSE. At `35c40f8` the module registered `process.once("exit", drop)` plus
    `process.once(SIGTERM|SIGINT, () => { drop(); process.exit(0); })` (`:422-439`).
    `test/commands/host-command.test.ts:100` emits the signal IN PROCESS; the handler dropped the worker's own live
    database and called `process.exit(0)`, which the suite's `exitSpy` (`:56-63`) absorbed. The worker survived
    with its database gone.
  - NEW DESIGN. The hook never calls `process.exit`; it drops only databases it owns, idempotently, keyed by a
    pid-checked ownership map; it removes only its own listeners; and it re-raises the ORIGINAL signal with
    `process.kill(process.pid, sig)`, restoring default disposition (SIGTERM 143, SIGINT 130) instead of a false
    exit 0.
  - DEVIATION FROM THE OWNER'S LITERAL SEQUENCE, recorded for review. The owner specified "drop, remove own
    listener, then re-raise". Implemented as "when another listener for that signal still exists, stay out of the
    way — that component owns the exit — and only re-raise when this hook is the last listener". The literal
    always-drop-then-re-raise order would NOT have fixed the defect, because the test's own handler still needs
    the database afterwards.
  - PROOF. `npx vitest run test/commands/host-command.test.ts` branch exit 0, 3/3, 3.18 s (pre-fix: 34.9 s with a
    20 s timeout); base `dff1d31` exit 0, 3/3, 3.51 s; `npm run test:affected` exit 0, `Test Files 626 passed
    (626)`, `Tests 4599 passed (4599)`, 158.76 s — the load-independent floor going 1 failed file → 0 on the
    identical 626-file/4599-test scope; two concurrent `db.test.ts` both exit 0, 15/15 each; suite-database debris
    0 before and 0 after (`total_databases=7` unchanged).
  - NEW REGRESSION TEST. `test/fixtures/per-run-database-signal.test.ts`, 3 tests, RED observed first (3 failed,
    three distinct assertions including
    `expected { code: +0, signal: null } to deeply equal { code: null, signal: 'SIGTERM' }`), then GREEN 3/3. It
    is integration-tier (`scripts/test-partition.ts:90-113`, it spawns a child), which is why the unit tier does
    not select it.
  - RESIDUAL RISKS, named and not fixed. (a) The discriminator is "is another listener registered for this
    signal", so a foreign `once` shutdown listener registered BEFORE the per-run hooks would make the re-raise
    branch kill the worker — today the fixture always registers first, so the ordering dependency is real but
    unenforced; (b) a foreign listener that neither exits nor re-raises leaves a one-`setImmediate` window where a
    genuine signal finds no hook; (c) behaviour change by design: a SIGTERM/SIGINT with no other listener now
    reports death-by-signal (143/130) rather than exit 0 — no existing caller asserted exit 0 after signalling.
- DIAGNOSIS 2 — THE `3D000` RED UNDER LOAD IS THE SAME DEFECT, NOT A NEW ONE.
  - Every `3D000` in every transcript traces to the old in-process SIGTERM path: five transcripts, one occurrence
    each, all naming the run's own database minted 1.8 to 114 s earlier.
  - CANDIDATE TABLE. The age-based reaper (`per-run-database.ts:69`, `:203-212`, `:535`) is CONTRADICTED as this
    cause — every affected database was under two minutes old, never 30 minutes. Worker reuse across files with a
    memoised handle is CONTRADICTED — the pid in each database name matches the live worker that owned it.
  - PREMISE CORRECTION. The five KG route-file failures in the same loaded run
    (`backfeed-{queue,approve,envelope,ontology}`, `documents-read`) were visibility assertions — `expected 200 got
    404`, `expected [] to deeply equal [Array(1)]` — i.e. inherited gap 2, with zero `23503`. Each transcript
    attributes its single `3D000` to `test/commands/host-command.test.ts`, not to the KG files.
  - RESIDUAL HAZARD, recorded and NOT fixed because it was never observed. The reaper filters by age only and has
    no ownership check, so a live database older than 30 minutes would still be dropped. Longest observed full
    suite: 320 s.
- INDEPENDENT CHECK 3 — THE TEARDOWN FIX IS EXONERATED FOR THE `db.test.ts` FLAKE.
  - `packages/llmwiki-kg/ts/src/db.test.ts:436` is `expect(await countByDomain("t04-route-404")).toBe(1)` read
    through a SEPARATE pooled connection after an HTTP call that answers before COMMIT (`db.ts:341-358`): a
    visibility/count-after-write assertion, i.e. gap 2. The file's own comment at `:34` already names "the
    intermittent `expected +0 to be 1` at the 404 case".
  - The fix is on the import path (`db.test.ts:17`) but executes only at process end; a dropped database would
    surface as `3D000`, which was absent.
  - A standalone probe reproduced the same race with teardown completely idle: 10 misses in 200 iterations (~5%).
  - FLAKE TABLE ON THIS TREE. Concurrent two-process proof 0 failures in 6 runs; solo 0 failures in 3. An earlier
    observation of `1 failed | 14 passed` on both concurrent processes was this gap-2 flake, not a regression.
  - A DURABLE PROBE exists in scratch at
    `/tmp/verify-causality-2N66yL/wt/packages/llmwiki-kg/ts/src/gap2-probe.test.ts`. It is deliberately NOT
    committed: it is RED today and would only go green once gap 2 is fixed.
- FIX 4 — `fallow` RETURNED TO EXIT 0.
  - `test/kg-mcp-e2e/kg-mcp-child.ts`: `export` removed from `MCP_ENTRY` (`:42`) and `processAlive` (`:78`);
    declarations and internal uses (`:74`, `:136`, `:91`, `:94`) untouched; grep proved no importer outside the
    file. File stays 155 lines.
  - `postgres` declared in the ROOT `devDependencies` as `"^3.4.9"`, matching
    `packages/llmwiki-kg/ts/package.json:22` and the lockfile's resolved `3.4.9`.
  - LOCKFILE DELTA. Exactly one line, inside the root entry's `devDependencies`;
    `git diff package-lock.json | grep -E '^[+-].*"version":'` shows no version lines changed.
  - DEVIATION, recorded. `npm install --package-lock-only` was NOT run in the worktree. An isolated probe showed
    npm 10.9.8 would also rewrite five pre-existing stale hunks outside the root entry — the ghost
    `packages/llmwiki-local-workflows` workspace and dependency, its link entry, a missing `express` in the kg
    workspace entry, and four esbuild `libc` metadata lines — which is precisely the owner's hard-stop condition.
    The single intended hunk was applied by hand; npm's only postgres-related delta is that identical line.
  - `npx fallow` now exits 0, `✓ No issues found`; base `dff1d31` was also exit 0, so parity is restored.
    `npx tsc --noEmit` exit 0.
  - OPERATIONAL NOTE for future installs: a real `npm install` here runs the root `prepare` hook (`husky`), which
    writes `.husky/_` outside a writer's surfaces — use `--ignore-scripts` in future lockfile instructions.
- CORRECTION TO INHERITED EVIDENCE, recorded at the owner's request. The "base 1/6 red vs HEAD 5/6 red"
  comparison and the sha256 `2c176f41…` quoted during this close-out came from a dead Lead's message and are NOT in
  this document. This document is authoritative; that restatement was unverified. The discrepancy is recorded here
  so it is not inherited again.
- ALSO RECORDED, WITHOUT FIXING. `test/sdk/packaging.test.ts` is excluded at `vitest.config.ts:68` (and at base),
  so it never runs in the suite; its only runner is `npm run test:pack`, which performs a networked install —
  UNAVAILABLE. Static indication it would fail: `packDistribution` (`:26`) cds into
  `packages/llmwiki-local-workflows`, deleted by `0374a5f`.
- HUMAN BATCHED-DISPOSAL LIST (never dispatched to an agent). `/tmp/verify-gates-y59Lrv/base` (689 MB base copy),
  orphaned process pid 3678593 (a `node …/feat-reach-test/packages/llmwiki-kg/ts/dist/index.js` from the dead
  session, 86+ min old), container `llmwiki-probe-kg-mcp-e2e-ea040fe6`, and the scratch directories of this
  close-out: `/tmp/u2-proof-ACKYLX`, `/tmp/u2-proof-scratch-path.txt`, `/tmp/verify-clean-npmtest.obOng0`,
  `/tmp/jd-fix-u4-test-affected.log`, `/tmp/u2-teardown-fix`, `/tmp/u2-teardown-probe`, `/tmp/u3-3d000-diag`,
  `/tmp/verify-causality-2N66yL`, `/tmp/fallow-lock-probe.7RWnXT`, `/tmp/fallow-base.txt`, `/tmp/fallow-after.txt`,
  `/tmp/fallow-dupes.txt`, `/tmp/fallow-dc.txt`.
- STILL OPEN. The five gaps from `L16` unchanged; the sixth gap (dangling references to the deleted package, install
  path proven to work); the reaper's missing ownership check; the teardown's ordering dependency and one-tick
  window; the nine-plus `llmwiki-local-workflows` reference sites; and gap 5, `engines.node >=24` against the
  runtime Node v22.23.2.

L18 (duplication slice and the fallow:ci baseline): `npm run fallow:ci` is the CI-parity gate.
`scripts/check-fallow-report.mjs` sums four counts (`deadCode + duplication + complexity + coverage`)
and sets a nonzero exit as soon as `total > 0`; there is no baseline, threshold or tolerance.
- It was ALREADY exit 1 at `35c40f8`, before any close-out unit, with 3 clone groups, all introduced
  on this branch: `2229464` added `scripts/kg-typecheck.ts:213-224` duplicating
  `scripts/typecheck-tests.ts:20-25` (12 lines); `6b0a805` added the `isPerRunDatabaseName` assertions
  duplicated across `test/lock-postgres-crossprocess.test.ts:49-57`,
  `test/lock-postgres-integration.test.ts:44-49` and `test/lock-postgres.test.ts:68-75` (9 lines,
  3 instances); `1063fb2` added `test/kg-mcp-e2e/kg-mcp-probe.test.ts:152-158` duplicating `:221-227`
  (7 lines).
- Base `dff1d31` and merge-base `8203862` both report 0 clone groups, so none of the three predates
  the branch; all three are this branch's own earlier commits.
- The regression test added by `730ecdb` contributed 2 further groups, taking the count to 5.
  Commit `4afb434` extracts `test/fixtures/child-report.ts` (`firstJsonReport(child, label)`, the label
  preserving each suite's original rejection message) and returns the count to 3, with both suites
  still green at 9 and 3 tests and no assertion, spawned command or expected code/signal changed.
- `npx fallow` exits 0 at every point (dead code clean throughout). `npm run fallow:ci` was exit 1
  because of the three groups above, which lay outside this close-out's edit surfaces; those three groups
  were subsequently deduped in `L19`, and `npm run fallow:ci` now exits 0. The measurements above are kept
  as recorded history.

L19 (owner follow-ups: the three dedupes, the reaper ownership guard, and the exit semantics we keep):
**Dedupes — `fallow:ci` is green.** The three clone groups were removed by honest extraction, with no
suppression comment, ignore directive, threshold or checker edit anywhere in the diff.
- `scripts/ratchet-baseline.ts` (new) holds `RatchetBaseline` and `parseRatchetBaseline(text, invalidMessage)`,
  the single copy of the baseline validation both `scripts/typecheck-tests.ts` and `scripts/kg-typecheck.ts`
  used to duplicate; the message stays a caller literal, so each ratchet still names its own baseline file.
- `test/fixtures/per-run-database-assertions.ts` (new) holds `expectPerRunDatabase(dsn)`, asserting both halves
  (name matches the per-run pattern, DSN is not `DEFAULT_TEST_DATABASE_URL`), called by the three
  `test/lock-postgres*` suites, whose names, why-comments and placement are unchanged.
- `test/kg-mcp-e2e/kg-mcp-probe.test.ts` gained a local `expectEveryCallRefused(probe, calls, {reason, text})`;
  both refusal cases still assert `isError`, the exact returned text, a zero-length request slice per call,
  and the before/after `counts()` envelope.
- Measured: `npx fallow` clone groups 3 → 0 and duplicated lines 55 → 0; `npm run fallow:ci` exit 1 → exit 0,
  "0 dead-code, 0 duplication, 0 complexity, 0 coverage findings". Base parity restated: `dff1d31` and merge
  base `8203862` both report 0 clone groups, so all three groups were this branch's own.
- Preserved: the four touched suites still run 19 tests and the ratchet suites 21 tests, unchanged case counts,
  exit 0 on both sides. The one shared parser that an unnamed gate also uses was differentially checked against
  the removed bodies over 15 inputs (valid, empty/negative/zero/float counts, counts-as-array, counts missing,
  version 2, version missing, non-string typescript, configuration missing, null, array, `{}`, malformed JSON):
  0 differences in returned value, thrown type or message.

**Reaper ownership guard — the latent destruction path is closed.** Reaping was by AGE ONLY, so a database whose
owning process was still alive became a candidate after 30 minutes; the same destruction class as the `3D000`
red, never fired because the longest observed suite was 320 s. `reapStalePerRunDatabases` now skips any candidate
whose name-embedded pid still names a running process (`pidAlive` via `kill(pid, 0)`, with `EPERM` read as alive
and any non-safe-integer or out-of-range value read as not alive), and the filter ANDs that gate with the age test.
- RED reproduced the real destruction before the fix: the reaped name embedded the LIVE test process's pid —
  `expected [ …(2) ] to not include 'llmwiki_suite_mw36xods_440283_c6ca2093'`, 1 failed | 9 passed.
- GREEN: 10 passed (10). The new case proves BOTH halves in one run — a stale-stamped database with a live owner
  survives, which an age-only reaper cannot satisfy — while a stale-stamped database with a dead owner is still
  collected, which a no-op reaper cannot satisfy, because both share one stale stamp and get opposite outcomes.
  A third assertion shows an impossible pid is collected and the reap does not throw.
- How the age is exceeded without a shortcut: `freshName()` mints `llmwiki_suite_<base36(now)>_<pid>_<hex>` and the
  reaper reads age from the name, so the test writes the same format with a stamp 45 minutes in the past — exactly
  what the production path writes for a real killed run. No sleep, no injected clock, no internal state read;
  every observation is `pg_database` through a real client plus the returned reap list.
- One pre-existing case was corrected as DATA, not as an assertion: "still reaps a stale run token" fabricated its
  debris with `process.pid`, the live test process, which the ruled guard must protect. It now uses a dead pid with
  identical assertions and test name. Proven with a non-mutating probe before the change.
- Residual, accepted and named: a RECYCLED pid reads as alive, so such debris leaks rather than being destroyed
  (errs toward keeping); and `pidAlive` treats pids above 4,194,304 as dead, which is unreachable under a default
  Linux `pid_max` and this repository's container.

**Intentional behaviour change — DO NOT REVERT.** After the teardown fix, a SIGTERM/SIGINT that reaches this
process as its LAST listener reports death by signal (SIGTERM 143, SIGINT 130) instead of `process.exit(0)`.
That is correct, not a regression: the old `process.exit(0)` was itself part of the defect that broke
`test/commands/host-command.test.ts`, and it was consumed by another component's `exitSpy`. A process killed by a
signal should report the signal. Any future change back to a silent 0 exit re-opens that defect.

**Two named limits of the teardown, accepted with their reasons.**
1. The discriminator is "is another listener still registered for this signal", which is an ORDERING dependency
   that the code does not enforce: a foreign `once` shutdown listener registered BEFORE this module's hooks would
   make the re-raise branch kill the worker. It is safe today only because the per-run fixture registers at module
   import, before any command registers shutdown. Enforcing it would require an explicit hand-off contract between
   components, which this close-out did not design.
2. If a foreign listener neither exits nor re-raises, the re-arm is scheduled with `setImmediate`, leaving a
   one-tick window in which a genuine signal finds no hook and the process dies without dropping. The consequence
   is bounded: the dead process's pid makes its databases legitimate reap candidates, and the ownership guard above
   is what makes that cleanup safe rather than destructive.

**Recorded, not fixed.** `node scripts/typecheck-tests.ts` exits 1 with "TypeScript version or test configuration
changed; review and regenerate the baseline explicitly". The digest is computed from `tsconfig.test.json` plus the
root `tsconfig.json`, neither of which this branch modified, so the pin was already stale at `975c558`; CI does not
run this gate. Regenerating the baseline is an owner decision.
