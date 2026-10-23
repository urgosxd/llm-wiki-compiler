# pre-push-affected-only — stop duplicating CI's full suite on every push

## Goal

The full suite belongs in CI. Locally, the pre-push hook should run the tests
that the pushed change can actually affect, and leave the exhaustive pass to the
gate that already runs it.

## Evidence this is duplication

- `.github/workflows/ci.yml` runs `npm run build` and `npm test` on **both**
  `push` (to main) and `pull_request`. That is the real gate.
- `.husky/pre-push` runs `npm run build` and `npm test` — the same two commands.
- The hook landed in `6769058` (2026-04-22, "Add husky pre-commit and pre-push
  hooks (#17)"). The CI workflow at that very commit already contained
  `npm test` (verified with `git show 6769058:.github/workflows/ci.yml`), so the
  duplication was there from the start rather than being a later regression.
- Cost: ~9 minutes per push, on every push, to re-run a check that the push
  itself triggers in CI seconds later.

## Non-goals

- CI is **not** changed: it keeps `npm test` over every file and stays the
  ground truth.
- No test is disabled or weakened. The hook still blocks a push that breaks an
  affected test; it stops paying for tests the change cannot reach.
- `npm test` remains available and documented for anyone who wants the full run
  locally.

## Design

`scripts/test-affected.ts` resolves what changed and runs `vitest related` over
it:

1. Resolve the canonical base (`upstream/main` when a fork remote exists, else
   `origin/main`), matching `scripts/fallow-ci.sh`.
2. `git merge-base` → diff `base...HEAD` plus any working-tree changes.
3. If the change touches something that can affect the whole suite
   (`package.json`, `vitest.config.ts`, `tsconfig*.json`, or `scripts/`), run the
   full `test:unit` tier instead of a scoped run. A config change genuinely can
   reach everything, and pretending otherwise would make the hook a false
   negative.
4. Otherwise run `vitest related` over the changed source and test files.

`vitest related` only selects files that import the changed module, so it may
still pull in integration tests when the changed code is used there — that is
correct, not a loophole. The hook avoids *irrelevant* work, never *relevant* work.

## Acceptance criteria

1. `.husky/pre-push` no longer runs the unbounded `npm test`.
2. Pushing a change to one leaf module runs a scoped selection, not all 1313
   files.
3. Pushing a `package.json` / vitest config / `scripts/` change falls back to the
   full unit tier.
4. Pushing with nothing changed since the merge-base reports that clearly and
   runs nothing heavy.
5. CI still runs the full suite (verified by reading the workflow, unchanged).

## Tasks

- [x] T1 Write `odd/tasks/pre-push-affected-only.md` (this document).
- [x] T2 Add `scripts/test-affected.ts` (pure resolver) and
      `scripts/run-affected-tests.ts` (the one impure step: spawns vitest).
- [x] T3 Wire `test:affected` and the pre-push hook.
- [x] T4 Tests for the change-scope resolution (18 tests).
- [x] T5 Update CONTRIBUTING to state where each gate lives.
- [x] T6 Verify: `tsc`, `typecheck:tests`, `fallow`; `.github/workflows/ci.yml`
      untouched (still runs `npm test` on push and PR).

## Bugs the tests caught during implementation

1. **`readRoot(argv.slice(2))` double-offset.** After extracting `readRoot`, the
   caller sliced twice and the partitioner returned 0 files for every tier.
2. **`./cli-root.js` does not resolve under Node's native TS execution.** Node
   runs `.ts` directly but does not remap a `.js` specifier to a `.ts` file, so
   the scripts crashed with `ERR_MODULE_NOT_FOUND`. Fixed with an explicit `.ts`
   specifier (allowed by `allowImportingTsExtensions`).
3. **`git diff` cannot see untracked files.** A brand-new source or test file is
   untracked until staged, so `git diff --name-only HEAD` reported nothing and the
   hook would have pushed a new test file untested. `git ls-files --others
   --exclude-standard` was added, and a regression test now covers it.

## Verified behaviours

Tested against a synthetic repo with `origin/main` set:

| Situation | Decision |
|---|---|
| One changed source file | `files` — that file only |
| A new untracked file under `scripts/` | `global` — full unit tier |
| Nothing changed since base | `none` — nothing runs |
| Changed `package.json` | `global` — full unit tier |

## Evidence

- `test/test-affected-scope.test.ts` — 18 tests passing.
- Checks: `tsc --noEmit` clean, `typecheck:tests` no regression (177 baseline),
  `fallow` 0 dead code / 0 duplication / 0 above threshold.
- Shared `scripts/cli-root.ts` extracted after fallow flagged two duplicate
  `readRoot` clones; the unused `GLOBAL_SCOPE_*` / `resolveBaseRef` exports were
  made module-private after fallow flagged them as dead exports.
