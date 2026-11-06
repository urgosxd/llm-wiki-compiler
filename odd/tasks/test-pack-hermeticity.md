# test-pack-hermeticity

Feature: pin `npm run test:pack` file selection by construction so a sibling checkout cannot change what runs.
Branch: main. Status: open — S1-S7 delegated to the implementation worker, no commit yet.

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
- [x] T1 preflight + feature document (this file). S1-S7. worker. base `c78586fc605a5554144955b45ea902b7341fdffc`; document carried by the closing slice
- [x] T2 dedicated packaging config + `test:pack` script wiring. S1, S3. worker. this commit
- [x] T3 RED/GREEN probe: old command shape collects the mimic, new config selects one file, probe removed. S1. worker. this commit
- [x] T4 S2 preservation on the fixed command: four assertions execute (duration class + no stray `.tgz`). S2. worker. this commit
- [x] T5 `npm ci` under Node 24 + the seven gates in order. S4, S5. worker. this commit
- [x] T6 conventional commit with the proof in the message. S7. worker. this commit

## Log

### L1 — original request (verbatim)
THE ROOT CAUSE, not just the symptom: `package.json:56` runs `vitest run --config /dev/null test/sdk/packaging.test.ts`. With `/dev/null` as the config, vitest falls back to its defaults, and the positional argument is a **substring filter**, not an exact path — so any sibling checkout containing that path string gets collected. Adding `--exclude '**/.worktrees/**'` treats one instance; it does not fix the class. Prefer the structural fix: give this gate its own tiny config that pins `include` to exactly `test/sdk/packaging.test.ts` and excludes `.worktrees/`, so the command selects one file by construction and adding a sibling checkout cannot change what runs.

### L2 — prove the property (verbatim)
Whichever shape you choose, prove the property: create a throwaway directory that mimics a second copy (a path containing `test/sdk/packaging.test.ts` with an intentionally failing body) and show `npm run test:pack` still selects exactly one file and stays green. Remove the probe afterwards.

### L3 — keep the behaviour the gate exists for (verbatim)
Keep the behaviour the gate exists for: all four assertions must still execute — `npm pack`, install from tarballs, the `createWiki` import probe, and `.d.ts` under `tsc --noEmit --strict`.
