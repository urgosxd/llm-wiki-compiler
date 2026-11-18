# Ingest job hang, lock authority, and job recovery

Feature: two ingests of the same source leave a job that never settles, cannot be deleted or retried, and does not say why. Branch: `fix/ingest-job-hang-and-lock-authority`. All job-state changes carry `Risk: item 1`; all lock and mirror-ordering changes carry `Risk: item 4`.

## Specs

### S1 — A repeated ingest must not hang
Reporter, verbatim: "al ingestar 2 veces un recurso se colgo el job"

Two ingests of one resource must each reach a terminal state. A job that settles in memory must settle in `wiki.ingest_job` as well: once the request owning it has finished, no row may remain in any non-terminal pair — today measured as `ingest_status=running` with `compile_status=queued`. Terminality is read from the registry's own `isSettled` predicate, never from a hand-copied list of status strings, and `compile_status=busy` is settled by that predicate.

### S2 — A stuck job must be recoverable through the public interface
Reporter, verbatim: "no hay manera de eliminarlo o que reintente"

Through the MCP server and the HTTP surface, an operator can delete a job and retry a job. A refused recovery — unknown id, wrong Stack, or a job still live — must leave the stored row's state and counters unchanged; a "cannot retry" that silently marks something retried is worse than the current state.

### S3 — The status must say why
Reporter, verbatim: "la informacion que da es muy pobre"

A row that is not settled must state a reason. Terminal failure must carry its error text into the stored row, not only into a log file. A row left non-terminal past the stuck bound must report a derived reason instead of a bare `running`. `compile_status=busy` must explain itself.

`compile_status="busy"` is settled, not pending: `busy` reports itself as a settled outcome whose retry is offered explicitly, and the reaper (S6) is scoped only over rows that are non-terminal by that predicate. The `busy` decision records existing behaviour rather than changing it; what T2 adds is a reason plus an explicit `retryable: true` marker, which is an additive change to the exported job types and carries `Risk: item 1` only.

### S4 — The request's resolved Stack must reach the mutation lock
Reported defect 2, confirmed with a narrower meaning than reported: `tryWithOrdinaryMutationLock` calls `acquireMutationLock(root, "ordinary")` without forwarding `env`, so the request's Stack reaches the compile lock but never the ingest lock, and Stacks collide on one path key. This is an isolation defect, not the cause of S1.

### S5 — A permissions failure must surface as a permissions failure
Reported defect 1, confirmed: `private-dir.ts` wraps every failure into `PrivateDirConfinementError`, so an EACCES is already indistinguishable from a symlink-confinement violation before `lock.ts` flattens the message. The underlying error code must survive to the surface.

### S6 — A row that never settles must be reaped under a named bound
Reported defect 3, confirmed: nothing expires a `wiki.ingest_job` row. The bound is a named, configurable value with a documented default — never a magic timeout.

## Tasks

- T1 · S1 · Order and monotonicise the durable job mirror: a per-job write chain plus an `updated_at` guard on the upsert, so a terminal patch can never be overwritten by a stale snapshot. Surfaces: `packages/wiki/src/services/ingest/jobs/durable-registry.ts`, `packages/wiki/src/services/ingest/jobs/job-store.ts`, `test/services/ingest-job-durable-settle.test.ts` (new). · Risk: item 4 and item 1 · commit: pending
- T2 · S3 · Make job status name its reason: terminal `error` reaches the durable row, a non-terminal row past the stuck bound reports a derived reason, `compile_status=busy` explains itself and settle `compile_status=busy` as a retryable settled outcome (`isSettled` counts it, with a reason and `retryable: true`). Surfaces: `job-store.ts`, `types.ts`, `api-ingest-jobs.ts`, `mcp/job-tools.ts`, tests. · Risk: item 1 · commit: pending
- T3 · S4 · Forward the request's resolved Stack env into the ingest mutation lock. Surfaces: `packages/wiki/src/utils/mutation-lock.ts`, `packages/wiki/src/services/ingest/service.ts` and its callers, tests. · Risk: item 4 · commit: pending
- T4 · S5 · Preserve the underlying error code through `resolveConfinedPrivateDir` and discriminate confinement from other failures at the lock. Surfaces: `packages/wiki/src/utils/private-dir.ts`, `packages/wiki/src/utils/lock.ts`, tests. · Risk: item 4 · commit: pending
- T5 · S2 · Delete and retry a job through HTTP and MCP, each refusing without mutating on refusal. Surfaces: `mcp/job-tools.ts`, `mcp/tool-names.ts`, `viewer/server.ts`, `viewer/api-ingest-jobs.ts`, `job-store.ts`, `registry.ts`, the four tool-name tests, `docs/guides/http-ingest-jobs.mdx`. · Risk: item 1 · commit: pending
- T6 · S6 · Settle abandoned rows under a named configurable bound. Surfaces: a reaper module, `utils/constants.ts`, `docs/configuration/environment-variables.mdx`, tests. · Risk: item 1 · commit: pending
- T7 · reported defect 4 · Recon only: report what the `wiki/` mount was meant to serve. No source write, no population on a guess. · commit: n/a
- T8 · S1-S6 · Gate of record on Node 24 with `TESTCONTAINERS_REUSE_ENABLE=false`, population pre-committed before the run. · commit: n/a

## Log

- L1 — Reporter, verbatim: "al ingestar 2 veces un recurso se colgo el job y no hay manera de eliminarlo o que reintente ademas la informacion que da es muy pobre"
- L2 — Reporter supplied four code defects as evidence: (1) `lock.ts:396-401` collapse of every failure into a confinement violation; (2) `mutation-lock.ts:137` not forwarding `env`; (3) no reaper for `wiki.ingest_job`; (4) an empty `wiki/` mount. Recorded as reported, not as measured.
- L3 — Hypothesis from the assignment, stated before measurement and to be proved or refuted: without the advisory lock, two ingests serially wait on something nothing releases, making defect 2 the mechanism for the hang.
- L4 — Reproduction, measured against a real pgvector database, `docker compose up -d db`, host on `dist/api.js`, no `AKS_STACK_ID` in the process. Control: sequential double ingest of one source settled both times (`succeeded/failed`, then `unchanged/failed`). Test: five concurrent pairs, each pair both 202 with distinct job ids. Final durable states — pair 1 `running/queued`; pair 2 `failed/busy`; pair 3 `failed/queued`; pair 4 `failed/queued`; pair 5 `failed/queued`. Sixty seconds of polling produced no further transition. `queued`, `running` and `busy` are all non-terminal by the registry predicate.
- L5 — Measured lock behaviour, which refutes L3: the ingest half takes the file lock (`.llmwiki/lock`, path key, held about 20 ms) and the compile half takes the Postgres advisory lock (`pg_try_advisory_lock`, key derived from the Stack id). Both are released; `pg_locks where locktype='advisory'` was 0 before the pair, 0 immediately after both responses, and 0 at plus 30 seconds. No lock leak leaves a row stuck.
- L6 — Measured cause of the hang: the in-memory job settles and writes its terminal record to `.llmwiki/ingest-failures.jsonl` — `{"kind":"ingest_job_failed","stage":"preparing","error":"Another mutation holds the project lock; retry."}` — while `wiki.ingest_job` retains the pre-failure snapshot with a frozen `updated_at` and no error field. `durable-registry.ts:94-97` writes the mirror with `void saveIngestJob(...)`, fire-and-forget and unsequenced, so an older snapshot commits last. No mirror-error line appeared in the server log.
- L7 — Measured absence of recovery: `DELETE /api/ingest/jobs/:id` answered 404, `POST /api/ingest/jobs/:id/retry` answered 404, and the MCP surface advertises only the read-only `ingest_job_status` and `ingest_jobs_list`. After both attempts the stored row was byte-identical.
- L8 — Decision: the assignment's hypothesis L3 is refuted by measurement. S1 is fixed where the defect is (the durable mirror), and S4 is treated as an isolation fix carrying `Risk: item 4`.
- L9 — Correction to the reconnaissance record: `seedJobInDurableRegistry` does not exist in this repository; the durable mirror is `createDurableJobRegistry` in `durable-registry.ts`.
- L10 — Manager, re-scope approved, verbatim: "A per-job write chain serialises within one process; it does nothing for the row another process writes." and "The guard is the contract; the chain is an optimisation that stops the race early." and "A chain without the guard passes your test and loses the update the day a second process writes." T1 therefore carries both halves and tests the guard directly with an out-of-order older snapshot.
- L11 — Manager, on `busy`, verbatim: "if that is true, a `busy` job never settles, which is the stuck row by a second road" and "Pick one: make `busy` settled-with-retry-available, or define the transition. Silence is how the next operator finds a row that will never move."
- L12 — Decision on L11: `busy` is settled-with-retry-available. No code transitions `busy` onward, so treating it as pending promises a transition that does not exist and would make the reaper reap a job that finished its attempt. `busy` therefore satisfies `isSettled`, keeps a reason, and carries `retryable: true`; the transition out of it is the explicit retry added by T5. The reaper's bound (S6) is defined only over rows that are non-terminal by that predicate.
- L13 — Manager, on terminality count, verbatim: "and 5/5 is the honest count, not 4/5." Terminality is read from the registry's `isSettled` predicate, never from a hand-copied list of status strings.
- L14 — Manager, on defect 1, verbatim: "fix BOTH sites — `private-dir.ts:43-46` and `:66-67` wrap every error into `PrivateDirConfinementError` before `lock.ts` ever sees it, so a lone `lock.ts` change cannot surface EACCES."
- L15 — Environment: a probe pgvector container and a scratch API host from the reproduction were left running; both are removed, with `/tmp/verify-ingest-probe.CADsGk` and `/tmp/build.log`, before the first commit.
- L16 — Measured correction to L4/L13: `isSettled` returns `true` for `compile_status="busy"` both at base `ed226a2e` and at head, so `busy` is settled and the reproduction's pair 2 was settled. Unsettled pairs are 4 of 5. L13's "5/5" and S1's parenthetical are corrected here; the count of affected pairs does not change the mechanism recorded in L6.
- L17 — Residual gaps accepted, not fixed: the terminal mirror write is still not awaited, so a row can lag or be lost if the process exits immediately after settling (the chain closes ordering, not shutdown durability); a lookup map in the durable registry is never pruned (pre-existing at base); and the chain's per-job entry could be stranded when the error sink throws (fixed inside T1).
