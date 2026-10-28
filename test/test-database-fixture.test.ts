/**
 * @file test/test-database-fixture.test.ts
 * @description Pins the one property that made this fixture necessary: a test run can
 * never resolve to the production database.
 *
 * ## Why this suite exists
 *
 * Seven fixtures resolved their connection string with
 * `process.env.LLMWIKI_TEST_DATABASE_URL ?? ""`. That expression looks like "no
 * database", and it is not: `activation.ts` reads `AKS_DATABASE_URL` and treats empty
 * as unset, falling back to the vendored default
 * `postgresql://aks:aks@localhost:5432/aks` -- the PRODUCTION port.
 *
 * On a machine with nothing on 5432 this surfaced as `ECONNREFUSED 127.0.0.1:5432` and
 * 64 phantom test failures. On a machine where production WAS reachable the suites
 * would have connected and asserted against operator data instead. Only the loud case
 * was ever observed, so the quiet one is what these cases guard.
 *
 * Each case below is a property of the resolver, checked WITHOUT a database: this suite
 * must pass on any machine, including one with no Postgres at all.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEST_DATABASE_URL,
  TEST_DATABASE_URL_ENV_VAR,
  testDatabaseUrl,
} from "./fixtures/test-database.js";

/** The vendored production default this fixture must never reproduce. */
const PRODUCTION_PORT = ":5432";

describe("the test database resolver", () => {
  it("answers a usable default when nothing is configured", () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
    // The specific shape that caused the trap: an empty string is NOT "no database".
    expect(testDatabaseUrl({})).not.toBe("");
  });

  it("treats an EMPTY override as absent rather than propagating it", () => {
    // This is the exact bug. Assigning "" into an environment a test builds makes the
    // production code fall back to the production port.
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_ENV_VAR]: "" })).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_ENV_VAR]: "   " })).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("never resolves to the production port", () => {
    expect(testDatabaseUrl({})).not.toContain(PRODUCTION_PORT);
    expect(DEFAULT_TEST_DATABASE_URL).not.toContain(PRODUCTION_PORT);
  });

  it("still honours an explicit override, so CI can point elsewhere", () => {
    const override = "postgresql://user:pass@db.example.test:6000/other";
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_ENV_VAR]: override })).toBe(override);
  });
});
