/**
 * @file test/fixtures/hatch-worker-env-probe.test.ts
 * @description Report, from INSIDE a spawned worker, what the database handoff left behind.
 *
 * ## Why a probe file, and not an assertion in the suite under test
 *
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is a statement about the RUN, and the only place it can be
 * observed is a WORKER's own environment. `vitest.config.ts` seeds `AKS_DATABASE_URL` into every
 * worker statically (`test.env`), and the setup file that reads the per-run handoff record
 * (`test/setup/test-database-url.ts`) runs after that seed. A test asserting the invariant from the
 * parent process would be inspecting the wrong process: the parent's worker is not the child's.
 *
 * So this file is spawned by `test/hatch-means-no-database.test.ts`, prints what it sees in terms a
 * failure message can quote, and asserts the same thing. It prints PRESENCE, never a value: a
 * connection string in a test log is a credential in a test log.
 *
 * ## Why it skips when nobody asked for a probe
 *
 * The normal suite collects this file too, and an ordinary run has no invariant to check here: its
 * worker legitimately holds a database URL. `LLMWIKI_TEST_HATCH_PROBE` is what the spawning test
 * installs, and without it this file reports one skip and asserts nothing, so it can never turn a
 * full run red for a condition only a spawned hatch run creates.
 */
import { describe, expect, it } from "vitest";
import {
  AKS_DATABASE_URL_ENV_VAR,
  isDatabaseConfigured,
} from "../../packages/wiki/src/dimensions/activation.js";

/** Names the expectation the spawning test installed; absent in an ordinary run. */
const EXPECTATION_ENV_VAR = "LLMWIKI_TEST_HATCH_PROBE";

/** The expectation for a run that declared it has no database at all. */
const EXPECT_NO_DATABASE = "no-database";

/** The expectation for a run that did NOT take the hatch. */
const EXPECT_DATABASE = "database";

/** What this worker holds, phrased so a failure message can quote it without quoting a URL. */
interface Observed {
  /** `present` when the variable carries anything, `absent` when it is undefined. */
  readonly url: string;
  /** {@link isDatabaseConfigured}'s answer, as the string the log line prints. */
  readonly configured: string;
}

/** Read this worker's environment, without exposing the value it carries. */
function observed(): Observed {
  return {
    url: process.env[AKS_DATABASE_URL_ENV_VAR] === undefined ? "absent" : "present",
    configured: String(isDatabaseConfigured(process.env)),
  };
}

/** What the spawning test asked this worker to prove. */
const expectation = process.env[EXPECTATION_ENV_VAR]?.trim() ?? "";

describe("the database handoff, as this worker sees it", () => {
  it.skipIf(expectation === "")("reports its environment", () => {
    expect([EXPECT_NO_DATABASE, EXPECT_DATABASE]).toContain(expectation);
    console.log(
      `[hatch-probe] ${AKS_DATABASE_URL_ENV_VAR}=${observed().url} ` +
        `isDatabaseConfigured=${observed().configured}`,
    );
    if (expectation === EXPECT_NO_DATABASE) {
      // The hatch means "this run has no database", so no worker may hold one.
      expect(observed().url, "a run that declared no database must hold no database URL").toBe(
        "absent",
      );
      expect(observed().configured).toBe("false");
      return;
    }
    // A run that did NOT take the hatch keeps the seeding it always had.
    expect(observed().url).toBe("present");
    expect(observed().configured).toBe("true");
  });
});
