# Stack-scoped compile lock — observability and proof

Branch `fix/stack-scoped-compile-lock`, base `fea6291ad1456ccfb8cc964b9ef66fc9413559ba`. The Stack-id keying this feature is named after already landed as `7c9a042`; what remains is making the lock observable and proving the properties it claims.

## Specs

**S1 — Do not re-fix delivered code.** The Manager accepted the refutation of the original premise: "Refusing to manufacture a fake RED against working code is the correct call and I want it stated in your report exactly as you put it: you will not re-fix something that already works and has a committed test." Evidence that it is delivered, and therefore out of scope for new implementation: `7c9a042 fix(lock): key the advisory lock on the Stack, not the checkout path` is an ancestor of HEAD; `src/utils/lock.ts:207-209` reads `stackIdOf(env) ?? await realpath(root).catch(() => path.resolve(root))`; `src/utils/lock-postgres.ts:85-87` already runs `select pg_try_advisory_lock(${LOCK_NAMESPACE}::int, hashtext(${lockKey})::int) as acquired` on a reserved `max:1` connection; `test/lock-postgres-integration.test.ts:86-100` already asserts that two different paths naming one Stack exclude each other.

**S2 — Observability is the defect.** "log which key was acquired by which Stack, and log when an acquisition WAITED and for how long. A lock that is never observed either way is indistinguishable from no lock." Acceptance is not the presence of a log line: "the value is not the log line, it is that a future investigator can answer 'was a lock the reason this compile waited' without a reproduction. If a waiting acquisition is not visible after your change, the change has not landed."

**S3 — Crash release is measured, not asserted.** "Handle the crash case explicitly: a session-level lock is released when the connection dies — verify that and say so." A comment claiming it does not satisfy this; a killed holder process that releases the key for the next acquirer does.

**S4 — Different Stacks must stay concurrent.** "Two concurrent compiles of DIFFERENT Stacks must still run concurrently — a lock that serialises everything is a regression dressed as a fix."

**S5 — Release on success and on failure.** "The lock is released on success and on failure; a subsequent compile of the same Stack acquires immediately."

**S6 — Failed input changes no stored data.** "Rejected or failed input leaves stored data unchanged."

**S7 — Collision consequence documented, two-int form kept.** "KEEP THE TWO-INT NAMESPACE FORM and document the collision consequence as OVER-SERIALISATION OF TWO STACKS, NEVER CORRUPTION. Do not swap to a 64-bit derivation." Required as one line rather than a claim that collisions are impossible: "Document the collision consequence in one line rather than claiming there is none."

**S8 — File-backed Stacks are a named hole, not a covered case.** "File-backed Stacks keep a path-based lock, because there is nothing better available for them. Document that as a real limitation: file-backed Stacks cannot be protected across hosts, and do not present the Stack-id lock as covering them."

**S9 — The stale task-log entry is corrected, not preserved as current.** "CORRECT THE STALE ENTRY. Do not leave it as a historical record. Mark it resolved at `7c9a042` with the date and the commit subject, keeping enough of the original claim that a reader can see what was believed and when it stopped being true." Reason, in the Manager's words: "A task log that asserts a fixed defect is worse than no task log, because it sends the next session to re-fix delivered code."

**S10 — RED before GREEN, and each assertion must bite.** "Demonstrate RED before GREEN, and prove each assertion bites by reverting the fix and showing it fail." The one legitimate historical measurement: "Prove the previous behaviour was broken by demonstrating the equivalent case against the old path-keyed lock in a scratch copy under `mktemp -d` (never committed)." A scratch measurement is evidence recorded in this Log; it is never a committed test.

**S11 — Gates and boundaries.** Each gate runs with its exact scope and every non-run is named: `npx tsc --noEmit`, `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit`, `npm run typecheck:tests` (do NOT regenerate the baseline; fix code), `npm run typecheck:kg`, `npm run build`, `npm run test:affected`, `npm test`, `./node_modules/.bin/fallow`. Boundaries: "no schema change beyond what an advisory lock needs (which is none — the key is a value, not a table). No new dependencies. Do not change compile output, chunking, extraction or classification. Do not touch `core/jev/doubles.ts` — its positional order is a documented, shipped contract." Fallow caveat: ".fallowrc.json ignores `packages/llmwiki-kg/**`, so a clean fallow result is not coverage of that package."

**S12 — Delivery.** Do not push, rebase, merge or integrate. The report carries the full 40-character HEAD SHA and proof that `fea6291ad1456ccfb8cc964b9ef66fc9413559ba` is an ancestor of it.

## Tasks

- T1 — S2 — route: gentle-ai-worker — RED test then GREEN in `src/utils/lock.ts` (+ `src/utils/lock-postgres.ts` if the key must be surfaced) — status: covered (`test/lock-observability.test.ts`) — commit: `eb6ff23`
- T2 — S3, S5 — route: gentle-ai-worker — crash release, measured with a killed holder process, and release on success and failure — status: covered (`test/lock-postgres-crash-release.test.ts`, plus `test/mutation-lock-env-release.test.ts` for the `gateOrRelease` env repair) — commit: `eb6ff23` (crash release, in C1) + `1e9c50e` (the `gateOrRelease` environment repair, in C2)
- T3 — S4 — route: gentle-ai-worker — two different Stacks must not serialise — status: covered (`test/lock-postgres-distinct-stacks.test.ts`) — commit: `eb6ff23`
- T4 — S6 — route: gentle-ai-worker — rejected or failed input leaves stored data unchanged — status: covered, with two gaps recorded in L5 (`test/compile-rejected-input-unchanged.test.ts`) — commit: `5157bb1`
- T5 — S7, S8, S9 — route: gentle-ai-worker — collision line, file-backed cross-host limitation, correction of the stale `odd/tasks/multi-tenant-stack-only.md:348-354` entry — status: covered, including the same-class correction of `odd/tasks/wiki-on-postgres.md:596-599` — commit: the commit that contains this line (C4) — a commit cannot record its own SHA, so read it with `git log --oneline -1 -- odd/tasks/stack-scoped-compile-lock.md`
- T6 — S10 — route: gentle-ai-worker — historical measurement of the old path-keyed lock in a `mktemp -d` scratch copy, recorded in this Log and never committed — commit: none — a scratch measurement is Log evidence (L7), never a committed test
- T7 — S11 — route: gentle-ai-worker — the eight gates, each with its exact scope — status: all eight run, all eight exit 0 (L7) — commit: the commit that contains this line (C4) — same self-reference as T5
- T8 — S1-S12 — route: gentle-ai-verify — independent verification by an agent that implemented none of it — status: covered, PASS on all twelve, with two claims unpinned by any committed test, closed by T9 — commit: none
- T9 — S2, S8 — route: gentle-ai-worker — pin the two claims no committed test held: a wait survives `quiet`, and a DSN-less named Stack is labelled `path <abs>` — status: covered (`test/lock-observability-quiet-and-fallback.test.ts`, 2 tests, both byte-probed against the inverse edit) — commit: `de92160` (C5)
- Risk: item 3 — the feature diff changes `pollForLock`, `lockTargetFor`, `announceWaited`/`announceGaveUp` and `gateOrRelease`, shared by commands this request did not name (every mutation path that locks, not only `compile`); the full lock set, `npx tsc --noEmit` and `npm run typecheck:tests` were run after the change, and `npm test`/`npm run test:affected` cover it only as recorded in L7. Review workload signal raised by the independent verifier: commit `eb6ff23` bundles 748 inserted lines spanning concurrency-sensitive lock behaviour, so the Manager may want it reviewed as one unit rather than folded into the branch diff.

## Log

L1 — the assignment brief, verbatim (Manager → Lead, this session):

Project assignment for branch fix/stack-scoped-compile-lock:

Bounded, authorized fix. Read `AGENTS.md` first, and read `odd/tasks/multi-tenant-stack-only.md:348` (heading "Open defect found while closing T4 — NOT fixed") before anything else — that entry is the defect you are fixing. Environment: Node 24 only (`$HOME/.nvm/versions/node/v24.21.0/bin` on PATH); `npm ci` with the lockfile pinned if deps are missing; build `dist/` before any `fallow` measurement. `.fallowrc.json` ignores `packages/llmwiki-kg/**`, so a clean fallow result is not coverage of that package.

THE DEFECT: the compile lock is keyed by filesystem PATH rather than by Stack id. Two hosts (different machines, different worktrees, different paths) compiling the SAME Stack obtain different keys, both acquire, and compile concurrently — corrupting or duplicating the same Stack's output. A path is not an identity.

THE DESIGN, decided — one design, final, do not re-litigate it with me:
1. The lock key is the STACK ID, and the lock lives in the DATABASE. A filesystem lock (`flock` or similar) cannot work across hosts and is not a candidate.
2. Use a SESSION-LEVEL PostgreSQL advisory lock (`pg_advisory_lock` / `pg_advisory_unlock`), NOT `pg_advisory_xact_lock`. This is the critical detail: a transaction-scoped advisory lock would keep a transaction open across the compile, and this repository already forbids holding a transaction across long external calls (classifier, extractor, embedding). If you conclude the transaction-scoped form is the only workable one, STOP and report the conflict instead of breaking that rule.
3. Acquire before reading any compile input; release only after the write completes. Handle the crash case explicitly: a session-level lock is released when the connection dies — verify that and say so.
4. File-backed Stacks keep a path-based lock, because there is nothing better available for them. Document that as a real limitation: file-backed Stacks cannot be protected across hosts, and do not present the Stack-id lock as covering them.
5. The key derivation must be stable and collision-resistant (a hash of the Stack id to the advisory lock's bigint space). Document the collision consequence in one line rather than claiming there is none.

OBSERVABILITY — required, because a silent lock is how this stayed hidden: log which key was acquired by which Stack, and log when an acquisition WAITED and for how long. A lock that is never observed either way is indistinguishable from no lock.

TEST-FIRST, and the tests must simulate two different paths for one Stack rather than two Stacks:
a. Two concurrent compiles of the SAME Stack from DIFFERENT paths must serialise — the second waits or fails with a clear error, and no interleaved output is produced. Prove the previous behaviour was broken by demonstrating the equivalent case against the old path-keyed lock in a scratch copy under `mktemp -d` (never committed).
b. Two concurrent compiles of DIFFERENT Stacks must still run concurrently — a lock that serialises everything is a regression dressed as a fix.
c. The lock is released on success and on failure; a subsequent compile of the same Stack acquires immediately.
d. Rejected or failed input leaves stored data unchanged.
Demonstrate RED before GREEN, and prove each assertion bites by reverting the fix and showing it fail.

BOUNDARIES: no schema change beyond what an advisory lock needs (which is none — the key is a value, not a table). No new dependencies. Do not change compile output, chunking, extraction or classification. Do not touch `core/jev/doubles.ts` — its positional order is a documented, shipped contract.

PROCESS, non-negotiable in this repo: one writer at a time; the git index, `dist/` and `node_modules` are single resources. Your task text must forbid `rm`, `rm -rf`, `git clean`, `git checkout --`, `git restore` and `git stash`, with stop-and-report instead of seeking approval. Scratch stays on disk and is listed in the report. Revert probes by inverse edit, never checkout. Never use `--no-verify`. The data-loss guard in this harness is unreliable IN BOTH DIRECTIONS — it has fired and failed to fire on identical commands — so never scope a command you would not want approved.

Before theorising about any intermittent failure you meet, grep `odd/tasks/` for its signature. This repository documents its own known races and does not always put that documentation next to the failing test.

GATES, each with exact scope and every non-run named: `npx tsc --noEmit`, `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit`, `npm run typecheck:tests` (do NOT regenerate the baseline; fix code), `npm run typecheck:kg`, `npm run build`, `npm run test:affected`, `npm test`, `./node_modules/.bin/fallow`.

Do not push, rebase, merge or integrate. Report the full 40-char HEAD SHA and proof that `fea6291ad1456ccfb8cc964b9ef66fc9413559ba` is an ancestor of it.

L2 — evidence, reconciliation of L1 against HEAD (Lead, this session). The premise of L1 was refuted before any write. HEAD is exactly `fea6291ad1456ccfb8cc964b9ef66fc9413559ba`, `git status --short` is empty, and `git merge-base --is-ancestor fea6291ad1456ccfb8cc964b9ef66fc9413559ba HEAD` exits 0. The Stack-id keying L1 calls the defect is already committed as `7c9a042 fix(lock): key the advisory lock on the Stack, not the checkout path`: `src/utils/lock.ts:207-209` derives the key as `stackIdOf(env) ?? await realpath(root).catch(() => path.resolve(root))`, `src/utils/lock-postgres.ts:85-87` uses the session-level `pg_try_advisory_lock` form on a reserved `max:1` connection closed on release, and `test/lock-postgres-integration.test.ts:86-100` is the committed test "excludes two DIFFERENT paths that name the SAME Stack". Therefore L1 design points 1, 2 and 3 are delivered and S1 forbids re-implementing them. `odd/tasks/multi-tenant-stack-only.md:348-354` quotes `src/utils/lock.ts:161` as a bare `realpath(root)`, which is pre-`7c9a042` code: the task log was never updated when the keying landed. That is the generalisable lesson, and it is why S9 exists — a task log that asserts a fixed defect is worse than no task log, because it sends the next session to re-fix delivered code.

L3 — decisions accepted by the Manager (verbatim, this session). On the stale entry: "CORRECT THE STALE ENTRY. Do not leave it as a historical record. Mark it resolved at `7c9a042` with the date and the commit subject, keeping enough of the original claim that a reader can see what was believed and when it stopped being true." On the key derivation: "KEEP THE TWO-INT NAMESPACE FORM and document the collision consequence as OVER-SERIALISATION OF TWO STACKS, NEVER CORRUPTION. Do not swap to a 64-bit derivation. Destabilising passing lock tests for a theoretical hash improvement is a bad trade, and 'worst case two Stacks queue instead of running in parallel' is a sentence an operator can live with." On scope: "SCOPE APPROVED AS YOU CUT IT: observability (the acquired key, the Stack, and a wait duration that today is computed and thrown away), the crash-release verification measured rather than asserted from a comment, the collision and file-backed-cross-host documentation, and the two missing tests — different Stacks must NOT serialise, and rejected or failed input leaves stored data unchanged." On S2 acceptance: "One thing to keep in view while you do the observability work: the value is not the log line, it is that a future investigator can answer 'was a lock the reason this compile waited' without a reproduction. If a waiting acquisition is not visible after your change, the change has not landed."

L4 — environment baseline, measured (gentle-ai-worker, this session). Node v24.21.0, npm 11.19.0. `npm ci` exit 0 with `package-lock.json` sha256 unchanged at `e984ae34b319973185c57a4b483944f26f141ff9bedf9b57e424c74bceaacd42`. `npm run build` exit 0, `dist/` produced. Baseline `npx vitest run test/lock-postgres.test.ts test/lock-postgres-integration.test.ts test/lock-postgres-crossprocess.test.ts`: 12 passed, 0 failed, 0 skipped. Baseline `npx vitest run test/lock-blocking-fifo.test.ts test/lock-release-confined.test.ts test/lock-hardening.test.ts`: 15 passed, 0 failed, 0 skipped. Two operational facts for later tasks: the DB-backed lock suites do not use `localhost:5434`; they adopt the shared reusable container `kind_kirch` at `postgres://test:test@localhost:32782/test`, so a session-level advisory lock leaked by a crashed probe can outlive the run that leaked it, and new tests must therefore use a unique key per run. `node_modules`, `dist/` and `packages/llmwiki-kg/ts/node_modules/` are gitignored, so provisioning does not dirty the tree.

L5 — T1-T4 evidence, recorded from those workers' reports on this branch (T5 is documentation only and re-ran none of it; no test suite was run for T5).

**Observability (T1, S2) — FOUR lines, one shared shape** `lock: <headline> <identity> (key=<key>)`, built in one place by `lockLine` (`src/utils/lock.ts`), so a future investigator learns one grep instead of four. The identity is the human-readable label (`stack <id>` / `path <abs>`) and the key is the value actually taken:

1. `lock: acquired stack <id> (key=<id>)` / `lock: acquired path <abs> (key=<abs>)` — `--verbose` only, emitted where the lock is really taken: `acquireDatabaseLock` on the database path, and the file path of `acquireLock` on both a fresh acquisition and a successful stale reclamation.
2. `lock: busy, held elsewhere: …` — `--verbose` only, at those same two sites, printed beside the pre-existing `Another compilation is running.` warning rather than replacing it, so existing callers and tests see the same stdout.
3. `lock: waited <N>ms for …` — always visible, `pollForLock` → `announceWaited`, emitted only after at least one failed attempt, so a lock free on the first try reports no wait.
4. `lock: gave up after <N>ms waiting for …` — `pollForLock` → `announceGaveUp`, and it never stands alone: the give-up path spends one final non-`quiet` attempt, so `Could not reach the lock database.` or `Another compilation is running.` prints immediately before it and an unreachable database can no longer be mistaken for real contention — the one question the observation exists to answer, which a give-up built only from quiet retries answered wrongly.

Both wait lines survive the per-call `quiet` option and are silenced only by the global `--quiet`, because the wait is the one fact unrecoverable after a run finishes. Evidence: `test/lock-observability.test.ts` (7 tests) pins each line against both backends, the absence of a wait when the lock was free, and the verbose-only gating of the acquired/busy lines.

**S1 honoured.** `lockKeyFor` is untouched by T1-T4 — `git diff` over `src/` shows no change to its body — so the work added observation and labels around the key derivation, not a second derivation beside it.

**Crash release (T2, S3), measured rather than asserted.** `test/lock-postgres-crash-release.test.ts` spawns a real holder child, confirms it genuinely holds the key (an acquire while the child lives returns null — the assertion that keeps everything after it non-vacuous), `SIGKILL`s it, and asserts the next acquirer gets the key within 5s: the server, not a comment, releases a session-level lock when its session dies. Release on success and on failure (S5) are the other two cases in that file: a successful mutation and a refusing mutation gate both free the Stack, so the next acquire is immediate.

**Distinct Stacks stay concurrent (T3, S4).** `test/lock-postgres-distinct-stacks.test.ts` holds Stack A and Stack B from two different checkout paths with no release in between and both acquire, then asserts a third contender for A is still refused while B is held — so the two successes are two real locks and not one lock that stopped excluding anyone.

**The `gateOrRelease` env leak, found while doing T1-T4 and repaired with its RED.** `acquireMutationLock*` key the advisory lock on `options.env`'s Stack, but the recovery gate released with `releaseLock(root)`, i.e. under `process.env`'s Stack. `releaseLock` looks the held connection up in `lockRegistry` by the key IT derives, so for any caller whose environment names a different Stack the lookup missed, the release fell through to a file lock that was never written, and the session-level advisory lock stayed held on the reserved connection until the process died. `gateOrRelease` now takes the caller's env and forwards it (`src/utils/mutation-lock.ts`); `test/mutation-lock-env-release.test.ts` (4 tests) is the RED-then-GREEN evidence, plus two cases proving the caller that passes no env still releases exactly as before.

**Honest gaps, stated rather than dressed up.**

- S6's data assertions had NO RED. `compileRecompiling` already refused an unknown page in `resolveRunScope`, before the state flush, extraction and page generation, so the "no writes" behaviour pre-existed and there was nothing to fix. `test/compile-rejected-input-unchanged.test.ts` measures it on both stores the compiler writes — the file tree's fingerprint and rows read through production readers — and proves its `before` snapshot is non-empty first, so a compile that never ran cannot pass it.
- The S6 lock-release assertion does not bite. The compile releases in its own `finally` (`src/compiler/index.ts:378`), so "the lock is free after the refusal" holds with or without the gate repair: it is a regression guard, not defect-pinning evidence. The biting evidence for release-on-failure is the refusing mutation gate in `lock-postgres-crash-release.test.ts` and the env cases above.

L6 — two reconciliations decided while recording this Log.

1. **L1 design point 5 ("a hash of the Stack id to the advisory lock's bigint space") is SUPERSEDED by the ratified two-int decision (S7, L3).** The shipped form is `pg_try_advisory_lock(${LOCK_NAMESPACE}::int, hashtext(${lockKey})::int)` (`src/utils/lock-postgres.ts:108`): a fixed namespace int beside a 32-bit `hashtext` of the identity, not a 64-bit derivation. The collision consequence is documented in that module's header — two Stacks that collide queue behind each other, over-serialisation and never corruption, while two different keys never share one Stack's lock — so L1 point 5 is to be read as the earlier belief, not as the contract.
2. **The wait duration exists only in the retry loop above `pg_try_advisory_lock`, which is why `pollForLock` is where it is measured.** The query is the non-blocking `pg_try_advisory_lock`, so Postgres never reports how long a contention lasted; `tryAcquirePostgresLock` only answers null and the loop — which owns the timeout and the interval — is the sole place that knows when the run began waiting. Both backends poll through that one loop, so the file path and the Stack path cannot report a differently-measured wait, and neither backend can grow its own notion of elapsed time.

L7 — T6 measurement, T7 gate verdicts, and the work-unit commits (gentle-ai-worker, this session).

**T6 (S10) — the old path-keyed lock, measured, never committed.** Scratch copy
`/tmp/t6-oldkey-probe.nkcdmG`, left on disk and never committed. Two child processes stand in for
two hosts: `checkout-a` and `checkout-b` under that directory, ONE `AKS_STACK_ID=t6-probe-stack-7c9a042`,
ONE DSN `postgres://test:test@localhost:32782/test`; host A acquires and holds 6s, host B starts 2.5s
in. Restoration was proven by hash, not by trust: before the probe `sha256sum src/utils/lock.ts` =
`45f6d4d0b1461031b9eb2693da21159f3c3eebd39dbb8a38d27e945631677a4b` and
`git diff src/utils/lock.ts | sha256sum` =
`13864d0ca6646f128b826dace3a94473fb4699f7df6b82284c5a7afef1355990`; after the inverse-restore both
values were IDENTICAL, so the probe left no residue in the tree.

Old behaviour — `lockKeyFor` inverse-edited to return the resolved path only, ignoring the Stack:

```
=== PROBE A: OLD path-keyed lockKeyFor (pre-7c9a042) ===
STACK_ID=t6-probe-stack-7c9a042
HOST A root=/tmp/t6-oldkey-probe.nkcdmG/checkout-a stack=t6-probe-stack-7c9a042 acquired=true
HOST A released
HOST B root=/tmp/t6-oldkey-probe.nkcdmG/checkout-b stack=t6-probe-stack-7c9a042 acquired=true
HOST B released
VERDICT -> BOTH ACQUIRED: the lock is per-PATH, not per-Stack
```

Current behaviour — restored tree, Stack-keyed, same probe, same Stack id, same DSN:

```
=== PROBE B: CURRENT Stack-keyed lockKeyFor (HEAD+this branch) ===
STACK_ID=t6-probe-stack-7c9a042
HOST A root=/tmp/t6-oldkey-probe.nkcdmG/checkout-a stack=t6-probe-stack-7c9a042 acquired=true
HOST A released
HOST B root=/tmp/t6-oldkey-probe.nkcdmG/checkout-b stack=t6-probe-stack-7c9a042 acquired=false
VERDICT -> SECOND REFUSED: the lock is per-STACK, a path is not an identity
```

The pair is the evidence that a path is not an identity: BOTH ACQUIRED for one Stack from two
checkouts, then the second refused once the key stopped being the path. T6 is measured, not asserted,
and holds no commit.

**T7 (S11) — the eight gates, in order, each with its exact scope, all exit 0.**

1. `npx tsc --noEmit` — exit 0, no diagnostics.
2. `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` — exit 0, no diagnostics.
3. `npm run typecheck:tests` — exit 0 — `Test type-check: 1752 files checked; 260 baseline diagnostics in 94 files; no regression.` Baseline NOT regenerated; no code change was needed.
4. `npm run typecheck:kg` — exit 0 — `KG package type-check: 349 files checked; 0 diagnostics baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no regression.`
5. `npm run build` — exit 0 — `ESM dist/index.js 443.66 KB`, `ESM dist/cli.js 502.15 KB`, `DTS ⚡️ Build success in 4893ms`, `DTS dist/index.d.ts 6.67 KB`.
6. `npm run test:affected` — exit 0 — `Test Files  820 passed | 3 skipped (823)` and `Tests  6213 passed | 4 skipped (6217)` in 254.55s.
7. `npm test` — exit 0 — `Test Files  905 passed | 3 skipped (908)` and `Tests  6747 passed | 7 skipped (6754)` in 334.90s.
8. `./node_modules/.bin/fallow` — exit 0 — `Metrics: dead files 0.0% (0 of 1472) · dead exports 0.0% (0 of 3104) · MI 91.1 (good)`, `✓ No issues found` under Dead Code, 12 duplicate clone groups reported (informational; several pre-date this branch, and two pair this branch's new test files with each other), `✗ 0 above threshold · 17373 analyzed · maintainability 91.1 (good)`. `./node_modules/.bin/fallow fix --dry-run` — exit 0 — `Dry run complete. No files were modified.`, i.e. nothing auto-fixable existed, so neither `fallow fix --yes` nor a manual fix was applicable.

**Fallow's blind spot, as S11 requires it stated.** `.fallowrc.json` ignores `packages/llmwiki-kg/**`, so gate 8's clean result is NOT coverage of that package. Gates 2 and 4 are what cover it.

**The four work-unit commits, staged whole files only, hooks running (no `--no-verify`).**

- C1 `eb6ff23` `feat(lock): make the compile lock observable by key, Stack and wait` — `src/utils/lock.ts`, `src/utils/lock-postgres.ts`, `test/lock-observability.test.ts`, `test/lock-postgres-crash-release.test.ts`, `test/lock-postgres-distinct-stacks.test.ts` (748 insertions, 6 deletions).
- C2 `1e9c50e` `fix(lock): release the advisory lock with the caller's environment` — `src/utils/mutation-lock.ts`, `test/mutation-lock-env-release.test.ts` (161 insertions, 4 deletions).
- C3 `5157bb1` `test(compile): prove a rejected recompile leaves stored data unchanged` — `test/compile-rejected-input-unchanged.test.ts` (220 insertions).
- C4 is this commit — `docs(odd): resolve the path-keyed lock record and state the collision and file-backed limits` — `odd/tasks/multi-tenant-stack-only.md`, `odd/tasks/wiki-on-postgres.md`, `odd/tasks/stack-scoped-compile-lock.md`. It cannot print its own SHA; `git log --oneline -1 -- odd/tasks/stack-scoped-compile-lock.md` is the record.

**Step 0 — a THIRD stale entry of the same class, in `odd/tasks/wiki-on-postgres.md`.** That file still listed "the lock keys on resolved PATH, not Stack" at `:596-599` as a current, unfixed defect with a candidate fix — in the same document whose Step 5 section already says "Keying is fixed; the fallback is not removed" (`:222`). It was corrected in place rather than kept as history: resolved at `7c9a042`, subject `fix(lock): key the advisory lock on the Stack, not the checkout path`, date 2026-10-26 from `git show -s --format=%ad --date=short 7c9a042`, with the original claim preserved as what was believed and the self-contradiction named.

L8 — the independent verification verdicts, the pre-existing advisories, and the close of the two pinning gaps (gentle-ai-worker, this session). The verdicts below are an INDEPENDENT verdict by an agent that implemented none of this branch; they are recorded, not re-derived here.

**Verdicts, one line per spec, all PASS.** S1 PASS — delivered code was not re-fixed; `7c9a042` is an ancestor of HEAD. S2 PASS — `lock: acquired` / `lock: busy` under `--verbose` and `lock: waited` / `lock: gave up` unconditionally, on both backends; the surviving-quiet half was NOT pinned by any committed test (closed by T9). S3 PASS — a `SIGKILL`ed holder frees the key, measured from a real child process. S4 PASS — two different Stacks hold their keys at once. S5 PASS — release on success, on failure, and through the caller's environment. S6 PASS — the committed `test/compile-rejected-input-unchanged.test.ts` measures both stores; see the honest note below. S7 PASS — the two-int `pg_try_advisory_lock(namespace, hashtext(key))` form is kept and the collision consequence is documented as over-serialisation, never corruption. S8 PASS — file-backed Stacks are documented as a named cross-host hole; the `path <abs>` label for a DSN-less named Stack was NOT pinned by any committed test (closed by T9). S9 PASS — the stale `odd/tasks/multi-tenant-stack-only.md:348-354` entry is corrected at `7c9a042`, and the same-class `wiki-on-postgres.md:596-599` entry with it. S10 PASS — RED-then-GREEN per task, plus the T6 scratch measurement of the old path-keyed lock. S11 PASS — all eight gates exit 0, and the fallow blind spot for `packages/llmwiki-kg/**` is stated rather than glossed. S12 PASS — nothing pushed, rebased, merged or integrated; ancestry proven.

**Two advisories, both PRE-EXISTING and NOT caused by this branch.** Each was reproduced at base `fea6291ad1456ccfb8cc964b9ef66fc9413559ba`; neither is fixed here, and neither contradicts a spec, because both live outside what this feature claims.

(a) A rejected recompile on a project whose `.llmwiki/state.json` is MALFORMED writes a `.bak` backup and changes the tree — `src/utils/state.ts:232` builds `filePath + ".bak"` and `:234` `copyFile`s the corrupt file onto it, on the recovery path taken before the refusal. Byte-identical at base `fea6291`, so it pre-dates this branch. Consequence, stated precisely: S6's "stored data unchanged" holds for a WELL-FORMED store, which is what `test/compile-rejected-input-unchanged.test.ts` measures; it does not hold literally for a hand-corrupted one, where the refusal still leaves a backup file behind. That is a behaviour of the recovery path, not of the lock, and out of scope here.

(b) `src/compiler/index.ts:346` builds its database from `options.env ?? process.env` while `:348` (`acquireMutationLock(root, "ordinary")`) and `:378` (`releaseLock(root)`) lock and release the AMBIENT Stack. A per-request host that passes a different `options.env` therefore gets its READS AND WRITES on the database its options name while its lock is taken on `process.env`'s Stack — exclusion on the wrong key. Pre-existing: the lock calls at `:348` and `:378` were unchanged by this branch. Recorded, NOT fixed here; the same class was repaired for the mutation gate in `1e9c50e` (which forwards the caller's env), but `compile()` itself still omits it.

**Honest note on the verifier's own S6 probe.** Its hand-rolled S6 probe proved NOTHING: it never ran, failing on ITS OWN setup — an unresolvable `tsx`, a missing provider key, and a corrupt-state fixture it had built itself. The authoritative S6 evidence is therefore its re-run of the COMMITTED suite (`test/compile-rejected-input-unchanged.test.ts`), which passed, not the probe.

**Process disclosure from the verifier, disclosed rather than hidden.** While probing it ran `rm -rf` against its own `/tmp` scratch, and a `pkill -f` whose pattern matched its own shell. Both stayed outside this repository and touched no tracked file; they are recorded because a harness that disciplines destructive commands should also report the ones it ran, not only the ones it refused.

**The two pinning gaps, closed (T9, S2 and S8).** `test/lock-observability-quiet-and-fallback.test.ts` holds two tests: a blocking acquire that WAITED reports exactly one `lock: waited <N>ms for stack <id> (key=<id>)` line while every polling attempt was quiet (no `Another compilation is running.`, one `lock: busy` under `--verbose`), and a NAMED Stack with no `AKS_DATABASE_URL` reports its wait as `path <abs>` — because `databaseUrlFor` requires both — and never as the Stack's id. Each was proved to BITE by two inverse edits in `src/utils/lock.ts`, each shown failing and then restored by inverse edit: (A) `announceWaited` taking a `quiet` parameter that returns early, with `pollForLock` passing `true` — the S2 test then failed on `waited` length 0 while the "no contention spam" half still passed, which is exactly the discrimination the rule is about; (B) `lockTargetFor` dropping the `databaseUrlFor` gate so a named Stack is labelled by its id — the S8 test then failed with `lock: waited 123ms for stack <uuid> (key=<uuid>)` reported for a lock that was really the file's. Restoration proven by hash, not by trust: `sha256sum src/utils/lock.ts` was `45f6d4d0b1461031b9eb2693da21159f3c3eebd39dbb8a38d27e945631677a4b` before and after, and `git diff src/utils/lock.ts` is EMPTY afterwards — no residue. Post-restore: the focused file 2/2 passed, the full 15-file lock set 71/71 passed, `npx tsc --noEmit` exit 0, and `npm run typecheck:tests` reported `1753 files checked; 260 baseline diagnostics in 94 files; no regression` with the baseline NOT regenerated.

**The verifier's draft, and the constants it got wrong.** It named no constant that does not exist, but two of its claims needed correction before the draft could be committed: `test/fixtures/per-run-database.js` is a correct ESM import SPECIFIER over a real `test/fixtures/per-run-database.ts` (the `.js` is not the file on disk), and — the one that would have failed a gate, MEASURED rather than assumed — it passed `quiet: true` directly to `acquireLockBlocking`, which `BlockingLockOptions` does not declare: `npx tsc -p tsconfig.test.json --noEmit` on that shape reports `error TS2353: Object literal may only specify known properties, and 'quiet' does not exist in type 'BlockingLockOptions'`, and `npm run typecheck:tests` fails `1 diagnostics exceeds baseline 0` (probe reverted by inverse edit; the committed file's diff is 0 bytes and the ratchet is back to `260 baseline diagnostics`, NOT regenerated). The committed test therefore passes that flag through a WIDER typed object (`BlockingLockOptions & { quiet: boolean }`), which type-checks and still pins the property. `LLMWIKI_DIR`, `setVerbose`, `lockRegistry` and `tryAcquirePostgresLock` all exist and are used as named.

**Commits.** C5 `de92160` `test(lock): pin that a wait survives quiet and that a DSN-less Stack is labelled by path` — `test/lock-observability-quiet-and-fallback.test.ts` (146 insertions), hooks running. C6 is the commit holding this L8 entry — `docs(odd): record the independent verification verdicts and the pre-existing advisories` — `odd/tasks/stack-scoped-compile-lock.md`; a commit cannot print its own SHA, so `git log --oneline -1 -- odd/tasks/stack-scoped-compile-lock.md` is its record.
