/**
 * @file test/mcp/stack-id-guard-isolation.test.ts
 * @description The stack-id guard suite must connect to a database THIS process minted.
 *
 * ## What this pins, and why it is a separate file
 *
 * `test/mcp/stack-id-guard.test.ts` is a database-backed suite: it inserts a row into
 * `public.stacks` and then asserts that the row is found. Nothing in that file used to
 * choose WHICH database received the row, so it wrote into whatever the worker's
 * `AKS_DATABASE_URL` named — the run's shared database, or a developer's long-lived
 * server on `:5434`. A suite whose state lives in shared storage can pass because of
 * what another file left behind, and can damage what another file needs.
 *
 * The rule this file states is about the ENVIRONMENT the suite runs in, not about the
 * helper that produces it, so it survives a rewrite of the provisioning mechanism: after
 * the suite's redirect, `AKS_DATABASE_URL` names a `llmwiki_suite_*` database minted by
 * this very process, and never the production port or the shared test server.
 *
 * ## Why it imports the suite it measures
 *
 * The redirect happens in that suite's MODULE SCOPE, because its connection string is
 * read while the module graph loads. A probe that called the provisioning helper itself
 * would prove the helper works and say nothing about the suite; a probe in another
 * process would see a different `process.env` entirely (vitest runs each file in its
 * own worker). Importing the suite is therefore the only way to observe the value the
 * suite's own `createDimensionsDatabase(process.env)` will read.
 *
 * The visible cost of that import is that the guard's own cases are collected here as
 * well, so they run once in their own file and once in this one. That is accepted on
 * purpose: it means the guard's assertions also have to hold against a database this
 * process owns, which is the state this file exists to guarantee.
 *
 * ## Why the assertions read the environment
 *
 * Reading the environment is reading the public interface the production code reads.
 * Querying a database, or importing a provisioning module's caches, would prove the
 * mechanism and could drift from what the suite actually does. The assertions themselves
 * are shared with `test/lint-honours-request-env-isolation.test.ts`, which states the same
 * rule about a different suite; this file keeps only what is specific to ITS subject.
 */
import { describe, it } from "vitest";
import { expectOwnedSuiteDatabase } from "../fixtures/suite-database-ownership.js";
// Imported for its module-scope side effect: it redirects `AKS_DATABASE_URL` at the
// database this process mints. See the header for why the suite itself is the subject.
import "./stack-id-guard.test.js";

describe("stack-id guard database ownership", () => {
  it("hands the suite a database this process minted, not a shared server", () => {
    // The rule itself lives in one place, shared with the lint request-env probe, so the two
    // cannot end up proving different things about the same fixture.
    expectOwnedSuiteDatabase();
  });
});
