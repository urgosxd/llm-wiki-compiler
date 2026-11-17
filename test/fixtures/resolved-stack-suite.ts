/**
 * @file test/fixtures/resolved-stack-suite.ts
 * @description The scenario harness shared by the suites that compile against a database
 * which NAMES NO STACK.
 *
 * ## The scenario, and why it is a fixture
 *
 * Two suites pin two different defects — the mutation lock's key (S16) and the
 * environment the downstream seams read (S14) — and both need the SAME premise: a
 * database is configured, NOTHING names a Stack, and the Stack the run works on is the
 * one the resolver the code under test calls answers. That premise is what makes the two
 * answers differ, so it has to be identical in both files rather than merely similar.
 * Written in each file it was identical in behaviour and drifting in prose; `fallow`
 * counted the pair as two clone groups (39 and 29 lines).
 *
 * What this module owns is the plumbing that decides NOTHING about an outcome:
 *
 *  - the per-run database and the ONE repository rule for a run that cannot obtain one
 *    (fail, or skip explicitly under `LLMWIKI_TEST_ALLOW_NO_DATABASE=1`);
 *  - the run's environment builder, {@link ResolvedStackSuite.runEnv} — a database
 *    configured and no Stack named, which is the discriminating property of both files;
 *  - the temp-root tracking and the handle helper, which are bookkeeping;
 *  - the save/restore env hooks, so the `beforeEach` that blanks the Stack id cannot be
 *    remembered by one file and forgotten by the other.
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
 *
 * The id named here is never the run's: `runEnv` DELETES it. The Stack is provisioned by
 * the resolver the code under test calls, exactly as a first-time deployment provisions
 * it, so neither file has to write the id into the environment of the run it measures.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, vi } from "vitest";

import { createDimensionsDatabase } from "../../packages/wiki/src/dimensions/activation.js";
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
  /** The environment the RUN gets: the database configured, no Stack named. */
  readonly runEnv: () => NodeJS.ProcessEnv;
  /** An open handle on this file's per-run database, for the test's own reads. */
  readonly suiteHandle: () => SuiteHandle;
}

/** What the calling suite supplies; both fields are things only that suite knows. */
export interface ResolvedStackSuiteOptions {
  /** The calling suite's own path, so a "no database" failure points at it. */
  readonly context: string;
  /**
   * This suite's own `beforeEach` body, run after the Stack id is blanked.
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
 * Register the calling suite's hooks and hand back its scenario.
 *
 * Called at the CALLING suite's module top level with a top-level `await`, because the
 * per-run database has to exist before any case is collected: without one the suite is
 * registered as skips (under the documented opt-out) or fails here, never registered and
 * then failed.
 *
 * @param options - The suite's own path and its own `beforeEach` body.
 * @returns The skip decision, the temp-root factory, the env builder and the handle.
 */
export async function useResolvedStackSuite(
  options: ResolvedStackSuiteOptions,
): Promise<ResolvedStackSuite> {
  const skipped = await skipReason(options.context);
  const roots: string[] = [];
  let savedEnv: NodeJS.ProcessEnv = {};

  beforeEach(() => {
    savedEnv = { ...process.env };
    // The discriminating property of every case in the calling file: nothing NAMES a
    // Stack. Restored through `savedEnv`, so a sibling suite's value cannot leak in or out.
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
    tempRoot: async (prefix: string) => {
      const root = await makeTempRoot(prefix);
      roots.push(root);
      return root;
    },
    runEnv: (): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.AKS_STACK_ID;
      return env;
    },
    suiteHandle: (): ReturnType<typeof createDimensionsDatabase> =>
      createDimensionsDatabase({ [DATABASE_URL_ENV_VAR]: process.env[DATABASE_URL_ENV_VAR] }),
  };
}
