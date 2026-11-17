/**
 * @file test/fixtures/resolved-stack-suite.ts
 * @description The scenario harness shared by the suites that compile against a database
 * and ONE Stack they created for themselves.
 *
 * ## The scenario, and why it is a fixture
 *
 * Two suites pin two different defects — the mutation lock's key (S16) and the
 * environment the downstream seams read (S14) — and both need the SAME premise: a
 * database is configured, ONE Stack is named, and every seam of the run works on that one
 * Stack. That premise is what makes the two answers differ, so it has to be identical in
 * both files rather than merely similar. Written in each file it was identical in
 * behaviour and drifting in prose; `fallow` counted the pair as two clone groups (39 and
 * 29 lines).
 *
 * What this module owns is the plumbing that decides NOTHING about an outcome:
 *
 *  - the per-run database and the ONE repository rule for a run that cannot obtain one
 *    (fail, or skip explicitly under `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`);
 *  - the Stack the suite works on, created EXPLICITLY here and named by
 *    {@link ResolvedStackSuite.runEnv} — see below;
 *  - the temp-root tracking and the handle helper, which are bookkeeping;
 *  - the save/restore env hooks, so the `beforeEach` that names the Stack id cannot be
 *    remembered by one file and forgotten by the other.
 *
 * ## Why the suite creates its own Stack
 *
 * It used to name NO Stack and let the resolver under test MATERIALIZE a default one: the
 * provisioning was the premise, so the id the run worked on was whatever the code under
 * test happened to create. S1 of `odd/tasks/stack-authority-per-request.md` deletes that —
 * no Stack is created implicitly, anywhere — so the premise is now the one a deployment
 * actually has: a Stack exists because its owner created it, and the run names it. Sharing
 * the created row through this fixture is what keeps the four suites that need it from
 * each hand-copying the insert, which is the duplication this module exists to prevent.
 *
 * ## What is deliberately NOT here
 *
 * No assertion, and no mode. Every `expect` stays in the case that owns it: a helper that
 * absorbed an assertion would be a helper whose subject the reader has to go and find,
 * and the two files assert different things about different defects. File mode stays a
 * declaration each file makes BY NAME (`usePerCaseFileMode`, `withFileMode`), because a
 * mode folded into a fixture is a mode decided implicitly — the drift both suites exist
 * to end. A suite's contenders (another host's env, a holder's lock, a source document)
 * stay with the suite that contends.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, vi } from "vitest";

import { createDimensionsDatabase, isDatabaseConfigured } from "../../packages/wiki/src/dimensions/activation.js";
import { perRunDatabase } from "./per-run-database.js";
import { makeTempRoot } from "./temp-root.js";
import { missingTestDatabase } from "./test-database-handoff.js";

/** Variable the dimension layer reads its DSN from when it is given no argument. */
const DATABASE_URL_ENV_VAR = "AKS_DATABASE_URL";

/**
 * An open handle on a per-run database, as a suite reads its own rows through it.
 *
 * Exported as a TYPE so a suite can name the handle it holds without importing the
 * database constructor the fixture owns — the fixture is the one place that decides which
 * database a suite reads.
 */
export type SuiteHandle = ReturnType<typeof createDimensionsDatabase>;

/** What a suite gets back: the skip decision and the per-run plumbing. */
export interface ResolvedStackSuite {
  /** `""` when this run has a usable database; otherwise the reason every case skips. */
  readonly skipped: string;
  /** A throwaway project root owned by the current test, removed after it. */
  readonly tempRoot: (prefix: string) => Promise<string>;
  /** The environment the RUN gets: the database configured, and THIS suite's Stack named. */
  readonly runEnv: () => NodeJS.ProcessEnv;
  /** An open handle on this file's per-run database, for the test's own reads. */
  readonly suiteHandle: () => SuiteHandle;
  /** The Stack this suite created for itself and names in {@link runEnv}. */
  readonly stackId: string;
}

/** What the calling suite supplies; both fields are things only that suite knows. */
export interface ResolvedStackSuiteOptions {
  /** The calling suite's own path, so a "no database" failure points at it. */
  readonly context: string;
  /**
   * This suite's own `beforeEach` body, run after the Stack id is named.
   *
   * A callback rather than a hook the caller registers, so one file cannot run its setup
   * with a Stack id still in the environment while the other one does not.
   */
  readonly beforeEach?: () => void;
}

/**
 * This file's per-run database, or the reason every case below can only skip.
 *
 * The repository's rule for a database-backed suite: FAIL when none can be obtained,
 * because a skip is reported as a pass while asserting nothing. Only
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` reaches the skip, and it still prints the reason.
 *
 * The DSN is left published into the environment — never captured and never returned —
 * so the run under test reads it from the environment the way a deployment does, and no
 * suite has to hold a connection string.
 *
 * @param context - The calling suite's path, for the failure.
 * @returns `""` when the database is usable, otherwise the reason the skip reports.
 */
async function skipReason(context: string): Promise<string> {
  const absent = await perRunDatabase().then(
    () => undefined,
    (error: unknown) => missingTestDatabase(context, String(error)),
  );
  if (absent === undefined) return "";
  if (absent.error !== undefined) throw absent.error;
  console.warn(absent.message);
  return absent.message;
}

/**
 * Create the Stack this suite works on, in the per-run database.
 *
 * An insert and nothing else — the row `POST /stacks` writes, minus the transport —
 * because the point of S1 is that a Stack exists only because someone created it. The
 * domain carries a random suffix so two suites sharing one per-run database cannot collide
 * on `stacks.domain`, which is unique.
 *
 * @returns The id of the row it created.
 */
async function createSuiteStack(): Promise<string> {
  const id = randomUUID();
  const domain = `resolved-stack-${randomUUID().slice(0, 8)}`;
  const handle = createDimensionsDatabase({ [DATABASE_URL_ENV_VAR]: process.env[DATABASE_URL_ENV_VAR] });
  try {
    await handle.db.execute(
      `insert into stacks (id, name, domain) values ('${id}', '${domain}', '${domain}')`,
    );
  } finally {
    await handle.close();
  }
  return id;
}

/**
 * Register the calling suite's hooks and hand back its scenario.
 *
 * Called at the CALLING suite's module top level with a top-level `await`, because the
 * per-run database has to exist before any case is collected: without one the suite is
 * registered as skips (under the documented opt-out) or fails here, never registered and
 * then failed.
 *
 * @param options - The suite's own path and its own `beforeEach` body.
 * @returns The skip decision, the temp-root factory, the env builder, the handle and the Stack.
 */
export async function useResolvedStackSuite(
  options: ResolvedStackSuiteOptions,
): Promise<ResolvedStackSuite> {
  const skipped = await skipReason(options.context);
  // Created BEFORE any case runs, so the id is known synchronously at every call site.
  const stackId = skipped === "" ? await createSuiteStack() : "";
  const roots: string[] = [];
  let savedEnv: NodeJS.ProcessEnv = {};

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Nothing NAMES a Stack in the process environment: a file-mode case must keep the
    // file mode's premise intact, and the Stack is named by `runEnv` for the runs that
    // have a database to key it on. Restored through `savedEnv`, so a sibling suite's value
    // cannot leak in or out.
    delete process.env.AKS_STACK_ID;
    options.beforeEach?.();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = savedEnv;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  return {
    skipped,
    stackId,
    tempRoot: async (prefix: string) => {
      const root = await makeTempRoot(prefix);
      roots.push(root);
      return root;
    },
    runEnv: (): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      // THIS suite's Stack, by name — but ONLY where the run has a database to key it on.
      // Inside `withFileMode` the database is blank, and a Stack id beside it is a
      // contradiction the config read takes literally: it would look this Stack's config
      // up in a database it cannot reach. The file mode's premise is no Stack, so it gets
      // none.
      if (isDatabaseConfigured(env)) env.AKS_STACK_ID = stackId;
      else delete env.AKS_STACK_ID;
      return env;
    },
    suiteHandle: (): ReturnType<typeof createDimensionsDatabase> =>
      createDimensionsDatabase({ [DATABASE_URL_ENV_VAR]: process.env[DATABASE_URL_ENV_VAR] }),
  };
}
