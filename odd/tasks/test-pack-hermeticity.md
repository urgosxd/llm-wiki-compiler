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

## Lessons

### Never create a discovery probe inside the checkout

This is the manager's lesson, and it is recorded as theirs. In their own words:

> "THE FAULT FOR THE PROBE LOCATION IS MINE, and record it as a lesson… A probe whose whole purpose is to look like repo content must never be created inside the checkout… Every such probe belongs in `/tmp` from the first line."

**What happened.** The hermeticity mimic was created at `.hermeticity-probe/test/sdk/packaging.test.ts`, inside the repository root. The main `vitest.config.ts` excludes exactly one packaging path, `test/sdk/packaging.test.ts`, at line 73 — and that exclusion does not match a mimic nested under `.hermeticity-probe/`. So `npm test` would have collected the mimic and failed on its intentional `throw`. That is a fake red: the failure would have come from the probe rather than from the code under test, and every gate reported after it would have been unreadable, so the entire gate run would have been invalidated.

**The worse failure came at cleanup.** `rm -rf .hermeticity-probe` raised a data-loss consent prompt, and the run stranded there. No automated recovery was possible — only a human could clear it — so a routine cleanup step took the whole run hostage.

**The rule, stated precisely.** A `.test.ts` anywhere inside the checkout is indistinguishable from real test content to every tree-walking tool. Vitest, `tsc`, the linters, `fallow`, and whatever walks the tree next will treat it as repository content, because that is exactly what it is. Scratch probes belong OUTSIDE the repo by default — `/tmp` or another directory made with `mktemp -d` — and are removed in the same chain that created them.

**The one exception, stated honestly.** There is a case where `/tmp` proves nothing, and it is the case this feature cared about. When the probe's entire purpose is to prove what vitest's *discovery* collects, a probe in `/tmp` is invisible: a config rooted at the repository cannot discover a file outside its root, so the experiment becomes a no-op that "passes" for the wrong reason. In that case the probe must (a) live under a gitignored path — confirm the ignore rule covers it before creating the file, not afterwards; (b) be created and removed inside the SAME command chain, so no gate run can start in the window between them; and (c) never coexist with a gate run. Prefer a non-destructive move (`mv` the probe into `/tmp` and back) over a delete where possible, so a consent guard cannot strand the work the way it did here.

**The observable symptom to recognise.** A gate that reports "1 test passed" while actually running files from unrelated sibling checkouts. The cause is the one recorded in L1: a positional vitest argument is a substring filter, not an exact path. When a gate's count looks right but the files it ran are wrong, the gate is not pinning selection — it is matching text.
