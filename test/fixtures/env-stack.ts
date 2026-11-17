/**
 * @file test/fixtures/env-stack.ts
 * @description Provision a real Stack for one suite and point the environment at
 * it, so in-process ingest suites run against a database instead of failing.
 *
 * ## Why this exists at all
 *
 * `resolveDimensions` reads `AKS_STACK_ID` from the environment
 * (`src/dimensions/activation.ts:222`) and `writeToDimensions` builds its handle
 * with `createDimensionsDatabase()` called with NO argument
 * (`src/services/ingest/service.ts:117`) -- so `process.env` is the only
 * environment that path ever sees. `ingestSource`, `ingestTextSource` and the SDK
 * facade take no options object, so there is no seam to inject an env through.
 * Setting the variables is therefore not a shortcut; it is the only available
 * route short of changing three production signatures.
 *
 * ## Why a Stack PER FILE and never one shared Stack
 *
 * `ingestText` derives source identity as `manual:<sha256(title, text)>`
 * (`service.ts:183-188`), which is stable across runs. Against a persistent
 * Stack the SECOND run finds the page already present, reports `unchanged`, and
 * `journalIngest` is skipped because it is gated on
 * `writeStatus !== "unchanged"` (`:153`, `:200`). A suite asserting on the
 * journal line then fails -- green on a fresh volume, red forever after. A fresh
 * Stack per file, with a fresh `stackId` from the harness, is what defeats that.
 *
 * ## Why `process.env` is safe here despite being global
 *
 * Measured, not assumed: vitest runs each test FILE in its own process (pool
 * `forks`, verified with a probe where one file set a variable and another saw it
 * undefined). There is no cross-file contamination to guard against, so writing
 * `process.env` and restoring it is correct at file scope.
 *
 * ## Why one cleanup and not two hooks
 *
 * `afterAll` hooks run in REVERSE registration order (measured), and the harness
 * deletes the stack row BEFORE closing the pool (`kg-postgres.ts:70-79`). If the
 * env restore lived in its own earlier hook while a write was still in flight,
 * the row delete would race it. So both steps happen inside one `cleanup()`:
 * restore the environment, then tear down the harness. One ordering, no split.
 *
 * ## Why {@link createStackEnvBinding} and its control tests live here
 *
 * A second family of suites does not provision a Stack of its own: it already holds a
 * harness and only needs to POINT the two seams at it for the length of one call, then
 * put the environment back. `test/dimensions/graph-backend-wired.test.ts` and
 * `test/dimensions/markers-wired.test.ts` each carried their own copy of that
 * snapshot/apply/restore trio, and their copies of the two CONTROL tests that pin the
 * restore semantics — 54 duplicate lines of the helper and 48 of the tests — because
 * nothing shared owned the concern. The rule they pin is not about those two suites:
 * an absent `AKS_DATABASE_URL` is not "no database" to production code, it is the
 * vendored default on the PRODUCTION port, so every suite that installs the pair has to
 * restore rather than delete. One implementation, and one set of control tests, is the
 * only way that rule stays true for both.
 *
 * The control tests are registered by {@link describeRestoredStackEnv} rather than
 * exported as a case list because a `describe` block cannot be shared any other way
 * without the caller restating it. They install the binding of the CALLING file, which is
 * what makes them a test of that file's wiring and not of this module.
 */

import { describe, expect, it } from "vitest";

import { DATABASE_URL, createKgPostgresHarness } from "./kg-postgres.js";
import { testDatabaseUrl } from "./test-database.js";

/** Environment variable naming the Stack the dimensions write to. */
const STACK_ID_ENV_VAR = "AKS_STACK_ID";

/** Environment variable selecting which dimensions ingest writes. */
const DIMENSIONS_ENV_VAR = "LLMWIKI_DIMENSIONS";

/**
 * Environment variable carrying the connection string the dimension layer uses.
 *
 * Load-bearing and easy to miss: `createDimensionsDatabase` reads
 * `AKS_DATABASE_URL` and falls back to the vendored `config.ts` default, which is
 * `postgresql://aks:aks@localhost:5432/aks` -- the PRODUCTION port. The harness
 * points at 5434. Without this variable the Stack is provisioned correctly and
 * then never reached: the suite fails with `ECONNREFUSED 127.0.0.1:5432`, which
 * reads like a missing database rather than a missing variable.
 */
const DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/** The dimension set these suites exercise: the wiki, backed by Postgres. */
const WIKI_ONLY = "wiki";

/** What a suite holds for the duration of its file. */
export interface EnvStack {
  /** The provisioned Stack's id, already exported into the environment. */
  readonly stackId: string;
  /** True only when the database was reachable and the Stack really exists. */
  readonly reachable: boolean;
  /** Restore the environment, then tear the harness down. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Restore one variable to a snapshot, deleting it when it was previously unset.
 *
 * Writing back the string `"undefined"` would be its own bug: it is truthy, so
 * `activation` would treat it as a Stack id and fail somewhere far from here.
 *
 * Exported because this is the ONE wording of the restore-not-delete rule, and every suite
 * that rewrites this pair has to obey it: an absent `AKS_DATABASE_URL` is not "no database"
 * to production code, it is the vendored default on the PRODUCTION port.
 *
 * @param name - Variable name.
 * @param previous - Its value before the suite started, or `undefined`.
 */
export function restoreVariable(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

/**
 * Provision one Stack and export it for the current test file.
 *
 * Call this at file top level (not inside a hook) so a suite can use the id
 * before any test runs, and register a single `afterAll(() => env.cleanup())`.
 *
 * @param name - Short label recorded as the Stack name, for debuggability.
 * @returns The Stack id, its reachability, and the cleanup to register.
 */
export async function provisionEnvStack(name: string): Promise<EnvStack> {
  const previousStackId = process.env[STACK_ID_ENV_VAR];
  const previousDimensions = process.env[DIMENSIONS_ENV_VAR];
  const previousDatabaseUrl = process.env[DATABASE_URL_ENV_VAR];
  const harness = await createKgPostgresHarness(name);

  process.env[STACK_ID_ENV_VAR] = harness.stackId;
  process.env[DIMENSIONS_ENV_VAR] = WIKI_ONLY;
  process.env[DATABASE_URL_ENV_VAR] = DATABASE_URL;

  return {
    stackId: harness.stackId,
    reachable: harness.reachable,
    cleanup: async () => {
      // Environment first: nothing in the harness teardown needs these variables,
      // and restoring early keeps a failing teardown from leaving a stale Stack id
      // visible to whatever runs next in this process.
      restoreVariable(STACK_ID_ENV_VAR, previousStackId);
      restoreVariable(DIMENSIONS_ENV_VAR, previousDimensions);
      restoreVariable(DATABASE_URL_ENV_VAR, previousDatabaseUrl);
      await harness.cleanup();
    },
  };
}

/** What a suite holds while the seams it exercises are pointed at its own Stack. */
export interface StackEnvBinding {
  /**
   * Snapshot both variables, then point them at `stackId` and this run's database.
   *
   * @param stackId - The Stack the seams should read for the rest of this call.
   */
  apply(stackId: string): void;
  /** Put the snapshot back. A no-op when {@link StackEnvBinding.apply} has not run. */
  clear(): void;
}

/**
 * Build the snapshot/apply/restore pair, held in this binding and nowhere else.
 *
 * Idempotent in both directions: `clear()` before any `apply()` does nothing, and a second
 * `clear()` after a successful one does nothing either. `apply()` re-snapshots, so a suite
 * that applies without clearing between two calls restores to the first call's state — which
 * is why every caller clears in the same scope it applies in.
 *
 * @returns The binding; one per test file, created at module scope beside the harness.
 */
export function createStackEnvBinding(): StackEnvBinding {
  let previous: { stackId: string | undefined; databaseUrl: string | undefined } | undefined;
  return {
    apply(stackId: string): void {
      previous = {
        stackId: process.env[STACK_ID_ENV_VAR],
        databaseUrl: process.env[DATABASE_URL_ENV_VAR],
      };
      process.env[STACK_ID_ENV_VAR] = stackId;
      process.env[DATABASE_URL_ENV_VAR] = testDatabaseUrl();
    },
    clear(): void {
      if (previous === undefined) return;
      restoreVariable(STACK_ID_ENV_VAR, previous.stackId);
      restoreVariable(DATABASE_URL_ENV_VAR, previous.databaseUrl);
      previous = undefined;
    },
  };
}

/**
 * Values standing in for what the suite setup published into this worker before any module
 * loaded.
 *
 * The URL is deliberately NOT the vendored default: the defect this guards leaves the variable
 * ABSENT after cleanup, and absent is exactly what makes production code reach port 5432.
 */
const AMBIENT_STACK_ID = "sentinel-stack-731";
const AMBIENT_DATABASE_URL = "postgresql://aks:aks@127.0.0.1:5999/aks_per_run_sentinel";

/**
 * The Stack id the control tests install.
 *
 * Fixed rather than taken from the caller's harness: the tests assert the RESTORE, so the value
 * installed only has to be distinguishable from {@link AMBIENT_STACK_ID} — and taking it from the
 * harness would make the control tests depend on a `beforeEach` they exist to outlive.
 */
const INSTALLED_STACK_ID = "probe-stack-731";

/**
 * Register the two control tests that pin `binding`'s restore semantics.
 *
 * Call at file top level, once, with the same binding the file's own tests use.
 *
 * @param binding - The binding under test.
 */
export function describeRestoredStackEnv(binding: StackEnvBinding): void {
  describe("the Stack environment this file installs", () => {
    it("restores the variables it overwrote instead of deleting them", () => {
      withAmbientStackEnv(() => {
        binding.apply(INSTALLED_STACK_ID);
        binding.clear();

        expect(process.env[STACK_ID_ENV_VAR]).toBe(AMBIENT_STACK_ID);
        expect(process.env[DATABASE_URL_ENV_VAR]).toBe(AMBIENT_DATABASE_URL);
      });
    });

    it("leaves a genuinely absent variable absent, never an empty string", () => {
      withAbsentStackEnv(() => {
        binding.apply(INSTALLED_STACK_ID);
        binding.clear();

        expect(process.env[STACK_ID_ENV_VAR]).toBeUndefined();
        expect(process.env[DATABASE_URL_ENV_VAR]).toBeUndefined();
        expect(process.env[DATABASE_URL_ENV_VAR]).not.toBe("");
      });
    });
  });
}

/**
 * Run `body` with both variables holding the ambient sentinels, then put the originals back.
 *
 * @param body - The test body.
 */
function withAmbientStackEnv(body: () => void): void {
  const previousStackId = process.env[STACK_ID_ENV_VAR];
  const previousDatabaseUrl = process.env[DATABASE_URL_ENV_VAR];
  process.env[STACK_ID_ENV_VAR] = AMBIENT_STACK_ID;
  process.env[DATABASE_URL_ENV_VAR] = AMBIENT_DATABASE_URL;
  try {
    body();
  } finally {
    restoreVariable(STACK_ID_ENV_VAR, previousStackId);
    restoreVariable(DATABASE_URL_ENV_VAR, previousDatabaseUrl);
  }
}

/**
 * Run `body` with both variables genuinely unset, then put the originals back.
 *
 * @param body - The test body.
 */
function withAbsentStackEnv(body: () => void): void {
  const previousStackId = process.env[STACK_ID_ENV_VAR];
  const previousDatabaseUrl = process.env[DATABASE_URL_ENV_VAR];
  delete process.env[STACK_ID_ENV_VAR];
  delete process.env[DATABASE_URL_ENV_VAR];
  try {
    body();
  } finally {
    restoreVariable(STACK_ID_ENV_VAR, previousStackId);
    restoreVariable(DATABASE_URL_ENV_VAR, previousDatabaseUrl);
  }
}
