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
      { find: /^@atomicstrata\/llmwiki-core\/compiler-cli$/, replacement: fileURLToPath(new URL("./src/compiler-cli.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-core\/compiler-sdk$/, replacement: fileURLToPath(new URL("./src/sdk/compiler-composition.ts", import.meta.url)) },
      { find: /^@atomicstrata\/llmwiki-core$/, replacement: fileURLToPath(new URL("./src/core-index.ts", import.meta.url)) },
      { find: /^llm-wiki-compiler$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
      { find: /^llmwiki-kg$/, replacement: fileURLToPath(new URL("./packages/llmwiki-kg/ts/src/core-index.ts", import.meta.url)) },
      { find: /^llmwiki-kg\/server$/, replacement: fileURLToPath(new URL("./packages/llmwiki-kg/ts/src/server.ts", import.meta.url)) },
      ...["llmwiki-dev-backend", "llmwiki-limited-isolation-backend"].map(name => ({
        find: new RegExp("^" + name + "$"),
        replacement: fileURLToPath(new URL("./packages/" + name + "/src/index.ts", import.meta.url)),
      })),
    ],
  },
  test: {
    globals: true,
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
    // Many integration tests spawn a CLI subprocess. With one worker per core
    // each ALSO spawning a node process, the machine is oversubscribed ~2x and
    // subprocess spawns get starved past their timeout — a non-deterministic
    // failure whose victim varies per run. Cap workers to half the cores so
    // each worker+subprocess pair fits, independent of how many subprocess
    // tests exist.
    maxWorkers: "50%",
    minWorkers: 1,
    // Seed, do not default: see TEST_DATABASE_ENV for why omission is the bug.
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
    // wiping dist/cli.js mid-test).
    globalSetup: "./test/global-setup.ts",
  },
});
