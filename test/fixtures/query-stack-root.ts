/**
 * @file test/fixtures/query-stack-root.ts
 * @description The lifecycle both `query_wiki` suites repeat: a provisioned Stack,
 * a root with NO `wiki/` tree, and the process bound to that Stack.
 *
 * ## Why the root has no `wiki/` directory
 *
 * Both suites exist to prove that pages are read from Postgres. A root that also
 * held `wiki/concepts/*.md` would let a silent fallback to disk pass, because the
 * same page would be found either way. An empty root makes the disk path useless,
 * which is what turns "the answer came back" into evidence.
 *
 * ## Why the environment is still bound while a test runs
 *
 * The query tools take `stackId` as a REQUIRED argument, so none of them resolves a
 * default from here: a call that omits it is refused by the schema before a handler
 * runs. What the environment still has to carry is the database the rows come from
 * (`AKS_DATABASE_URL`) and the single-Stack shape a deployment presents
 * (`AKS_STACK_ID`, which such a deployment exports and each request then names).
 * Binding both for the duration of a test is exercising that deployment shape, not
 * working around the argument; the teardown restores the environment so no later
 * suite inherits a tenant.
 */

import { afterEach, beforeEach } from "vitest";
import { rm } from "node:fs/promises";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "./host-scratch.js";
import { testDatabaseUrl } from "./test-database.js";

/** What a query suite needs: the Stack, its root, and its teardown. */
export interface QueryStackFixture {
  /** The provisioned Stack; check `harness.reachable` before asserting. */
  readonly stack: ProbeStack;
  /** Project root with no `wiki/` tree, so pages can only come from rows. */
  readonly root: string;
  /** Environment the tools read: this Stack and this database. */
  env(): NodeJS.ProcessEnv;
}

/**
 * Register beforeEach/afterEach for a query suite bound to its own Stack.
 *
 * `label` only makes a failure readable; it is suffixed with a random id so two
 * suites never share a fixture domain and delete each other's rows.
 *
 * @param label - Short suite name.
 * @param rootPrefix - Temp-dir prefix for the scratch project.
 * @returns A getter for the fixture of the CURRENT test.
 */
export function useQueryStackFixture(
  label: string,
  rootPrefix: string,
): () => QueryStackFixture {
  let current: QueryStackFixture | undefined;
  let saved: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    const stack = await createProbeStack(label);
    const root = await scratchProjectRoot(rootPrefix);
    saved = { ...process.env };
    const env = {
      AKS_STACK_ID: stack.harness.stackId,
      AKS_DATABASE_URL: testDatabaseUrl(),
    };
    Object.assign(process.env, env);
    current = { stack, root, env: () => ({ ...env }) as NodeJS.ProcessEnv };
  });

  afterEach(async () => {
    process.env = saved;
    const fixture = current;
    current = undefined;
    if (fixture === undefined) return;
    await fixture.stack.harness.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  });

  return () => {
    if (current === undefined) throw new Error("useQueryStackFixture used outside a test");
    return current;
  };
}
