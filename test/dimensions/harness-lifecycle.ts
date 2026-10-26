/**
 * @file test/dimensions/harness-lifecycle.ts
 * @description The shared probe-stack lifecycle every row-store suite repeats.
 *
 * Each suite that exercises a wiki table needs the same four lines: create a
 * provisioned Stack, remember its id, tear it down, and never leak it into the next
 * file. Written three times it drifts — one suite forgets to randomise the prefix, or
 * to clean up on a test that threw — and the drift shows up as an unrelated suite
 * failing later.
 *
 * Kept in `test/` rather than `test/fixtures/` because it is suite scaffolding, not a
 * fixture: it owns the harness LIFECYCLE rather than any data.
 */

import { randomUUID } from "node:crypto";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** A provisioned Stack plus the teardown that removes it. */
export interface ProbeStack {
  readonly harness: KgPostgresHarness;
  /** Environment naming THIS Stack, for seams that resolve from the environment. */
  env(): NodeJS.ProcessEnv;
}

/**
 * Create a Stack whose name is unique to the calling suite.
 *
 * The label is prefixed with a random suffix because fixture domains are matched by
 * PREFIX when they are cleaned up: two suites sharing a label would delete each
 * other's rows.
 *
 * @param label - Short suite name, used only to make a failure readable.
 * @returns The provisioned Stack.
 */
export async function createProbeStack(label: string): Promise<ProbeStack> {
  const harness = await createKgPostgresHarness(`${label}-${randomUUID().slice(0, 8)}`);
  return {
    harness,
    env: () => ({
      AKS_STACK_ID: harness.stackId,
      AKS_DATABASE_URL: process.env.LLMWIKI_TEST_DATABASE_URL ?? "",
    }) as NodeJS.ProcessEnv,
  };
}
