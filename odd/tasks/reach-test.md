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

T0 — Open this feature document and mirror it in memory. S1-S9. Route: worker. Commit: (recorded below).
T1 — Provision the worktree's dependencies so any gate can run at all (`node_modules` is absent). S1-S8 prerequisite. Route: worker. Commit: none (install output only).
T2 — Per-run database/schema isolation for every suite that touches Postgres, applied to the four shared fixtures. S2, S4. Route: worker. Commit: pending.
T3 — Wire a gate that runs the KG package typecheck and pin a ratchet over the 20-diagnostic baseline without widening an ignore list. S3. Route: worker. Commit: pending.
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
