# test-pack-hermeticity

Feature: pin `npm run test:pack` file selection by construction so a sibling checkout cannot change what runs.
Branch: main. Status: complete — S1-S7 implemented and committed in `9e3902ff`, the probe lesson documented in `ec11f3e`, independently verified green.

## Specs

### S1 — exactly one file, whatever siblings exist
"`npm run test:pack` must select exactly ONE test file — `test/sdk/packaging.test.ts` — and stay green even when a sibling directory containing a matching path (e.g. `.worktrees/orchestrator-a`) exists in the checkout."

### S2 — the four assertions the gate exists for still execute
"`npm pack` succeeds, install from the produced tarballs into a throwaway fixture, the `createWiki` import probe runs against the installed package, and the installed `.d.ts` files compile under `tsc --noEmit --strict`."

### S3 — structural fix, not an instance patch
"Adding `--exclude '**/.worktrees/**'` treats one instance; it does not fix the class. Prefer the structural fix: give this gate its own tiny config that pins `include` to exactly `test/sdk/packaging.test.ts` and excludes `.worktrees/`, so the command selects one file by construction and adding a sibling checkout cannot change what runs."
Concretely: the gate's file selection must be pinned by construction (a dedicated config whose `include` is exactly that one path, with an explicit `root`), so the positional-argument substring filter that caused the defect no longer participates in selection.

### S4 — Node 24 install, then the full gate list at the tip plus the fix
"After the fix, `npm ci` runs under Node 24 so install and execution match CI, then the full gate list is re-run at the tip plus the fix: `npx tsc --noEmit`, `npm run typecheck:kg`, `npm run build`, `npm test`, `npm run test:pack`, `./node_modules/.bin/fallow`, `npm run test:affected`. Real exit codes, counts, durations, every skip named."

### S5 — first-attempt honesty for `npm test`
"`npm test` is reported honestly on its FIRST attempt; if an isolated `HOME` breaks the codex live test, say so and label the re-run as a re-run."

### S6 — `.worktrees/` is report-only
"That is an orphaned checkout and it needs a human decision, not an agent's cleanup. Report it only. Do not prune, do not delete, do not repair."

### S7 — one conventional commit, no push
"One conventional commit carrying the proof in its message; no push; vulnerabilities untouched."

## Tasks
- [x] T1 preflight + feature document (this file). S1-S7. worker. base `c78586fc605a5554144955b45ea902b7341fdffc`; the document was committed together with the fix, in `9e3902ff`
- [x] T2 dedicated packaging config + `test:pack` script wiring. S1, S3. worker. `9e3902ff`
- [x] T3 RED/GREEN probe: old command shape collects the mimic, new config selects one file, probe removed. S1. worker. `9e3902ff`
- [x] T4 S2 preservation on the fixed command: four assertions execute (duration class + no stray `.tgz`). S2. worker. `9e3902ff`
- [x] T5 `npm ci` under Node 24 + the seven gates in order. S4, S5. worker. `9e3902ff`
- [x] T6 conventional commit with the proof in the message. S7. worker. `9e3902ff`
- [x] T7 lesson documentation: the in-checkout probe lesson in `## Lessons`, attributed to the manager. L4. worker. `ec11f3e`
- [x] T8 final document update: the task commit evidence above plus L5 (independent verification). This row's own commit SHA is reported in the implementation handoff instead of being self-referenced here, because a commit cannot contain its own hash. L5. worker. SHA reported in the implementation handoff

## Log

### L1 — original request (verbatim)
THE ROOT CAUSE, not just the symptom: `package.json:56` runs `vitest run --config /dev/null test/sdk/packaging.test.ts`. With `/dev/null` as the config, vitest falls back to its defaults, and the positional argument is a **substring filter**, not an exact path — so any sibling checkout containing that path string gets collected. Adding `--exclude '**/.worktrees/**'` treats one instance; it does not fix the class. Prefer the structural fix: give this gate its own tiny config that pins `include` to exactly `test/sdk/packaging.test.ts` and excludes `.worktrees/`, so the command selects one file by construction and adding a sibling checkout cannot change what runs.

*Note on the line number quoted in L1:* the `test:pack` script was at `package.json:41`, not `package.json:56` — that is where it sits at base `c78586fc` and still at HEAD. The quote above is preserved verbatim because a log entry records what was said, not what is true; this note is the correction, and L1 itself is not rewritten.

### L2 — prove the property (verbatim)
Whichever shape you choose, prove the property: create a throwaway directory that mimics a second copy (a path containing `test/sdk/packaging.test.ts` with an intentionally failing body) and show `npm run test:pack` still selects exactly one file and stays green. Remove the probe afterwards.

### L3 — keep the behaviour the gate exists for (verbatim)
Keep the behaviour the gate exists for: all four assertions must still execute — `npm pack`, install from tarballs, the `createWiki` import probe, and `.d.ts` under `tsc --noEmit --strict`.

### L4 — lesson added after the fix commit
After the fix landed as commit `9e3902ff573621a7274d44b31964623e2e914a7f`, the manager instructed that the probe-placement mistake be written down as a lesson for future maintainers. That lesson lives in `## Lessons` below and is attributed to the manager there. This documentation change is committed after the fix commit it describes; its own SHA is reported in the implementation handoff rather than self-referenced here, because a commit cannot contain its own hash.

### L5 — independent verification (recorded)

The change was verified by a read-only verifier that did not implement it: `gentle-ai-verify`, session-scoped, with no write access. Its method and results, recorded here as evidence:

- **Inspection, not re-implementation.** Both commits were read by SHA — `9e3902ff573621a7274d44b31964623e2e914a7f` (the fix) and `ec11f3e3fe0e27aec908d0b836562776fc7ac1e8` (this documentation) — and the selection property was re-proved independently of the implementer's run.
- **Re-proof of the selection property, with no probe file created.** The pre-existing `.worktrees/orchestrator-a` and `.worktrees/orchestrator-b` checkouts were used as adversarial input, standing in for the throwaway mimic: the old command shape (`vitest list`) enumerated 3 files, while the pinned config enumerated exactly 1. The property therefore holds against real sibling checkouts, not only against a synthetic probe, and no new file had to be created inside the checkout to demonstrate it.
- **Gate results, independent of the implementer's run.** `npm run test:pack` EXIT=0 with `1 passed (1)` in 26.88s (the full body ran, not an early death); `npx tsc --noEmit` EXIT=0; `npm run typecheck:kg` EXIT=0 (232 files, 0 diagnostics); `./node_modules/.bin/fallow` EXIT=0 (`0 above threshold · 15957 analyzed · maintainability 91.1`).
- **What was NOT re-measured, stated plainly.** The full `npm test` was not re-run by the verifier. The 294.12s / `803 passed | 3 skipped (806)` / `6096 passed | 7 skipped` figure therefore stands as the implementer's own measurement, corroborated only on the changed gate (`test:pack`) and on the static gates above — not on the full suite.

### L6 — the pin test, on a branch (recorded)

**Preflight, and the branch BEFORE the first edit.** `git status --porcelain` empty, `git rev-parse HEAD` = `e0477437c0145bf8510fe44cab3d11d5ccce8d0d` on `main`. Branch `test/pack-selection-pin` was created from that SHA before any file was touched; all work and both commits live on it, and local `main` still points at `e0477437c0145bf8510fe44cab3d11d5ccce8d0d` afterwards. The three commits described in the lesson below — `9e3902ff`, `ec11f3e`, `e047743` — are the ones already on `main`; this slice adds nothing to them.

**Why the pin exists.** After `9e3902ff` the selection property was true by construction, but the only proof of it was manual: run `vitest list` with the old command shape and count 3 files, run it with the pinned config and count 1. A manual proof leaves no failing test behind, so the property survived only as long as nobody re-typed the command. `test/sdk/test-pack-selection.test.ts` (commit `e28c591ea1c2e2a0efa93420f099fe815c39dc86`) turns that proof into three layers: the **config contract** (one literal `include`, explicit `root`, `node_modules` and `.worktrees` excluded, `globalSetup` / `setupFiles` / `env` all `undefined`), the **script contract** (the exact string, and no positional path), and the **observed selection** (`vitest list --config test/sdk/vitest.packaging.config.ts --filesOnly` through `process.execPath` plus `node_modules/vitest/vitest.mjs`, asserting the collected file set is exactly one path, unconditionally). The adversarial sibling path `.worktrees/orchestrator-x/test/sdk/packaging.test.ts` is matched as a pure string against the configured exclude patterns with `picomatch` — the matcher family vitest itself uses, and the one that ships no type declarations, hence the `createRequire` load — so no probe file is created inside the checkout. That is the L4 lesson applied rather than repeated.

**RED, with reversible text edits only.** Setting `test:pack` back to `vitest run --config /dev/null test/sdk/packaging.test.ts` failed the script contract: `AssertionError: expected 'vitest run --config /dev/null test/sd…' not to contain 'test/sdk/packaging.test.ts'`. Relaxing `include` to `test/sdk/*.test.ts` failed the observed selection with `expected [ Array(11) ] to deeply equal [ 'test/sdk/packaging.test.ts' ]`, which proves that layer watches discovery and not only the config literal. Both restorations were verified byte-identical with `git diff --exit-code` (EXIT=0), never with a discard command: this repository has already stranded one run on the data-loss consent prompt a `rm -rf` raised (L4), so no `git checkout --`, `git restore`, `git reset --hard`, `git stash`, `git clean`, `rm` or `rm -rf` was used anywhere in this slice, and no scratch file was created inside the checkout.

**Gates** (Node v24.21.0, each run unfiltered, exit code read from the command itself with no pipe, logs kept outside the worktree in `/tmp/pack-pin-gates-KQmAQu`):

- `npx vitest run test/sdk/test-pack-selection.test.ts` — EXIT=0, `Test Files 1 passed (1)` / `Tests 9 passed (9)`, 1.02s.
- `npx tsc --noEmit` — EXIT=0.
- `npm run build` — EXIT=0 (`dist/cli.js` 469.73 KB, `dist/index.d.ts` 6.67 KB).
- `npm run test:pack` — EXIT=0, `Test Files 1 passed (1)` / `Tests 1 passed (1)`, 31.06s. The pin test is NOT collected there: `vitest list` through that config still lists exactly `test/sdk/packaging.test.ts`.
- `npm test` — EXIT=0, `Test Files 804 passed | 3 skipped (807)`, `Tests 6105 passed | 7 skipped (6112)`, 283.50s. The new file IS collected here: `✓ test/sdk/test-pack-selection.test.ts (9 tests) 506ms`.
- `npm run test:affected` — EXIT=0, `Test Files 721 passed | 3 skipped (724)`, `Tests 5587 passed | 4 skipped (5591)`, 195.68s.
- `./node_modules/.bin/fallow` — EXIT=0, `✗ 0 above threshold · 15976 analyzed · maintainability 91.1 (good)`.

**Skips, named with their reasons, none introduced or changed by this slice.** `packages/llmwiki-kg/ts/src/routes/aks-gateway.test.ts` (1 skipped), `ingest-gateway.test.ts` (1) and `pages-gateway.test.ts` (2) are gated by `describe.skipIf(state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1")` — the block "spends money" against a real LLM provider and is enabled only with `AKS_TEST_GATEWAY=1`. The three skipped tests in `test/quickstart-integration.test.ts` (full run only; that file is not in the affected selection) are `it.skip` under the in-file note "RETIRED, not skipped pending work: these three can never be true against this product, on any configuration".

**Out of scope, stated plainly.** `npm run typecheck:tests` was neither run nor modified: it is knowingly red and outside this slice. The documentation commit carrying this entry reports its own SHA in the implementation handoff, because a commit cannot contain its own hash.

## Lessons

### Never create a discovery probe inside the checkout

This is the manager's lesson, and it is recorded as theirs. In their own words:

> "THE FAULT FOR THE PROBE LOCATION IS MINE, and record it as a lesson… A probe whose whole purpose is to look like repo content must never be created inside the checkout… Every such probe belongs in `/tmp` from the first line."

**What happened.** The hermeticity mimic was created at `.hermeticity-probe/test/sdk/packaging.test.ts`, inside the repository root. The main `vitest.config.ts` excludes exactly one packaging path, `test/sdk/packaging.test.ts`, at line 73 — and that exclusion does not match a mimic nested under `.hermeticity-probe/`. So `npm test` would have collected the mimic and failed on its intentional `throw`. That is a fake red: the failure would have come from the probe rather than from the code under test, and every gate reported after it would have been unreadable, so the entire gate run would have been invalidated.

**The worse failure came at cleanup.** `rm -rf .hermeticity-probe` raised a data-loss consent prompt, and the run stranded there. No automated recovery was possible — only a human could clear it — so a routine cleanup step took the whole run hostage.

**The rule, stated precisely.** A `.test.ts` anywhere inside the checkout is indistinguishable from real test content to every tree-walking tool. Vitest, `tsc`, the linters, `fallow`, and whatever walks the tree next will treat it as repository content, because that is exactly what it is. Scratch probes belong OUTSIDE the repo by default — `/tmp` or another directory made with `mktemp -d` — and are removed in the same chain that created them.

**The one exception, stated honestly.** There is a case where `/tmp` proves nothing, and it is the case this feature cared about. When the probe's entire purpose is to prove what vitest's *discovery* collects, a probe in `/tmp` is invisible: a config rooted at the repository cannot discover a file outside its root, so the experiment becomes a no-op that "passes" for the wrong reason. In that case the probe must (a) live under a gitignored path — confirm the ignore rule covers it before creating the file, not afterwards; (b) be created and removed inside the SAME command chain, so no gate run can start in the window between them; and (c) never coexist with a gate run. Prefer a non-destructive move (`mv` the probe into `/tmp` and back) over a delete where possible, so a consent guard cannot strand the work the way it did here.

**The observable symptom to recognise.** A gate that reports "1 test passed" while actually running files from unrelated sibling checkouts. The cause is the one recorded in L1: a positional vitest argument is a substring filter, not an exact path. When a gate's count looks right but the files it ran are wrong, the gate is not pinning selection — it is matching text.

### "Work in the primary checkout" is not "work on main"

This is the manager's lesson, and it is recorded as theirs. In their own words:

> "an assignment that touches the primary checkout for one operation must say explicitly that edits and commits go on a branch. 'Work in the primary checkout' is not 'work on main'."

**What happened.** The `test:pack` fix (`9e3902ff`) and its two documentation commits (`ec11f3e`, `e047743`) landed directly on local `main` in the primary checkout. The assignment named where the work lives and never re-scoped where the edit and the commit should live. "The primary checkout" is a statement about the FILESYSTEM; it was read as a statement about the branch, which it never was. Working directory and branch are two independent decisions, and naming one does not imply the other.

**The harm was zero, and that was luck, not method.** Nothing was pushed, so no shared history moved and nobody else's branch needed repair. Local `main` was deliberately NOT rewritten: a reset to erase those commits would have restored appearances at the cost of a real risk — discarding work that is already green, plus the data-loss consent prompt this harness raises on such commands — for a purely cosmetic gain. An unrewritten `main` is a truthful record of what happened; a reset one is only a prettier one.

**The rule.** Any assignment that touches the primary checkout for one operation must state explicitly where the edits and the commits live, and default to a branch. Doing work in a directory and committing a change are separate permissions; the first one granted is never the second one implied.

**The observable symptom.** A commit landing on `main` while the assignment called the location "the primary checkout". If you cannot answer "which branch will this commit land on?" before the first write, the scope is under-specified — and the branch is the wrong thing to discover late.

**The corrected shape, recorded here as evidence.** The slice this lesson accompanies said three separate things and inferred nothing: work in the primary checkout (filesystem), create branch `test/pack-selection-pin` before the first edit (branch), commit both changes there (commit). See L6 for the resulting evidence.
