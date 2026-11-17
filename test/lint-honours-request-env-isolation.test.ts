/**
 * @file test/lint-honours-request-env-isolation.test.ts
 * @description The lint request-env suite must connect to a database THIS process minted.
 *
 * ## What this pins, and why it is a separate file
 *
 * `test/lint-honours-request-env.test.ts` looks like a pure unit suite and is not one: it
 * drives the real `lint`/`lintByTier` entry points, and those reach Postgres through
 * `packages/wiki/src/linter/cache.ts` (`createDimensionsDatabase(env)` at `:172`, and
 * `createDimensionsDatabase()` — no argument, so it reads `AKS_DATABASE_URL` straight from
 * `process.env` — at `:191`). Nothing in that file chose WHICH database carried those rows,
 * so it read the run's shared database, or a developer's long-lived server. Measured before
 * the fix: pointed at an unreachable DSN the suite fails with `connect ECONNREFUSED`, which
 * is the proof that the connection is real and that its target was inherited, not owned.
 *
 * A suite whose state lives in shared storage can pass because of what another file left
 * behind. The rule stated here is about the ENVIRONMENT the suite runs in, not about the
 * helper that produces it, so it survives a rewrite of the provisioning mechanism: after the
 * suite's redirect, `AKS_DATABASE_URL` names a `llmwiki_suite_*` database minted by this very
 * process, and never the production port or the shared test server.
 *
 * ## Why it imports the suite it measures
 *
 * The redirect happens in that suite's MODULE SCOPE, because its connection string is read
 * while the module graph loads. A probe that called the provisioning helper itself would
 * prove the helper works and say nothing about the suite; a probe in another process would
 * see a different `process.env` entirely (vitest runs each file in its own worker). Importing
 * the suite is therefore the only way to observe the value that suite's own lint run reads.
 *
 * The visible cost of that import is that the suite's two cases are collected here as well,
 * so they run once in their own file and once in this one. That is accepted on purpose: it
 * means those assertions also have to hold against a database this process owns, which is the
 * state this file exists to guarantee.
 *
 * ## Why the assertions read the environment
 *
 * Reading the environment is reading the public interface the production code reads.
 * Querying a database, or importing a provisioning module's caches, would prove the
 * mechanism and could drift from what the suite actually does. The assertions themselves
 * are shared with `test/mcp/stack-id-guard-isolation.test.ts`, which states the same rule
 * about a different suite; this file keeps only what is specific to ITS subject.
 */
import { describe, it } from "vitest";
import { expectOwnedSuiteDatabase } from "./fixtures/suite-database-ownership.js";
// Imported for its module-scope side effect: it redirects `AKS_DATABASE_URL` at the
// database this process mints. See the header for why the suite itself is the subject.
import "./lint-honours-request-env.test.js";

describe("lint request-env suite database ownership", () => {
  it("hands the suite a database this process minted, not a shared server", () => {
    // The rule itself lives in one place, shared with the stack-id guard probe, so the two
    // cannot end up proving different things about the same fixture.
    expectOwnedSuiteDatabase();
  });
});
