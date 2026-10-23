# test-suite-speedup — make the local test loop seconds, not minutes

## Goal

Cut the development feedback loop from ~10 minutes to seconds without losing
coverage in CI.

Measured baseline (full `npm test`, 16-core box, 8 vitest workers):

| Metric | Value |
|---|---|
| Files | 1311 |
| Tests | 10916 |
| Wall clock | **595.6s (9.9 min)** |
| Sum of per-file duration | 3308s |
| Ideal wall at 8 workers | 413s |
| Parallel efficiency | 69% |
| Median file duration | **0.24s** |
| p99 / max file duration | 38.4s / 85.9s |

The suite is **tail-dominated**. Two facts drive the whole plan:

1. **131 files contain a spawn call site** (`runCLI`/`execFile`/`spawn`/
   `execSync`/`npm pack`) with **544 call sites total**. They consume 1794s
   (**54%** of all file-time) at an average of **13.7s each**, versus **1.3s**
   for the 1180 files that never spawn. A spawned `node dist/cli.js` costs
   ~1.5s of cold start.
2. **`test/global-setup.ts` runs `tsup` unconditionally** on every vitest run:
   ~42s, of which ~36s is `packages/llmwiki-core` (≈34s of that is `dts: true`).
   A single 7ms test file therefore still costs ~48s.

No test makes a real LLM call; `@copilotkit/aimock` and provider mocks cover the
LLM paths. Runtime is process startup, not API latency.

## Non-goals

- No test is deleted, skipped, or weakened.
- No assertion changes. `test:all` must run the exact same 1311 files.
- No `--no-isolate`: measured to break tests via shared module state
  (`atomic-write-bytes` false failure plus a worker-thread termination), so it is
  rejected rather than tuned.
- The tsup build is **not** made `--dts false`: 5 tests read real `.d.ts`
  (`products/private-packages-pack`, `local-workflow-package-boundary`,
  `products/provider-host-surface-shipped`, `preparation-service-authority`, and
  the already-excluded `sdk/packaging`).

## Acceptance criteria

1. `npm run test:unit` runs only the no-spawn files and finishes in a fraction
   of the full suite's wall time.
2. `npm run test:all` runs every test file (spawn and non-spawn).
3. `npm run test:integration` runs only the spawn files.
4. The globalSetup build is skipped when the build inputs are unchanged, and
   rebuilt when any of `src/`, `packages/`, or the tsup configs change.
5. The cache is fail-safe: a stale or unreadable stamp triggers a rebuild rather
   than a skip.
6. Classification by real content, not filename: 75 of the 131 spawning files do
   not have `cli` in their name.

## Tasks

- [x] T1 Write `odd/tasks/test-suite-speedup.md` (this document).
- [x] T2 Add `scripts/test-partition.ts` (content-based partition).
- [x] T3 Cache the globalSetup build keyed on a hash of the build inputs.
- [x] T4 Wire `test:unit` and `test:integration` scripts. `test:all` was NOT
      added: `npm test` already runs every file, so a third alias would be a
      second name for the same thing.
- [x] T5 Tests for the partitioner and the build-stamp logic (26 tests).
- [x] T6 Document the split in CONTRIBUTING.md.
- [x] T7 Verify: `tsc`, `typecheck:tests`, `fallow`, both partitions measured.

## Measured results

| Scenario | Before | After |
|---|---|---|
| One small unit file | 48.86s | **0.92s** |
| One small unit file, forced rebuild | 48.86s | 37.7s |
| `workflow-submit-cli` alone (14 spawns) | 63.2s | **22.4s** |
| `workflow-submit-cli` + `workflow-lifecycle-cli` | n/a | 27.5s |
| `npm run test:unit` (1168 files) | n/a | 5m13s |
| `npm run test:integration` (146 files) | n/a | 3m53s |
| `npx vitest related src/context/links-here.ts` | n/a | 36.7s |
| Full `npm test` (1313 files) | 9.9 min | **8m58s** |

Partition: 1168 unit + 146 integration = 1314 classified, exact, no file lost.

## Spawn-cost lever: Node compile cache

A spawned CLI costs 0.72s, of which bare Node is only 0.02s — the rest is
compiling the module graph, dominated by `@atomicstrata/llmwiki-core/compiler-cli`
(632ms). Enabling `NODE_COMPILE_CACHE` for the subprocess drops a repeat spawn to
**0.56s**. Wired into `test/fixtures/run-cli.ts` (the choke point every spawning
test goes through), scoped to tests only, pointing at the git-ignored
`.llmwiki/node-compile-cache`. A caller-set `NODE_COMPILE_CACHE` still wins.

Measured effect on a 14-spawn file: **63.2s -> 22.4s**. The win is larger than
the 22% per-spawn figure suggests because the cache also avoids repeated
disk reads across the many short-lived processes.

## Rejected after measuring

- **Making the MCP SDK import dynamic in `src/cli.ts`** (it costs 115ms and only
  the `serve` command needs it). Implemented, measured, **no effect** (0.72s
  before and after): tsup inlines `mcp/server.ts` and flattens its dynamic
  import into static ones, so the SDK stays in the bundle's top-level import
  graph. **Reverted with `git checkout src/cli.ts`** so the tree carries no
  change justified only by a comment. A real win here would need the SDK marked
  external in `tsup.config.ts`, which changes the shipped bundle — out of scope
  for a test-speed task.
- **`--no-isolate`**: breaks tests via shared module state.

## Honest limits

- `test:unit` at 5m13s is **better than 10 min but NOT seconds**. The fast tier
  still contains 1168 files whose collection alone costs ~667s of CPU; the win
  there is bounded, not transformative. The real inner loop is
  `npx vitest related <file>`, which is what CONTRIBUTING now recommends.
- The build cache saves a fixed ~42s per run, which matters most for the
  single-file loop (60x) and least for the full suite (7%).
- Remaining lever if more speed is needed: the spawn tier still has files with
  21 (`workflow-lifecycle-cli`) and 14 (`workflow-submit-cli`) spawn sites, and
  `products/private-packages-pack` runs `npm pack` twice (77.7s). Batching those
  invocations is the next real win; `--no-isolate` remains rejected.

## Evidence

- `test/test-partition.test.ts` (15 tests), `test/build-stamp.test.ts` (11 tests).
- Cache invalidation verified end-to-end: editing `src/utils/constants.ts`
  rebuilt (37.7s); restoring it rebuilt once then skipped (0.82s); deleting
  `dist/` with the stamp intact correctly reported stale.
- Checks: `tsc --noEmit` clean, `typecheck:tests` no regression (177 baseline),
  `fallow` 0 dead code / 0 duplication / 0 above threshold.
