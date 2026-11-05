# Feature: testcontainers-test-infra

Give the database-backed suites their own Postgres — a pinned `pgvector` container started per test
run — and close the silent skip that lets CI report green while asserting nothing. Branch
`chore/testcontainers-test-infra`, HEAD `6b83fba`, clean tree. Documentation-only task T0: this file
and its Engram mirror. Code, tests, commits and docs in English.

## Evidence

Environment facts that decide feasibility, verified before this document was written:

- Docker 29.7.2 is usable as user `urgosxd` (`docker info` succeeds).
- `pgvector/pgvector:pg16` pulls and runs; it is already the repository's image at
  `test/fixtures/ephemeral-postgres.ts:42` (`POSTGRES_IMAGE`).
- `@testcontainers/postgresql` resolves to 12.2.1.
- Every CI job is GitHub-hosted `ubuntu-latest` with no job-level `container:`, so containers can
  run there.

## Specs

S1. ONE CONTAINER PER TEST RUN, SHARED BY WORKERS. One Postgres container with the pgvector
extension per test run, started by the vitest global setup (`vitest.config.ts:73` ->
`test/global-setup.ts`), shared by all parallel workers. The image tag is pinned — never `latest`.
The repository's image is `pgvector/pgvector:pg16` (already used at
`test/fixtures/ephemeral-postgres.ts:42`). Docker chooses the host port.

S2. PRECEDENCE: EXPLICIT OVERRIDE WINS. An explicit, non-empty `LLMWIKI_TEST_DATABASE_URL` wins and
no container is started. The container starts only when that variable is absent or empty (empty is
treated as absent, per `test/fixtures/test-database.ts:57-64`). A developer or CI job with a
pre-existing database keeps working without Docker.

S3. NO DATABASE MEANS LOUD FAILURE, NEVER A SKIP. When no database can be obtained, database-backed
suites FAIL with a clear, actionable message — they must not skip. The failure message names the
environment variable that overrides, the pinned image, and Docker as the missing prerequisite.

S4. ONE DOCUMENTED OPT-OUT. Exactly ONE documented opt-out environment variable restores the current
skip behavior, and it is the only path to a green run without a database.

S5. PER-RUN ISOLATION STAYS UNTOUCHED. Per-run isolation is preserved and untouched: one database
per test process via `packages/llmwiki-kg/ts/src/testing/per-run-database.ts`, created on first use
and dropped on exit, so parallel workers stay independent. Container reuse must not leak a dirty
database into the next run.

S6. REUSE, WITH A CLEANUP LABEL, AND A TEARDOWN. Reuse is enabled so repeat local runs are fast, with
a cleanup label (ryuk) so debris cannot accumulate. The global setup gains a teardown that stops the
container it started when it is not being reused.

S7. CI NEVER STARTS A CONTAINER; THE CONTAINER IS THE LOCAL PATH. `.github/workflows/ci.yml` supplies
pgvector through a `services:` block (`:37-53`) and sets `LLMWIKI_TEST_DATABASE_URL` (`:59`), which
wins under S2, so no Testcontainers container is ever started in CI. `.github/workflows/publish.yml`'s
`preflight` job (`:148`) gains the same pgvector `services:` block (`:153-169`), the same
`LLMWIKI_TEST_DATABASE_URL` and `AKS_DATABASE_URL` (`:173-174`), and the same two schema steps
(`:255-258`) that ci.yml has (`:92-95`), mirroring ci.yml's arrangement, because S3 would otherwise
turn that job red — its `npm test` step had no database. BOTH workflows also define `DATABASE_URL` at
job level (`ci.yml:58`, `publish.yml:177`) because `scripts/apply-schemas.sh:27` resolves its target
from `$1` or `DATABASE_URL` only — it reads neither of the two `*_DATABASE_URL` variables — so
without it both schema steps exit 2 and `npm test` never runs. `scripts/apply-schemas.sh` now prints
its "no target" diagnostic (`require_target`, `:98`) instead of having it swallowed by
`require_connection`'s `2>&1`. The consequence that must not be lost: CI therefore never starts a
Testcontainers container — the container is the LOCAL path — and the two paths are reached by the
same precedence rule (S2). Nothing else in any workflow changes.

S8. DEVELOPER DOCUMENTATION CORRECTED. Developer documentation is corrected: `CONTRIBUTING.md` (the
`### Build and Test` section, `:49`) documents container auto-start, the override variable, the
opt-out variable, and the fail-loudly rule. The `npm test` line in `README.md` (`:444`) stays
consistent.

S9. NO PRODUCTION BEHAVIOR CHANGES. No production behavior changes anywhere. The only file under
`packages/**/src/**` that may be edited is `packages/llmwiki-kg/ts/src/routes/ingest-harness.ts`,
which is test-only infrastructure: all 7 of its importers are `*.test.ts` in the same directory, its
package is `"private": true` with no `exports`/`files`, and neither shipped tsup entry (`src/cli.ts`,
`src/index.ts`) nor `server.ts`/`core-index.ts` references it. It must stay under 400 lines and keep
its JSDoc header.

S10. THE SPEED CLAIM IS MEASURED, NOT ASSERTED. The wall-clock effect is measured and reported: the
database-backed suites are timed before and after the change on this machine, with the exact file
list and the exact commands, and the report states plainly whether anything actually got faster —
including the honest case where a warm database on :5434 makes the delta noise.

## Tasks

T0 | doc | worker | pending — Open this feature document and mirror it in memory.
T1 | S1, S2, S5, S6 | worker | pending — Container lifecycle: dependency, shared container in global setup, teardown, dynamic-URL propagation to workers, reuse.
T2 | S3, S4 | worker | pending — Loud failure at the two chokepoint fixtures plus the single opt-out variable, and a regression test.
T3 | S7 | worker | pending — Mirror the pgvector service into `publish.yml`.
T4 | S8 | worker | pending — Developer documentation.
T5 | S10 | verify | pending — Independent verification: green with Docker, loud failure without a database.
T6 | S10 | lead | pending — Measurement, gates, report.

## Log

L1 (human request, verbatim):
"si agrega tambien la infra con tescontainer para que sea mas rapido y limipo los tests"

L2 (Manager ruling, architecture):
Approved the two-chokepoint design instead of editing the skip sites one by one; measured reality
wins over the brief's assumption of ~5 sites. Hard constraint: the 70 `if (!reachable) return;` early
returns must be neutralized BY the chokepoint throwing, not by editing 70 files; if any can still
reach a PASS after the change, the change is incomplete, to be proven with a run and not by
inspection.

L3 (Manager ruling, CI):
Leave `ci.yml:37-57` alone; the explicit variable wins and the existing service block already
supplies pgvector. State plainly that the speed win is local-only and CI behavior is unchanged; no
overclaiming.

L4 (Manager ruling, publish.yml):
The publish false-green is forced, not optional. Once the fixtures throw, `publish.yml:227-237` runs
`npm test` with no database and turns RED. It cannot be left broken and it must not receive the
opt-out variable — that would preserve the exact false-green being eliminated. Add the same pgvector
`services:` block and env var, mirroring ci.yml. This is the only authorized CI change.

L5 (Manager ruling, scope):
`packages/llmwiki-kg/ts/src/routes/ingest-harness.ts` is in scope as test infrastructure provided it
is proven not reachable from the server import graph; the proof is recorded in S9; if it were
production-reachable it must not be touched.

L6 (evidence, baseline measured before any change):
Warm 6-file run = 4.33s wall, 80/80 passed, 0 skipped; cold run = 28.26s dominated by the ~25s
`dist` build; with an unreachable database `ingest-ontology.test.ts` exits 0 with 11 tests skipped,
`ingest-ontology-e2e.test.ts` exit 0 / 9 skipped, `kg-runtime-e2e.test.ts` exit 0 / 6 skipped,
`source-documents-store.test.ts` exit 0 / 20 skipped. Whole-list runs are red only incidentally,
because a few ungated tests leak past the gate at `ingest-formation.test.ts:325,466` and
`embeddings-database.test.ts:406`.

L7 (evidence, corrected paths):
The database-backed ingest suites live at `packages/llmwiki-kg/ts/src/routes/`, not `test/`. Vitest
silently ignores non-matching file filters, so a wrong path measures nothing and still exits 0.

L8 (evidence, stale pointer): S8 cited `CONTRIBUTING.md` "Build and Test" at `~:348-362`; verified,
the file is 183 lines and `### Build and Test` is at `:49`. Same defect class as `reach-test.md` L5.
The S8 anchor now reads `:49` (and the `README.md` `npm test` line `:444`); no other `S#` and no
earlier log entry was rewritten.

L9 (manager ruling, the trade):
Testcontainers ships as the DEFAULT path. "The trade is accepted on the benefits — no false green,
hermetic, per-run isolation, pinned engine — and the wall clock is not the deciding factor." The
acceptance criterion that follows: a clean machine with Docker and no local Postgres must run the
suite end to end through the default path.

L10 (evidence, independent verification, first pass — NEGATIVE):
The container's shared default database had no schema, breaking 3 shared-database suites with
`relation "stacks" does not exist`; `fallow` exited 1 (a 47-line clone plus 3 complexity findings in
the new files); and the container path measured 12.2–13.3 s against a 4.33 s baseline on the same 6
files. All three were fixed: schema replayed once per run onto the container (25 tables + the
`llmwiki_app` role, sentinel-checked so an adopted container costs one query), the clone/probe
extracted to `test/fixtures/container-server-primitives.ts` with `fallow` clean, and the throwaway
container now runs with fsync/synchronous_commit/full_page_writes off, `wal_level=minimal`,
`max_wal_senders=0`, read back from `pg_settings` rather than assumed — which cut the 15-file schema
replay from 864/818/774 ms to 313/347/366 ms (2.3–2.5x on the cost paid once per test process).

L11 (decision, authorized test edit):
`test/mcp/stack-id-guard.test.ts` asserted on operator data (`b8b8e801-b423-4a32-ab0b-e1ea2d82ead8`,
domain `wire2`) that exists only in one developer's long-lived `:5434`. On any clean database — CI's
service container included — it was red; nobody noticed because CI never reached `npm test`.
Authorized: the suite now creates the Stack it asserts on, assertions untouched, and it passes 7/7
against both a clean schema'd database and `:5434`.

L12 (decision, authorized CI change):
`ci.yml`'s job env gains `DATABASE_URL`, overriding the earlier "leave ci.yml alone" ruling (L3),
because a red job that never reaches `npm test` makes the loud-failure requirement unobservable in CI.
Nothing else in `ci.yml` changes.

L13 (evidence, pre-existing defect, fixed):
`ci.yml`'s schema steps never resolved a target — `scripts/apply-schemas.sh:27` reads `$1`, `PSQL` or
a bare `DATABASE_URL`, and the workflow defined none of them, so both steps exited 2 and `npm test`
never ran on `main` since that wiring landed in `f42f43c`. The failure was masked because
`apply-schemas.sh` discarded its own diagnostic. Both the missing `DATABASE_URL` and the swallowed
message are now fixed.

L14 (evidence, defect found by the final measurement, fixed):
The loud-failure regression test spawned a child whose global setup republished the SHARED
`.llmwiki/test-database.json` with the unreachable `127.0.0.1:1` sentinel, and sibling workers booting
inside that ~16 s window threw `missingTestDatabase` (317 poisoned samples observed by polling; 0
after the fix). The handoff path is now resolved in one place and relocatable via
`LLMWIKI_TEST_DB_HANDOFF_FILE`, and the child writes its own temp record.

