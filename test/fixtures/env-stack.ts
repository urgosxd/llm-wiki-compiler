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
 */

import { DATABASE_URL, createKgPostgresHarness } from "./kg-postgres.js";

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
 * @param name - Variable name.
 * @param previous - Its value before the suite started, or `undefined`.
 */
function restoreVariable(name: string, previous: string | undefined): void {
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
