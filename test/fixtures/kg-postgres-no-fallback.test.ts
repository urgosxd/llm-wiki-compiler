/**
 * @file test/fixtures/kg-postgres-no-fallback.test.ts
 * @description Pin that a failed per-run provision can never hand a suite the SHARED database.
 *
 * ## The defect this file exists to keep dead
 *
 * `test/fixtures/kg-postgres.ts` provisions this process's private database at IMPORT time, and
 * when that call rejected it warned and kept going with `testDatabaseUrl()` — the run's shared
 * server. A suite whose provision failed therefore ran its assertions against state it did not own
 * and reported green, which is how a database-backed suite passes while asserting nothing.
 *
 * Where the hoisted call sits is not the defect; degrading to shared state is. So the rule pinned
 * here is about the VALUE the fixture hands out, not about how or when it obtains one: after a
 * failed provision, no exported URL may name the shared server.
 *
 * ## Why the provisioner is mocked rather than a real outage induced
 *
 * Stopping a container would test Docker, not this rule, and it would leave the failure path
 * unreached whenever a developer's server happens to be up. The mock makes `perRunDatabase()`
 * reject deterministically, so the assertions describe the fixture's own decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuiteDatabase } from "./per-run-database.js";
import { DEFAULT_TEST_DATABASE_URL, testDatabaseUrl } from "./test-database.js";

/** Everything the mock needs, hoisted so the `vi.mock` factory can reach it. */
const mock = vi.hoisted(() => {
  /** The database a SUCCESSFUL provision hands back; no real server listens on it. */
  const url = "postgresql://suite@127.0.0.1:5999/llmwiki_suite_no_fallback";
  return {
    /** The failure the mocked provisioner raises, reused so an assertion can name it. */
    failure: "per-run provision refused: no server answered",
    url,
    /** What the mocked provisioner does the next time the fixture is imported. */
    failing: true,
    suite: { label: "no-fallback", name: "llmwiki_suite_no_fallback", url, drop: async () => undefined },
  };
});

vi.mock("./per-run-database.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./per-run-database.js")>();
  const perRunDatabase = async (): Promise<SuiteDatabase> => {
    if (mock.failing) throw new Error(mock.failure);
    return mock.suite;
  };
  return { ...actual, perRunDatabase };
});

// Top-level hooks, so each `describe` below stays a readable list of rules.
beforeEach(() => {
  vi.resetModules();
  mock.failing = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("kg-postgres after a failed per-run provision", () => {
  it("refuses to load, naming the failure it observed", async () => {
    await expect(import("./kg-postgres.js")).rejects.toThrow(
      new RegExp(`needs a Postgres database and none could be obtained[\\s\\S]*${mock.failure}`),
    );
  });

  it("hands out no URL naming the shared database when the opt-out allows a skip", async () => {
    vi.stubEnv("LLMWIKI_TEST_ALLOW_NO_DATABASE", "1");
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { DATABASE_URL } = await import("./kg-postgres.js");
    expect(warns.mock.calls.flat().join("\n")).toContain(mock.failure);
    expect(DATABASE_URL).not.toBe(testDatabaseUrl());
    expect(DATABASE_URL).not.toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("reports a harness as unreachable instead of probing the shared database", async () => {
    vi.stubEnv("LLMWIKI_TEST_ALLOW_NO_DATABASE", "1");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createKgPostgresHarness } = await import("./kg-postgres.js");
    const harness = await createKgPostgresHarness("no-fallback");
    try {
      expect(harness.url).not.toBe(testDatabaseUrl());
      expect(harness.reachable).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("still points a suite at the database a successful provision minted", async () => {
    mock.failing = false;
    const { DATABASE_URL } = await import("./kg-postgres.js");
    expect(DATABASE_URL).toBe(mock.url);
  });
});
