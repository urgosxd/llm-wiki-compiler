# Feature: test databases are isolated per worker, or say so

Separate branch, started AFTER `feat/stack-authority-per-request` lands. NOT part of that feature: this document exists so the findings below are not lost in chat.
Evidence measured 2026-11-17 on branch `feat/stack-authority-per-request`; static audit only (grep/sed), no execution.
Population that produced the evidence: 860 test files, 103 that resolve a database handle, 16 that mint their own throwaway database, 87 that go through the ambient DSN.

## Specs

### S1 — The headline: CI's gate of record shares one database across workers.

This is the one that decides whether a green gate means anything.

`.github/workflows/ci.yml:60-61` sets BOTH `LLMWIKI_TEST_DATABASE_URL` and `AKS_DATABASE_URL` to
`postgresql://aks:aks@localhost:5432/aks`. Setting the first makes
`test/fixtures/testcontainers-postgres.ts:321-325` take the override branch (`"is set; no container
started"`), so CI never creates a per-run container database — **all four workers share one `aks`
database**, where a row written by one file can satisfy another file's assertion.

**This is the same defect class the previous feature existed to kill — a fact whose authority is
chosen by the entry point — sitting inside the gate of record. A green gate is therefore evidence
that the suite passed in some order, not that each file proved its own claim.**

Rule: the change must be justified by a **measured comparison, not an assertion** — the gate run
with the variable set and with it unset, reporting **population and wall clock for both**. A
one-line deletion that makes CI honest but several times slower is a real engineering decision and
not an obvious win.

**Measured conclusion for S1 (2026-11-17, gate of record `pnpm exec turbo run test --filter=//`, from `0507318eb237b97fa92f84cfbebac9881ddc1d54`):**
- Removing the variable costs **no multi-fold slowdown**. Arms are within ~10% of each other and the wall-clock ordering disagrees between two independent readings, so record both: `[set] 6:28.95–7:02.83` and `[unset, cold owned container] 6:40.25`. A cold container start is seconds: a focused file took ~5.7 s cold versus ~1.3 s adopting.
- **But removal alone delivers no isolation.** With the variable unset and a cold owned container, `public.stacks` in the shared default database held **0 rows** — while an earlier arm that adopted a seven-day-old container ended with **1 row, `domain='default'`**. Removing the line changes which SERVER the per-run databases live on; it does not decide whether a suite owns a database. Defects S2 and S3 were still live with the variable unset.
- **So the CI line lands WITH the code fixes, and is never claimed as sufficient on its own.**

### S2 — One suite has no isolation at all.

`test/mcp/stack-id-guard.test.ts:38` `const h = createDimensionsDatabase(process.env);` — no
`perRunDatabase`, no `createSuiteDatabase`, no `skipIf`, no skip reason. It connects to whatever
`AKS_DATABASE_URL` names and `createFixtureStack` (`:101-116`) inserts a row into `public.stacks` of
that database. The file's own comment says the opposite of what an earlier reading assumed: the
Stack is created BY the suite, because asserting on a Stack the environment happened to contain was
the bug. It was still unisolated — it created that Stack in whatever database `AKS_DATABASE_URL`
named.

**Done** — `b7493cd5fbc3c35710f70f498dd2f0779134a5cf`. The suite provisions its own database;
`test/mcp/stack-id-guard-isolation.test.ts` pins that the published URL carries this process's pid.
RED was behavioural: the suite read `postgres://test:test@localhost:32802/test`, a shared
container's default database.

### S3 — The isolation of 87 more suites is an import side effect that degrades silently.

The isolation of the suites that import `test/fixtures/kg-postgres.ts` is an import side effect that
degrades silently, but the population is NOT one shared database: `perRunDatabase()` always creates a
throwaway database, and it does so once per test file/process. Measured: an unset-variable run
produced **73 distinct per-run databases across 57 distinct pids, peak 9 concurrent**, against
`maxWorkers: 4` (`vitest.config.ts:73`). What the 87 importing suites shared was therefore the
SERVER, not the database.

The defect is the degradation, not the location: `test/fixtures/kg-postgres.ts:59`
`const SUITE = await perRunDatabase();` is what redirects the resolver, and when that call rejects
`:59-63` warns
`"kg-postgres: per-run database unavailable … Falling back to the shared database …"` and the same
`createDimensionsDatabase(process.env)` then points at shared state with no failure.

Record the lesson verbatim: **the defect is silent degradation to shared state; where the hoisted
call sits is not the defect.**

**Population, corrected.** `git ls-files '*.test.ts' | wc -l` = **872** tracked test files; **871
collected** (`test/sdk/packaging.test.ts` excluded by `vitest.config.ts`). The document's original
**860 is stale**. The figures 103 / 16 / 87 are **not reproducible by their stated method**: four
independent greps returned 87, 86, 67, 219 and 94 for closely-related patterns, because a grep finds
declarations, not executions. The measurable substitute is the execution-counted population: **73
distinct per-run databases per run, 57 pids**.

### S4 — The harness can silently adopt a developer's hand-migrated server.

`test/fixtures/testcontainers-postgres.ts:307-314` and `:271-292`: when no container starts or is
adopted, it probes `DEFAULT_TEST_DATABASE_URL` = `postgresql://aks:aks@localhost:5434/aks`
(`test/fixtures/test-database.ts:49`) and prints
`"WARNING: adopted the pre-existing server at … instead of starting a container; this run is not
isolated from that server"` (`:280-282`), with `:268-269` noting the run neither created nor owns
that state.

**Done** — `f49b40b788c83fe817a4c0a8753af4863dd04d16`. The branch no longer adopts: when no
container can be obtained and a server answers at the documented port, the run publishes an
`unavailable` record whose reason names that server and gives both ways out. In this harness the
outcome is a loud failure at the missing-database chokepoint, degrading to a reason-carrying skip
only under `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` — stricter than the "skip" this spec first asked for,
because a silent skip is a green that asserts nothing.

### S5 — A worker-level env leak.

`test/dimensions/graph-backend-wired.test.ts:56` and `markers-wired.test.ts:39` `delete
process.env.AKS_DATABASE_URL` instead of restoring it, so a later file in the same worker calling
`createDimensionsDatabase(process.env)` falls through to the vendored default
`postgresql://aks:aks@localhost:5432/aks` (`activation.ts:186`, `config.ts:74`).

### S6 — `LLMWIKI_TEST_ALLOW_NO_DATABASE` is never exercised in CI.

No workflow references it (`.github/workflows/` grep, zero hits), so the no-database path is
untested in the gate that matters.

### S7 — Scope: the fix for the fix must not be the diff.

This is its own feature, on its own branch, after the current one lands. Shared test infrastructure
used by ~103 files must not be touched inside another feature's branch.

### S8 — The gate of record could not be told to stop reusing a container.

`turbo.json`'s `globalPassThroughEnv` named only the three `*_DATABASE_URL` variables, so turbo's
strict env mode stripped `TESTCONTAINERS_REUSE_ENABLE` before `//#test` ran. `testcontainers` reads
that variable (`generic-container.js:91`) to decide whether to reuse a container, and
`test/fixtures/testcontainers-postgres.ts` calls `.withReuse()` unconditionally.

Measured consequence: a run that believed it had reuse disabled silently ADOPTED a seven-day-old
container instead, and its numbers were worthless. A harness that cannot be told to own its database
is the same defect class as S3/S4. A variable the harness reads to decide where the database comes
from must be declared.

Rule: the declaration must be pinned by a control test, not left to a `--env-mode=loose` workaround.

### S9 — The same class was only half closed: a reusable container is still a server this run did not create.

`S4` closed the documented-`:5434` probe. The testcontainers reuse path did not: `containerBuilder()`
calls `.withReuse()` unconditionally and `startOrAdoptContainer()` adopts any container carrying the
label `llmwiki.role=shared-test-db`, reporting `reused: true`, while `prepareContainerDatabase` skips
the schema replay on it.

Measured during acceptance: a gate-of-record run adopted a container **seven days old** whose
default database still held a `public.stacks` row.

Reuse is a deliberate, measured optimisation (~1.5 s create versus ~120 ms adopt) and is worth
keeping where it is safe. The rule is therefore not "never reuse" but **never adopt blind**: compare
the candidate's schema against the declared migrations and expected columns, adopt when it matches,
and refuse with a stated reason naming the container and the mismatch when it does not. An ephemeral
CI runner has nothing to adopt, so CI was never affected.

**Status** — being closed by T10.

**Status (reuse in the pipelines)** — reuse is DISABLED in every pipeline by workflow-declared env
(`TESTCONTAINERS_REUSE_ENABLE: "false"` in the `build-and-test` job of `ci.yml` and in the
`preflight` job of `publish.yml`), and remains available as an explicit local opt-in; the drift
guard protects the opt-in path.

## Tasks

- [x] T1 — Measure the CI gate with `LLMWIKI_TEST_DATABASE_URL` set and unset; report population and wall clock for both before changing anything. S1. route: verify. commit: c5a3f6440bb0e542ecc3349abc144f9710c0ef44
  - evidence, both arms at `0507318eb237b97fa92f84cfbebac9881ddc1d54`:

    | metric | SET (`ci.yml:60` today) | UNSET, cold owned container |
    |---|---|---|
    | population / collected | 872 / 871 | 872 / 871 |
    | tests / passed / skipped / failed | 6498 / 6486 / 12 / 0 | 6498 / 6486 / 12 / 0 |
    | exit code | 0 | 0 |
    | wall clock | 6:28.95–7:02.83 (two readings) | 6:40.25 |
    | peak RSS | ~2035 MB (GNU single-descendant) | 4745 MB (sampled tree sum) |
    | per-run databases | 3–11 (flawed census, discarded) | 73 distinct, 57 pids, peak 9 |
    | shared default DB after run | not captured | `public.stacks` 0 rows |
- [x] T2 — Give `test/mcp/stack-id-guard.test.ts` a per-run database like every other suite, and pin the isolation rule with a probe test asserting `AKS_DATABASE_URL` points inside the per-run database and never equals the documented default. S2. route: worker. commit: b7493cd5fbc3c35710f70f498dd2f0779134a5cf
- [~] T3 — DROPPED on measured evidence. Moving the hoisted await perRunDatabase() into test/setup/test-database-url.ts would provision once per TEST FILE for every file that loads the setup file (vitest.config.ts sets no isolate, so setupFiles run per file), up to ~872 provisions each replaying fifteen schema files, versus 73 today. Provisioning is already per file, which is stronger than the per-worker isolation the task asked for. The defect it aimed at is the silent fallback, which is T4. S3. route: none. commit: dropped
- [x] T4 — Remove `perRunDatabase()`'s fallback to `testDatabaseUrl()`; turn a failed per-run provision into a skip with a stated reason instead of a silent shared-database run. S3. route: worker. commit: 9a849e84cee7235859f9b855965286fdc2590512
- [x] T5 — Turn the adopted-`:5434` branch into a skip with a stated reason instead of a silent adoption. S4. route: worker. commit: f49b40b788c83fe817a4c0a8753af4863dd04d16
- [x] T6 — Restore rather than delete `AKS_DATABASE_URL` in the two leaking files. S5. route: worker. commit: 823e3a384f88c475859aa58c4f3788487c416c38
- [x] T7 — Exercise the no-database path somewhere in CI, or state in the document why it intentionally is not. S6. Resolved as documentation only: AGENTS.md forbids LLMWIKI_TEST_ALLOW_NO_DATABASE=1 in CI, so CI must never exercise that path; the reason is stated here and no workflow sets it. route: document. commit: c5a3f6440bb0e542ecc3349abc144f9710c0ef44
- [x] T8 — Declare TESTCONTAINERS_REUSE_ENABLE in turbo.json globalPassThroughEnv and pin it with a control gate test. S8. route: worker. commit: bcc80099d1066a0d8a3bfa9868fe2ae0523b2a5d
- [x] T9 — Give the two remaining suites that read the default database directly their own per-run database, the way T2 did for test/mcp/stack-id-guard.test.ts: test/lint-honours-request-env.test.ts and test/dimensions/kg-shared-credentials-env-order.test.ts, named in the header of test/fixtures/testcontainers-postgres.ts. S2/S3. route: worker. commit: 4df273db2dc879d760587cc16680a34d2ea53709
- [x] T10 — Validate an adopted container's schema before adopting it: adopt when it matches the declared migrations and expected columns, refuse with a stated reason naming the container and the mismatch when it does not. S9. route: worker. commit: 4bdcde8bda9824b5ea473641d9e95179ab6b7f49
- [x] T11 — Set TESTCONTAINERS_REUSE_ENABLE: "false" in the gate job env of ci.yml and the test job env of publish.yml, and pin it with the existing control gate. S9/S8. route: worker. commit: 6a35b1e3462f9574582139a5640a1c697624dedb

T3 and T4 change how every database-backed suite obtains its database; they are the highest-risk
tasks here and each deserves its own commit and its own risk line.

## Log

- L1 — finding, 2026-11-17, from the `feat/stack-authority-per-request` campaign. The defect was found because `test/mcp/stack-id-guard.test.ts` was the only suite that could see a stale schema — it was the only one reading the application's real database — and that set off the audit. Measurements, recorded verbatim: 860 test files, 103 that resolve a database handle, 16 that mint their own throwaway database, 87 that go through the ambient DSN.
- L2 — decision, from the manager: open this as its own feature document on a separate branch, after the current feature lands; do not touch shared test infrastructure inside another feature's branch ("the fix for the fix must not be the diff"). The CI variable is this document's headline, and the change requires a measured comparison — population and wall clock with the variable set and unset — not an assertion.
- L3 — honesty note, recorded because it is the actual lesson: the campaign's rule "a fact whose authority is chosen by the entry point" applied to the application, and nobody had applied it to the test harness. The harness chooses a database by import graph and environment, which is why a suite can be green without owning state.
- L4 — the four-defect premise map, each re-verified this turn: (1) CONFIRMED, `test/mcp/stack-id-guard.test.ts:38` `createDimensionsDatabase(process.env)`, no `perRunDatabase`/`createSuiteDatabase`/skip anywhere in the file, fixture row inserted into `stacks` at `:130-132`; (2) CONFIRMED, `test/fixtures/kg-postgres.ts:59` hoisted `await perRunDatabase()`, fallback at `:59-63` to `testDatabaseUrl()`; (3) CONFIRMED, `adoptDocumentedServer()` logs the WARNING and returns `{ok: true}` — no skip — with `DEFAULT_TEST_DATABASE_URL = postgresql://aks:aks@localhost:5434/aks`; (4) CONFIRMED, `test/dimensions/graph-backend-wired.test.ts:56` and `test/dimensions/markers-wired.test.ts:39` are `delete process.env.AKS_DATABASE_URL` with no save/restore. CI premise CONFIRMED: `.github/workflows/ci.yml` sets `DATABASE_URL`, `LLMWIKI_TEST_DATABASE_URL` and `AKS_DATABASE_URL` all to `postgresql://aks:aks@localhost:5432/aks`, service `pgvector/pgvector:pg16` on 5432, both `apply-schemas.sh` and `CHECK_ONLY=true apply-schemas.sh` run before the gate at `:170`; `LLMWIKI_TEST_ALLOW_NO_DATABASE` appears nowhere under `.github/`.
- L5 — measurement of record, both ways, cold, at `0507318eb237b97fa92f84cfbebac9881ddc1d54`. Population pre-committed per run: 872 tracked / 871 collected, residual 0, both arms. Arm SET (as `ci.yml:60`): 6498 tests, 6486 passed, 12 skipped, 0 failed, exit 0, wall 6:28.95–7:02.83 (two readings disagree; both recorded), peak RSS ~2035 MB by GNU time single-descendant max. Arm UNSET, cold owned container (`TESTCONTAINERS_REUSE_ENABLE=false` + `--env-mode=loose`): same counts and exit 0, wall 6:40.25 (turbo `6m39.612s`, vitest `397.50s`), peak tree RSS 4745 MB by sampled `/proc` tree sum (80 samples, max 46 processes). No new skips in either arm: the 5 skipped files / 12 tests are the known baseline (vendor-contract 7 on `TYPESAFE_API_KEY`; aks/ingest/pages gateway 1+1+2 on `AKS_TEST_GATEWAY`; hatch-worker-env-probe 1).
- L6 — two instruments failed silently and both failures are recorded because they are the same defect class as the feature. (a) An "unset" arm ADOPTED a seven-day-old `hardcore_borg` because turbo stripped `TESTCONTAINERS_REUSE_ENABLE`; its numbers are discarded, not used. (b) A per-run database census used `psql -U aks -d aks` against a container whose superuser is `test`; it returned zero rows silently and briefly looked like "no databases exist". Corrected probe: `psql -U test -d test`, name prefix `llmwiki_suite_`.
- L7 — decision: `TESTCONTAINERS_REUSE_ENABLE` is deliberately NOT set in any workflow. A GitHub-hosted runner is ephemeral and has no labelled container to adopt, so the variable would be inert there; S8 is what makes "start cold" expressible and S4 is what stops silent adoption.
- L8 — note: `restoreVariable` is currently duplicated inside the two files T6 touched, because the only existing implementations are private (`test/fixtures/env-stack.ts:92-104`, `test/fixtures/search-embedding-corpus.ts:196-199`). Pending `fallow:ci` verdict; if new-duplication is reported, the fix is to export the existing helper, not to add a third copy.
- L9 — population, corrected. `git ls-files '*.test.ts' | wc -l` = **872** tracked test files; **871 collected** (`test/sdk/packaging.test.ts` excluded by `vitest.config.ts`). The document's original **860 is stale**. The figures 103 / 16 / 87 are **not reproducible by their stated method**: four independent greps returned 87, 86, 67, 219 and 94 for closely-related patterns, because a grep finds declarations, not executions. The measurable substitute is the execution-counted population: **73 distinct per-run databases per run, 57 pids**.
- L10 — the eight work-unit commits from `0507318eb237b97fa92f84cfbebac9881ddc1d54`: `823e3a38…` (S5), `b7493cd5…` (S2), `4df273db…` (S2/S3), `f49b40b7…` (S4), `bcc80099…` (S8), `9a849e84…` (S3), `35a30b4d…` (S1), `c5a3f644…` (this document). Cumulative 18 files, 1075 insertions, 153 deletions. Nothing pushed.
- L11 — acceptance, with what each run proves. (a) Gate of record on the final committed tree in the ADOPTED arm (`TESTCONTAINERS_REUSE_ENABLE` unset, reuse defaulted on, a seven-day-old container was adopted): 876 collected (877 tracked − 1 excluded), 6521 tests, 6509 passed, 12 skipped, 0 failed, exit 0, turbo `6m12.523s`, wall 6:13.11, and no skip outside the known baseline. (b) The cold, owned, STRICT-mode run on the final tree was **NOT OBTAINED**: two attempts died as agent model-execution failures with no result and it was not retried a third time. The cold arm IS proven on the pre-fix tree `0507318e` (871 collected, 6486 passed, 12 skipped, 0 failed, exit 0, container `youthful_satoshi` confirmed started-not-adopted). What remains unproven is only cold arm + these eight commits in strict env mode — named missing proof, not a claim.
- L12 — S9 recorded rather than closed: the reuse path still adopted a container a previous run left behind, with the schema replay skipped on it. Decision recorded instead of accepted: never adopt blind, so T10 validates the candidate's schema before adoption.
- L13 — review-load advisory from the commit hook: ~8881 authored lines across 50 commits since `origin/main`, past the ~400-line work-unit slice guidance. The eight commits are individually reviewable and three carry `Risk:` trailers (`f49b40b7` and `9a849e84` on shared test infrastructure, `35a30b4d` on delivery), but the feature as a whole is a large review.
- L14 — the release workflow carried the same shared-database shape as the gate of record; removing `LLMWIKI_TEST_DATABASE_URL` from `publish.yml` is part of the same decision, because a gate that is honest while the release pipeline is not is half the fix.
- L15 — decision (Manager, from the human's framing): the pipelines must never reuse a container. Quarkus Dev Services means unconfigured implies fresh, not "fresh unless something from last week answers". Reuse earns its risk where a restart costs about a second; here the gate is 6–7 minutes and the saving is ~1.4 s — about 0.35% — and it was the only residual risk left in this branch. Reuse stays for the local dev loop, protected by the `S9` drift guard.
- L16 — the gate of record in the documented configuration (`TESTCONTAINERS_REUSE_ENABLE=false`, strict env mode, no `--env-mode=loose`), run twice on the same tree `6a35b1e3462f9574582139a5640a1c697624dedb`:
  - **RUN 1 (red)** — exit 1; `Test Files 3 failed | 869 passed | 5 skipped (877)`; `Tests 3 failed | 6511 passed | 12 skipped (6526)`; `Tasks: 0 successful, 1 total`; turbo `6m55.255s`; wall 415 s; cold owned container (started, `schema replayed`, never adopted). Failing tests: `test/hatch-means-no-database.test.ts:202` (`Test timed out in 30000ms`); `packages/api/src/boot-review-surfaces.test.ts:147` (`Test timed out in 30000ms`); `packages/api/src/first-stack-acceptance.test.ts:380` via `bootHost:242` (`the host never announced a listener`).
  - **RUN 2 (green repeat)** — exit 0; `Test Files 872 passed | 5 skipped (877)`; `Tests 6514 passed | 12 skipped (6526)`; `Tasks: 1 successful, 1 total`; `Cached: 0 cached, 1 total`; turbo `6m20.348s`; wall 381 s; cold owned container `lucid_hermann` on port 33169, removed by teardown; no `adopted running` line anywhere. Skip inventory exactly the 5 files / 12 tests baseline both runs.
  - **Population** — 878 tracked test files, 877 collected (−1 excluded `test/sdk/packaging.test.ts`), residual 0.
  - **Load, recorded because it is the discriminating measurement and it refuted the hypothesis** — RUN 2 started at load `1.85` and reached a **peak 1-min load of 8.02**, against the **7.72** recorded for the red run, with lowest MemAvailable 2.83 GiB. The green therefore ran at a HIGHER peak load than the red: **load is exonerated, and "load flake" would be contradicted by these numbers.** A good hypothesis that the data killed.
  - **Attribution — pre-existing class, not a cost of reuse.** All three failures bound a *spawned child*, and this project already has that defect class on the board: a test whose `testTimeout` is 30 s bounding a child whose `CHILD_TIMEOUT_MS` is 300 s. A test deadline smaller than the operation it bounds flakes by construction under contention, and "contention" is not "load average" — which is exactly why the load figures could not discriminate. The fix is the **deadline relationship**, never raising 30 s to make a red go away.
  - **Two instrumentation notes.** (a) `grep -c adopted` returns **5** on a fully healthy cold run because the word appears in test *names* and in a stubbed unit test's stdout; the correct discriminator is `grep -c 'adopted running'`, which is **0**. A check that would produce a false failure on a correct run is the same defect class as one that passes on a broken one — the third silently-wrong instrument found in this branch, after the two in L6. (b) The `[test-database] unavailable: … (docker unavailable)` lines in the log are that stubbed unit test's own output, not the run's state.
