# Derived-artifact source — thread the request environment

Branch `fix/derived-source-request-env`, base HEAD `f10046fc91da434a8532e088e62e02192a9fd85c`.
HIGH RISK: tenant isolation — the defect this branch closes is a CROSS-TENANT WRITE, one tenant's `index.md`/`MOC.md` rendered into another tenant's Stack.

## Specs

**S1 — The defect.** "`src/compiler/indexgen.ts:63` and `src/compiler/obsidian.ts:128` call `withDerivedSource(process.env, …)`. A per-request run therefore renders `index.md` / `MOC.md` INTO THE AMBIENT STACK while its pages, state and journal go to the request's Stack. With a non-existent ambient Stack it fails loudly (`PostgresError … derived_artifact_stack_id_fkey`), which is the lucky case; when an ambient Stack DOES exist, this is a silent CROSS-TENANT WRITE. That is not a mis-keyed lock, it is one tenant writing into another tenant's data."

**S2 — The fix.** "thread the request's env through both call sites exactly as the preceding fix threaded `options.env` through `acquireMutationLock` and `releaseLock` in `src/compiler/index.ts` — same shape, same reasoning. `withDerivedSource(requestEnv, …)` where `requestEnv` is `options.env ?? process.env`, so the CLI path stays byte-identical and only a per-request caller changes behaviour."

**S3 — Stop condition.** "If either call site turns out to have no access to the request env at that point, STOP and report the plumbing gap rather than reaching for `process.env` as a default that silently re-creates the bug."

**S4 — Cross-tenant test.** "With a request env naming Stack A and a DIFFERENT ambient Stack B, the derived artifacts (`index.md`, `MOC.md`) are written to A and NOTHING is written to B. Assert B's derived-artifact set is unchanged, not merely that A received the write — the bug is the write to B."

**S5 — Preserve test.** "The omitted-env caller (CLI path) still writes to the ambient Stack: a preserve test proving the previous behaviour is intact."

**S6 — Rejected input.** "Rejected or failing input leaves both Stacks' stored data unchanged."

**S7 — RED before GREEN.** "Demonstrate RED before GREEN against the current code, and prove each assertion bites by reverting the threading and showing the cross-tenant test fail."

**S8 — Census.** "grep for any OTHER `process.env` argument passed to a seam that resolves a Stack or a tenant inside a request-scoped path. The preceding fix found one seam further out twice in a row (the lock, then this), so assume a third may exist until a census says otherwise. If the census finds more, list them with file:line and do not expand this branch without telling me."

**S9 — Boundaries.** "no schema change, no new dependencies, no change to rendering output, chunking, extraction or classification."

**S10 — Gates.** "`npx tsc --noEmit`, `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit`, `npm run typecheck:tests` (do NOT regenerate the baseline), `npm run typecheck:kg`, `npm run build`, `npm run test:affected`, `npm test`, `./node_modules/.bin/fallow`." and "Do not push, rebase, merge or integrate. Report the full 40-char HEAD SHA and proof that `f10046fc91da434a8532e088e62e02192a9fd85c` is an ancestor of it."

**S11 — Process.** "one writer at a time; the git index, `dist/` and `node_modules` are single resources." and the forbidden-command set: "`rm`, `rm -rf`, `git clean`, `git checkout --`, `git restore`, `git stash`, and ANY `pkill`/`killall` — for process cleanup the only permitted form is `pgrep -f 'exact/path\.mts'`, inspect the printed PIDs, then `kill <pid>`, and never from a command whose own argv contains the pattern". and "Revert probes by inverse edit, never checkout." and "Never `--no-verify`."

## Reconnaissance (measured at HEAD f10046f)

### Measured findings

- **Total `withDerivedSource` call sites in `src/`: 2**, at `src/compiler/indexgen.ts:63` and `src/compiler/obsidian.ts:128`, both passing `process.env`.
- **`withDerivedSource` signature** `src/dimensions/wiki/derived-artifact-source.ts:46-49`; it resolves `artifactStackId(env)` (`:25-28`, reads `env[AKS_STACK_ID_ENV_VAR]`) and WRITES via `saveDerivedArtifact(handle.db, stackId, kind, …)` (`:55`). Kinds written: `"index"` (`indexgen.ts:66`) and `"moc"` (`obsidian.ts:130`); upsert into `wiki.derived_artifact (stack_id, kind, content)` (`derived-artifact-store.ts:47-60`). When no Stack is resolved, both fall back to a file write (`atomicWrite(root/INDEX_FILE)` `indexgen.ts:68`; `atomicWrite(root/MOC_FILE)` `obsidian.ts:133`).
- **`regenerateIndices(root, env, options)`** `src/dimensions/wiki/page-source-seam.ts:214-223` already RECEIVES the request env and hands it to `withPageScan(env, …)` at `:219`, but calls `generateIndex(root, source)` / `generateMOC(root, source)` at `:220-221` with no env.
- **`generateIndex` signature** `indexgen.ts:37-40` and **`generateMOC` signature** `obsidian.ts:112-115`: neither accepts an env/options parameter.
- **PLUMBING GAP 1:** `src/compiler/index.ts:1787` calls `regenerateIndices(root, process.env)` inside `finalizeWiki` (`:1707-1713`), which has NO env/options parameter. Its sole caller is `seedThenFinalize` (`:804-816`, has `options: CompileOptions`, calls finalize at `:822-833`); both `seedThenFinalize` callers hold the request env — `finalizeNothingToCompile` (env at `:1060`, `NothingToCompileInput.env` at `:1037`) and `runCompilePipeline` (`const env = options.env ?? process.env;` at `:1127`). Precedent for carrying it: `FinalizeFlags` (`:1474-1556`) already carries values "because finalize is three levels below the pipeline" (`:1486-1492`, `:1521-1528`).
- **PLUMBING GAP 2:** `src/import/okf-refresh.ts:35` `withPageSeams(process.env, …)` and `:39` `regenerateIndices(root, process.env)` inside `refreshAfterImport(root, pageIds)` (`:25`), whose MCP caller passes a real `env` (`src/mcp/okf-tools.ts:63`, `src/import/run.ts:82` with env from `:137`).
- **BENIGN (CLI-only, ambient Stack IS the correct Stack):** `src/commands/review-approve.ts:403`, `src/sources/removal.ts:419`, `src/compiler/index.ts:346` and `src/utils/lock.ts:210` (already request-aware).
- **CENSUS — THIRD SEAM CLASS (report only, NOT this branch):** `src/compiler/candidates.ts:197,229,432,466` (`withCandidateSource`), `src/compiler/candidate-read.ts:183,472`, `src/compiler/candidate-rejection.ts:19,49`, `src/dimensions/wiki/reader.ts:173` (`withPageSource`). `CandidateRowsSource` exposes `save`/`remove` (`src/dimensions/wiki/candidate-source.ts:43-52`) so four of these are WRITES to a Stack-resolved destination; the candidate/pages readers are read-only. None of these enclosing functions has an `env`/`options` value in lexical scope. Reachable from the request-scoped compile via `review-pipeline.ts:155` ← `generateMergedPage` (`:70-78`, has `CompileOptions`) ← `index.ts:455`. Complete fix would need ~9 new parameters; out of scope here.
- **TEST-DEPENDENT-ON-THE-BUG:** `test/dimensions/regenerate-indices.test.ts:45-66` asserts `readFile(root/wiki/index.md)` contains "Alpha" while `env` names a Stack; it passes today only because the artifact destination reads the ambient env. It will flip when this is fixed and must be reconciled with the S5 preserve semantics, not deleted.
- **STALE TASK-DOC CITATIONS (do not fix here, record only):** `odd/tasks/all-tools-without-stackId.md:121` and `odd/tasks/reach-test.md:29` cite `src/compiler/index.ts:1191` (now `:1787`) and claim `src/utils/lock.ts` takes no env (now false, `lock.ts:210`); `odd/tasks/wiki-parity-audit.md:44-45` cites `indexgen.ts:59`/`obsidian.ts:125`. `odd/tasks/all-tools-without-stackId.md:121` states these lines must be fixed as one indivisible change.

## Tasks

- [x] **T1** (S1-S3) — feature document (this file) — route: worker — commit: none (doc only).
- [x] **T2** (S8) — `process.env`→Stack/tenant seam census recorded in Reconnaissance above — route: verifier recon — done.
- [x] **T3** (S4,S7) — RED cross-tenant test through the request-scoped compile path — status: covered, `test/compile-request-stack-derived-env.test.ts`, 4 tests (cross-tenant, index-only `skipMoc`, omitted-env preserve, refused run) — commit: the commit that contains this line (C1); a commit cannot record its own SHA, so read it with `git log --oneline -1 -- odd/tasks/derived-source-request-env.md`.
- [x] **T4** (S2) — `generateIndex`/`generateMOC` take the run's env as a REQUIRED parameter and pass that exact value to `withDerivedSource`; `regenerateIndices` forwards its existing `env` — status: covered — commit: C1.
- [x] **T5** (S2,S3) — the two pass-throughs (`finalizeWiki` via `FinalizeFlags`, `refreshAfterImport`), authorized by the Manager in L5 under four conditions, none of which fired wider than approved — status: covered (`src/compiler/index.ts`, `src/import/okf-refresh.ts`, `src/import/run.ts`) — commit: C1.
- [x] **T6** (S5,S6) — preserve test for the omitted-env CLI caller, refused input leaving both Stacks unchanged, plus TWO collateral reconciles (`test/dimensions/regenerate-indices.test.ts`, `test/mcp/journal-isolation.test.ts`), each with its argument in L6 — status: covered — commit: C1.
- [x] **T7** (S7) — RED before GREEN plus FOUR inverse-edit probes, each failing a distinct assertion (L6) — status: covered — commit: C1.
- [x] **T8** (S10) — eight gates, all exit 0 (L6), one work-unit commit (C1) and this doc-only SHA record (C2), HEAD/ancestry proof in L6 — route: worker — commit: C2.

S4's own acceptance criterion cannot be met without T5, which is why this document does not start T3/T4 before the Manager rules.

## Log

L1 — the branch assignment, verbatim (Manager → Lead, this session):

````text
Bounded but HIGH-RISK fix — this is tenant isolation. Read `AGENTS.md` first; also read `odd/tasks/stack-scoped-compile-lock.md` for the immediately preceding, related fix. Environment: Node 24 only (`$HOME/.nvm/versions/node/v24.21.0/bin` on PATH); `npm ci` with the lockfile pinned; build `dist/` before any `fallow` measurement. `.fallowrc.json` ignores `packages/llmwiki-kg/**`.

THE DEFECT, measured by the previous Lead rather than inferred: `src/compiler/indexgen.ts:63` and `src/compiler/obsidian.ts:128` call `withDerivedSource(process.env, …)`. A per-request run therefore renders `index.md` / `MOC.md` INTO THE AMBIENT STACK while its pages, state and journal go to the request's Stack. With a non-existent ambient Stack it fails loudly (`PostgresError … derived_artifact_stack_id_fkey`), which is the lucky case; when an ambient Stack DOES exist, this is a silent CROSS-TENANT WRITE. That is not a mis-keyed lock, it is one tenant writing into another tenant's data.

THE FIX: thread the request's env through both call sites exactly as the preceding fix threaded `options.env` through `acquireMutationLock` and `releaseLock` in `src/compiler/index.ts` — same shape, same reasoning. `withDerivedSource(requestEnv, …)` where `requestEnv` is `options.env ?? process.env`, so the CLI path stays byte-identical and only a per-request caller changes behaviour. If either call site turns out to have no access to the request env at that point, STOP and report the plumbing gap rather than reaching for `process.env` as a default that silently re-creates the bug.

TEST-FIRST, and the central test must be a CROSS-TENANT assertion, not a smoke test:
a. With a request env naming Stack A and a DIFFERENT ambient Stack B, the derived artifacts (`index.md`, `MOC.md`) are written to A and NOTHING is written to B. Assert B's derived-artifact set is unchanged, not merely that A received the write — the bug is the write to B.
b. The omitted-env caller (CLI path) still writes to the ambient Stack: a preserve test proving the previous behaviour is intact.
c. Rejected or failing input leaves both Stacks' stored data unchanged.
Demonstrate RED before GREEN against the current code, and prove each assertion bites by reverting the threading and showing the cross-tenant test fail.

ALSO CHECK, and report rather than fix if it is broader: grep for any OTHER `process.env` argument passed to a seam that resolves a Stack or a tenant inside a request-scoped path. The preceding fix found one seam further out twice in a row (the lock, then this), so assume a third may exist until a census says otherwise. If the census finds more, list them with file:line and do not expand this branch without telling me.

BOUNDARIES: no schema change, no new dependencies, no change to rendering output, chunking, extraction or classification.

PROCESS, non-negotiable: one writer at a time; the git index, `dist/` and `node_modules` are single resources. Your task text must forbid `rm`, `rm -rf`, `git clean`, `git checkout --`, `git restore`, `git stash`, and ANY `pkill`/`killall` — for process cleanup the only permitted form is `pgrep -f 'exact/path\.mts'`, inspect the printed PIDs, then `kill <pid>`, and never from a command whose own argv contains the pattern; a verifier on a sibling branch killed its own parent shell that way. Stop and report instead of seeking approval for a destructive step. Scratch stays on disk and is listed. Revert probes by inverse edit, never checkout. Never `--no-verify`.

Before theorising about any intermittent failure, grep `odd/tasks/` for the signature AND verify the cited line numbers against HEAD — a stale task entry on a sibling branch sent this session to re-fix delivered code.

GATES, each with exact scope and every non-run named: `npx tsc --noEmit`, `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit`, `npm run typecheck:tests` (do NOT regenerate the baseline), `npm run typecheck:kg`, `npm run build`, `npm run test:affected`, `npm test`, `./node_modules/.bin/fallow`.

Do not push, rebase, merge or integrate. Report the full 40-char HEAD SHA and proof that `f10046fc91da434a8532e088e62e02192a9fd85c` is an ancestor of it.
````

L2 — Evidence: read-only recon at HEAD `f10046fc91da434a8532e088e62e02192a9fd85c` (working tree clean) confirmed both call sites pass `process.env` and found the two request-scoped upstream call sites that re-inject it (`src/compiler/index.ts:1787`, `src/import/okf-refresh.ts:39`).

L3 — Deviation from the assignment's expected shape: the assignment anticipated threading only the two call sites; measurement shows `regenerateIndices` already holds the request env but drops it (`page-source-seam.ts:220-221`), so S2 additionally requires the two `generateIndex`/`generateMOC` parameters (T4, mechanical, no behaviour change), and S4's cross-tenant assertion additionally requires the `finalizeWiki` and `refreshAfterImport` pass-throughs (T5). Per S3, this branch stops and reports the plumbing gap instead of defaulting to `process.env`.

L4 — Decision requested from the Manager: authorize T5 (2 extra pass-through parameters, CLI byte-identical) so the compile path stops re-injecting `process.env`, or hold the branch to T4 only and reassign S4 to a call-site-level test. The third seam class (candidate/pages seams) is recorded in `## Reconnaissance` and deliberately NOT part of this branch.

L5 — Manager authorization of T5, and the two surface widenings (Manager → worker, this session).

The T5 authorization carries four non-negotiable conditions, verbatim:

- "(i) `options.env ?? process.env` is resolved ONCE at the boundary and threaded. NEVER re-default to `process.env` inside a nested function — that mechanism is how this defect survived two consecutive fixes. A function that receives env must use the received value verbatim; no `env ?? process.env`, no optional env parameter with an ambient fallback, no default parameter value of `process.env`."
- "(ii) `FinalizeFlags` for `finalizeWiki`; no second carrying mechanism."
- "(iii) The CLI path must be byte-identical, proven by the S5 preserve test — not asserted."
- "(iv) If T5 needs MORE than the two pass-throughs measured (`finalizeWiki`, `refreshAfterImport`) — any additional parameter or structural change — STOP and report instead of growing the branch."

Condition (iv) did NOT fire. T5 is exactly those two pass-throughs plus the one call-site argument each; no third parameter, no second carrying mechanism, and no positional parameter was added to `finalizeWiki` — the env rides on `FinalizeFlags`, which already existed for exactly this reason.

Two widenings were ruled during implementation, both argued before they were granted:

1. **Six test files, for the missing argument only.** Making the env parameter REQUIRED (condition i) left 17 call sites in six files one argument short, all of them at 0 diagnostics in `test-typecheck-baseline.json` (except `embeddings-v3-flip.test.ts` at 1), so each would have been a `TS2554` and a gate-3 regression. Added: `test/obsidian.test.ts` (lines 84, 99, 110, 118, 129), `test/compile-derived-confine.test.ts` (62, 72, 85, 95), `test/dimensions/derived-artifact-rows.test.ts` (41, 50, 62, 65, 95), `test/fixtures/generate-and-read-index.ts` (17), `test/embeddings-v3-flip.test.ts` (135), `test/okf-refresh-drains-pending.test.ts` (52). Ruling: "these are ambient-boundary callers, so the explicit `process.env` argument IS the byte-identical value condition (i) demands — the value is resolved once, at the true boundary, and threaded." Constraint: nothing but the missing argument, no test-logic edit, no new case.
2. **A seventh file, for one collateral reconcile.** Gate 6 measured exactly one failing pre-existing test, `test/mcp/journal-isolation.test.ts:116`, whose file assertion existed only because the tenant env was dropped. Ruling A: reconcile that ONE test, keeping its name, its intent and all three assertions. The approval was explicitly not a pattern: any eighth file must be asked for, and none was needed.

One environment fact, measured: this worktree had NO `node_modules` (`import('vitest')` → `ERR_MODULE_NOT_FOUND`), contrary to the assignment's premise. `npm ci` was approved and run with Node v24.21.0; exit 0, `package-lock.json` sha256 unchanged at `e984ae34b319973185c57a4b483944f26f141ff9bedf9b57e424c74bceaacd42`, and `git status --short` / `git diff --stat package-lock.json package.json` showed no tracked modification.

L6 — the measured outcome: arguments, RED, GREEN, four inverse-edit probes, both reconciles, and the eight gates (gentle-ai-worker, this session).

**Why the parameter is REQUIRED rather than optional.** An optional parameter, and above all a `= process.env` default, is precisely the mechanism that re-creates this defect one level down: the function looks like it was told a tenant, behaves as if it was when the ambient environment happens to agree, and silently resolves the ambient one when it does not. That is not a hypothetical — it is how the same wrong input survived two consecutive fixes (the lock, then this seam), because at every level the code had a plausible-looking ambient value to fall back to. A REQUIRED parameter removes the fallback from the type system rather than from a comment: the compiler now forces every caller to declare its environment, so a new request-scoped caller cannot inherit one by omission, and the six ambient-boundary callers had to say `process.env` out loud — which is the structural guarantee, and the reason (i) was not negotiable.

**The 17 call sites are a measurement of the defect's reach, not a chore.** Seventeen call sites across six files were implicitly reading the ambient Stack without saying so: `test/obsidian.test.ts` 5, `test/dimensions/derived-artifact-rows.test.ts` 5, `test/compile-derived-confine.test.ts` 4, `test/fixtures/generate-and-read-index.ts` 1, `test/embeddings-v3-flip.test.ts` 1, `test/okf-refresh-drains-pending.test.ts` 1. Each one is a place where the ambient default was load-bearing and invisible.

**THREE test files encoded the dropped tenant env** — this is the price the ambient default charged, recorded as evidence about reach rather than as housekeeping: `test/dimensions/regenerate-indices.test.ts` (asserted the file while its `env` named a Stack — reconciled), `test/mcp/journal-isolation.test.ts` (asserted the file for a NAMED Stack — reconciled), and `test/dimensions/derived-artifact-rows.test.ts`, which drives the ambient Stack on purpose via `withStackEnv` and whose file-ABSENCE assertion survives untouched and passing. A suite that passed *because* the destination ignored its argument is the same defect wearing a green tick.

**The six test files, as a boundary argument.** Those are ambient-boundary callers whose call sites had no env to pass, so `process.env` is the byte-identical argument there — a boundary argument, not a convenience argument. The strongest evidence is that `test/dimensions/derived-artifact-rows.test.ts` keeps its assertions untouched, driving the ambient Stack through `withStackEnv` and still asserting that `wiki/MOC.md` does NOT appear: a pre-existing test with unchanged assertions passing on both sides of the change is better S5 preserve proof than a newly written test, because nobody wrote it to agree with this fix.

**RED, captured before any `src/` edit** (`npx vitest run test/compile-request-stack-derived-env.test.ts` against base HEAD `f10046f` with only the new test file on disk):

````text
 FAIL  test/compile-request-stack-derived-env.test.ts > the derived artifacts follow the request's Stack > stores both artifacts in the request's Stack and leaves the ambient Stack untouched
AssertionError: expected { …(2) } to deeply equal { index: undefined, moc: undefined }
-   "index": undefined,
-   "moc": undefined,
+   "index": "# Knowledge Wiki ...\n_0 pages | Generated 2026-11-07T17:20:13.525Z_",
+   "moc": "# Map of Content",
 ❯ test/compile-request-stack-derived-env.test.ts:140:42
    140|     expect(await derivedSet(ambientEnv)).toEqual(ambientBefore);
                                                            ^
 Test Files  1 failed (1)
      Tests  3 failed | 1 passed (4)
````

The received side is the defect stated as data: a compile whose request named Stack A left BOTH renders in the AMBIENT Stack B. The other two failures were the same cause seen from the request side (`:154` for the `skipMoc` case, and `:180` "expected undefined to be defined" — A had received nothing), and the fourth test — the omitted-env preserve case — PASSED before the fix, which is what makes it a preserve case rather than a second RED. The refusal test was then strengthened (both tenants given a real render before the refusal, so the comparison is not of two empties), which is why the committed file's line numbers are `:140`, `:154`, `:182`.

**GREEN.** The same command on the fixed tree: `Test Files 1 passed (1)`, `Tests 4 passed (4)`.

**Four inverse-edit probes, each on a DIFFERENT line, each failing a DIFFERENT assertion.** Restoration was proven by comparison, not by trust: `git diff -- src test` was hashed before the probes and re-captured after the last restore, and `diff -u` between the two is EMPTY under sha256 `a43b24e8c05dd442f90b8e579a8930607e7afacfe35378a431471359150f9894`. No `git checkout --`, `git restore` or `git stash` was ever run.

- **Probe A — `src/compiler/indexgen.ts` destination back to `process.env`:** `Tests 3 failed | 1 passed`. The ambient assertion failed at `:140` with B receiving the index, `:182` with A receiving nothing (`expected undefined to be defined`), and the omitted-env preserve case still passed.
- **Probe B — `src/compiler/obsidian.ts` destination back to `process.env`:** `Tests 1 failed | 3 passed`, failing at `:140` with the ambient diff `{ index: undefined, moc: … }` — the MOC half alone, which is the discrimination that shows the two renderers are separately observable. The `skipMoc` case still passed, correctly, because it writes no MOC.
- **Probe C — the forwarding inside `regenerateIndices` (`generateIndex(root, env, source)` → `process.env`):** `Tests 3 failed | 1 passed`, including the `skipMoc` case at `:156` (`stored.index` must contain "Alpha"), so the index-only path bites on its own — that is S4's "cover `index` even when MOC is skipped".
- **Probe D — the reconcile evidence (`src/commands/query-save.ts:56`, `regenerateIndices(root, env, …)` → `process.env`):** only the reconciled journal test failed, at `:125`, with `index` undefined, while that file's other two tests passed. A reconciled test that failed here is a test that still measures the routing; one that passed either way would have been indistinguishable from a test bent to compile. Restored to `git diff -- src/commands/query-save.ts` = 0 lines.

**T6 reconcile argument — `test/dimensions/regenerate-indices.test.ts`.** It now asserts that a Stack in `env` puts the artifact CONTENT in that Stack's row and leaves no file, while the no-Stack path keeps writing the file fallback. That is the intended behaviour because the split is documented at the seam (`withDerivedSource` stores for a Stack, yields `undefined` for a file project) and the artifact is DERIVED — its destination is the tenant that asked for the render, never the ambient one. The old version asserted `wiki/index.md` while `env` named a Stack, which passed only because the destination ignored `env`: the test encoded the bug, so it was reconciled with the documented split rather than re-pointed at whatever the code now produces, and both halves are asserted (content AND file-absence) because content alone also passes for a run that wrote both places, and absence alone for a run that wrote nothing.

**Second collateral reconcile — `test/mcp/journal-isolation.test.ts`.** The one changed test ("rebuilds the index from the Stack it names when the answer is saved") now asserts the named Stack's stored `index` row contains "Journal Page", does NOT contain "Ambient Page", and that `wiki/index.md` does not exist. That is the documented behaviour for the same reason as above — a Stack resolves the artifact destination to its own row and the file fallback belongs to the no-Stack path — and the failure itself is the evidence that the test had encoded the dropped tenant env: it read the file precisely because the save path's `regenerateIndices(root, env, { skipMoc: true })` argument was previously ignored. The tenant distinction the test is named for is preserved by the "Ambient Page" negative, and the file-absence assertion is what stops the file backend covering for a lost or misrouted row.

**The eight gates, in order, on the final tree (code and tests final; only this `.md` was written afterwards, touching no code or test).**

1. `npx tsc --noEmit` — exit 0, no diagnostics.
2. `npx tsc -p packages/llmwiki-kg/ts/tsconfig.json --noEmit` — exit 0, no diagnostics.
3. `npm run typecheck:tests` — exit 0 — `Test type-check: 1755 files checked; 260 baseline diagnostics in 94 files; no regression.` Baseline NOT regenerated; no update was demanded.
4. `npm run typecheck:kg` — exit 0 — `KG package type-check: 349 files checked; 0 diagnostics baselined across 0 entries in packages/llmwiki-kg/ts/tsconfig.json; no regression.`
5. `npm run build` — exit 0 — `ESM dist/cli.js 502.15 KB`, `DTS ⚡️ Build success in 4900ms`, `DTS dist/index.d.ts 6.67 KB`.
6. `npm run test:affected` — exit 0 — `Test Files 823 passed | 3 skipped (826)`, `Tests 6221 passed | 4 skipped (6225)`. The FIRST run of this gate on the pre-reconcile tree failed with `Test Files 1 failed | 822 passed | 3 skipped (826)` / `Tests 1 failed | 6220 passed | 4 skipped (6225)`, the single failure being `test/mcp/journal-isolation.test.ts:116`; that failure is what L5's second widening answered.
7. `npm test` — exit 0 — `Test Files 908 passed | 3 skipped (911)`, `Tests 6755 passed | 7 skipped (6762)`, 329.13s. An EARLIER `npm test` was run to bound the blast radius before asking for the seventh file; it reported `Test Files 1 failed | 907 passed | 3 skipped (911)` / `Tests 1 failed | 6754 passed | 7 skipped (6762)`, again the same single test. That earlier run is additional evidence only and is explicitly NOT gate 7.
8. `./node_modules/.bin/fallow` — exit 0 — `Metrics: dead files 0.0% (0 of 1475) · dead exports 0.0% (0 of 3104) · MI 91.1 (good)`, `✓ No issues found`, 17 duplicate clone groups / 356 lines (0.2%) reported as informational, and `✗ 0 above threshold · 17423 analyzed · maintainability 91.1 (good)`. `./node_modules/.bin/fallow fix --dry-run` — exit 0 — `Dry run complete. No files were modified.`, so nothing auto-fixable existed and neither `fallow fix --yes` nor a manual fix applied. Nothing fallow reported was inside this branch's edit surfaces, so no fix was made anywhere.

**Gate 8's blind spot, stated rather than glossed.** `.fallowrc.json` lists `packages/llmwiki-kg/**` under `ignorePatterns`, so a clean fallow result is NOT coverage of that package. Gates 2 and 4 are what cover it, and both were run.

**Diff size.** 14 modified files (115 insertions, 36 deletions) plus one new 190-line test file — roughly 341 authored lines excluding this document, under the ~400 threshold, so one work unit was correct and no split was needed.

L7 — refutation of the "one indivisible change" claim, recorded only (`odd/tasks/all-tools-without-stackId.md` was NOT edited).

That file's L16 states that `src/compiler/index.ts:1191` (`regenerateIndices(root, process.env)`) together with the writers at `src/compiler/indexgen.ts:63` and `src/compiler/obsidian.ts:128` "must be fixed as ONE indivisible change". Measurement now shows a SEQUENCE of individually testable seams, not one indivisible thing: (1) the destination in `indexgen.ts`, (2) the destination in `obsidian.ts`, (3) the forwarding inside `regenerateIndices`, (4) the pass-through at the compile boundary via `FinalizeFlags`, (5) the pass-through in `refreshAfterImport`. Probes A, B, C and D above each reverted exactly ONE line and each failed a DIFFERENT assertion — which is the measurement a claim of indivisibility cannot survive: an indivisible change has no line whose revert is independently observable.

What that entry gets RIGHT, and is kept: threading line `:1191` alone is a no-op, because the renderers would keep resolving `process.env` — so the sequence still has to land in ONE commit, and it did. "Not piecewise measurable" and "not separately landable" are different claims, and only the second one is true. The same entry's other clause — "`src/utils/lock.ts` takes no env" — is also stale: it has taken an env since the preceding fix (`src/utils/lock.ts:210`), which is exactly the class of stale-record failure `odd/tasks/stack-scoped-compile-lock.md` S9 exists to prevent. Recorded here so the next session reads a measurement rather than the old belief.
