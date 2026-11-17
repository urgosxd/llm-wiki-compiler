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

### S2 — One suite has no isolation at all.

`test/mcp/stack-id-guard.test.ts:38` `const h = createDimensionsDatabase(process.env);` — no
`perRunDatabase`, no `createSuiteDatabase`, no `skipIf`, no skip reason. It connects to whatever
`AKS_DATABASE_URL` names and `createFixtureStack` (`:101-116`) inserts a row into `public.stacks` of
that database. The file's own comment (`:93`) admits it targets "a database that already carries
this Stack (the developer's)".

### S3 — The isolation of 87 more suites is an import side effect that degrades silently.

`test/fixtures/kg-postgres.ts:59` `const SUITE = await perRunDatabase();` is what redirects the
resolver (`test/fixtures/per-run-database.ts:89-93` sets both `LLMWIKI_TEST_DATABASE_URL` and
`AKS_DATABASE_URL`). If that import is not reached or the call rejects,
`test/fixtures/kg-postgres.ts:63` warns
`"kg-postgres: per-run database unavailable … Falling back to the shared database …"` and the same
`createDimensionsDatabase(process.env)` line then points at shared state with no failure.

The population this rule is written against: 860 test files, 103 that resolve a database handle, 16
that mint their own throwaway database, 87 that go through the ambient DSN.

### S4 — The harness can silently adopt a developer's hand-migrated server.

`test/fixtures/testcontainers-postgres.ts:307-314` and `:271-292`: when no container starts or is
adopted, it probes `DEFAULT_TEST_DATABASE_URL` = `postgresql://aks:aks@localhost:5434/aks`
(`test/fixtures/test-database.ts:49`) and prints
`"WARNING: adopted the pre-existing server at … instead of starting a container; this run is not
isolated from that server"` (`:280-282`), with `:268-269` noting the run neither created nor owns
that state.

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

## Tasks

- [ ] T1 — Measure the CI gate with `LLMWIKI_TEST_DATABASE_URL` set and unset; report population and wall clock for both before changing anything. S1. route: verify. commit: pending
- [ ] T2 — Give `test/mcp/stack-id-guard.test.ts` a per-run database like every other suite, and pin the isolation rule with a probe test asserting `AKS_DATABASE_URL` points inside the per-run database and never equals the documented default. S2. route: worker. commit: pending
- [ ] T3 — Move the hoisted `await perRunDatabase()` into `test/setup/test-database-url.ts` so every worker owns one throwaway database before any module loads. S3. route: worker. commit: pending
- [ ] T4 — Remove `perRunDatabase()`'s fallback to `testDatabaseUrl()`; turn a failed per-run provision into a skip with a stated reason instead of a silent shared-database run. S3. route: worker. commit: pending
- [ ] T5 — Turn the adopted-`:5434` branch into a skip with a stated reason instead of a silent adoption. S4. route: worker. commit: pending
- [ ] T6 — Restore rather than delete `AKS_DATABASE_URL` in the two leaking files. S5. route: worker. commit: pending
- [ ] T7 — Exercise the no-database path somewhere in CI, or state in the document why it intentionally is not. S6. route: worker. commit: pending

T3 and T4 change how every database-backed suite obtains its database; they are the highest-risk
tasks here and each deserves its own commit and its own risk line.

## Log

- L1 — finding, 2026-11-17, from the `feat/stack-authority-per-request` campaign. The defect was found because `test/mcp/stack-id-guard.test.ts` was the only suite that could see a stale schema — it was the only one reading the application's real database — and that set off the audit. Measurements, recorded verbatim: 860 test files, 103 that resolve a database handle, 16 that mint their own throwaway database, 87 that go through the ambient DSN.
- L2 — decision, from the manager: open this as its own feature document on a separate branch, after the current feature lands; do not touch shared test infrastructure inside another feature's branch ("the fix for the fix must not be the diff"). The CI variable is this document's headline, and the change requires a measured comparison — population and wall clock with the variable set and unset — not an assertion.
- L3 — honesty note, recorded because it is the actual lesson: the campaign's rule "a fact whose authority is chosen by the entry point" applied to the application, and nobody had applied it to the test harness. The harness chooses a database by import graph and environment, which is why a suite can be green without owning state.
