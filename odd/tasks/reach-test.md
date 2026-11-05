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
T2 — Per-run database/schema isolation for every suite that touches Postgres, applied to the four shared fixtures. S2, S4, S6, S7. Route: worker. Commit: 7f78ecf.
T3 — Wire a gate that runs the KG package typecheck and pin a ratchet over the 20-diagnostic baseline without widening an ignore list. S3. Route: worker. Commit: this slice (a commit cannot name its own SHA; the SHA is reported in T9's table).
T4 — The real end-to-end KG MCP probe: real Postgres, real KG API, `runStdio()`, real client handshake, exact payloads. S1, S6, S7. Route: worker. Commit: pending.
T5 — `db.test.ts:413` under parallel load. S4. Route: worker. Commit: pending.
T6 — Resolve the four inert quickstart expectations honestly (resurrect under an explicit opt-in with a correct predicate, or retire with a documented reason). S5. Route: worker. Commit: pending.
T7 — Independent verification: one verdict per S#, run against isolated state. S1-S6. Route: gentle-ai-verify. Commit: none.
T8 — Gates: root `tsc --noEmit`, `npm run build`, full `npm test`, `fallow`, KG package typecheck. S8. Route: worker (commands) + Lead (acceptance). Commit: pending.
T9 — Final report: branch and head SHA, per-task commits, verdict per S#, e2e transcript, isolation proof, KG gate wiring and diagnostic baseline, exact test scope and result, blockers/UNAVAILABLE, scratch paths, Risk line. S1-S9. Route: Lead. Commit: none.

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
