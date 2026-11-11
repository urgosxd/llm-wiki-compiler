import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "./test/fixtures/test-database.js";

const TEST_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 60_000;

/**
 * Database every test worker sees, resolved once by the safe fixture resolver.
 *
 * WHY THE WORKER ENV AND NOT EACH SUITE. Production code reads
 * `AKS_DATABASE_URL` and treats a MISSING value as "use the vendored default",
 * which is `localhost:5432` — the PRODUCTION port. Ten suites call
 * `createDimensionsDatabase(process.env)` directly, so on a machine with nothing
 * on 5432 they failed with `ECONNREFUSED` and read like product bugs, and on a
 * machine where production IS reachable they would have run their assertions
 * against operator data. Neither is acceptable and neither is fixable one suite
 * at a time without leaving the next suite free to reintroduce it.
 *
 * Seeding the worker environment closes it for every suite at once: no consumer
 * can inherit the production port by omission. A suite that specifically needs
 * the unconfigured case still deletes the variable itself, which the degrade and
 * backend-selection tests already do.
 */
const TEST_DATABASE_ENV = {
  AKS_DATABASE_URL: testDatabaseUrl(),
} as const;

export default defineConfig({
  // In-repository tests exercise source. Packed consumers still import the
  // installed compiler peer by name; this resolver is not shipped at runtime.
  resolve: {
    alias: [
      { find: /^llm-wiki-compiler$/, replacement: fileURLToPath(new URL("./packages/wiki/src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    globals: true,
    // Runs inside EVERY worker before any test module loads, and publishes the database the global
    // setup resolved into `LLMWIKI_TEST_DATABASE_URL` + `AKS_DATABASE_URL`. It cannot be the `env:`
    // object below: that one is static and re-applied per worker, which would clobber the
    // dynamically resolved URL (see test/fixtures/testcontainers-postgres.ts).
    setupFiles: ["./test/setup/test-database-url.ts"],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    // CAP SIZED BY MEASURED PEAK RSS, NOT BY CORE COUNT. Many integration tests
    // spawn a CLI subprocess, so one worker per core oversubscribes the machine
    // ~2x and subprocess spawns get starved past their timeout — a
    // non-deterministic failure whose victim varies per run. Core count is the
    // wrong input for that; peak RSS is the right one. Measured on this host
    // (16 cores, 13805 MB RAM, 4 GB swap already 3.4-3.7 GB consumed by
    // unrelated resident processes), one full-suite run per configuration,
    // sequential and alone, peak RSS of the whole run's process tree from the
    // scope's cgroup `memory.peak` (descendants included):
    //   2 workers: 809 s, 2808 MB peak (1404 MB/worker), 0 swap out
    //   4 workers: 496 s, 3816 MB peak ( 954 MB/worker), ~1 MB swap out
    //   6 workers: 403 s, 5119 MB peak ( 853 MB/worker), ~400 MB swap out,
    //              worst MemAvailable 2576 MB
    // Six workers buys 93 s and costs the host: it pushes ~400 MB into swap and
    // pulls MemAvailable down to 2576 MB while other sessions are resident,
    // which is how concurrent verification runs start killing each other. These
    // absolute figures are INDICATIVE of this shared host, not its capacity.
    //
    // WHY 4 AND NOT THE UNIT TIER'S OPTIMUM: the number is sized from the worst
    // case `pnpm test` can actually meet. `test` runs BOTH tiers unfiltered in
    // one process pool, so the per-worker cost that binds the cap is the
    // integration tier's — those files spawn `node dist/api.js` children
    // (measured max single-child RSS 442 MB, taken on the then-current CLI
    // launcher; the subprocess shape is unchanged), and the unit tier therefore
    // deliberately runs below its own optimum here. Nobody should raise this
    // number without the integration tier's per-worker peak in hand.
    maxWorkers: 4,
    minWorkers: 1,
    // Seed, do not default: see TEST_DATABASE_ENV for why omission is the bug.
    // The per-run fixture overrides this per process; without the seed an un-provisioned suite would reach production's 5432.
    env: { ...TEST_DATABASE_ENV },
    // Don't pick up tests from sibling worktrees living under local worktree dirs.
    // Worktrees share the parent's working directory tree, so without this
    // exclude vitest discovers and runs every feature branch's tests.
    exclude: [
      ...configDefaults.exclude,
      ".claude/**",
      ".worktrees/**",
      "test/sdk/packaging.test.ts",
    ],
    // Build dist/ once globally so parallel test workers don't race on
    // tsup's clean+write cycle (multiple beforeAll(npx tsup) calls were
    // wiping dist/api.js mid-test).
    globalSetup: "./test/global-setup.ts",
  },
});
