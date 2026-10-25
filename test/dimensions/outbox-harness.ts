/**
 * @file test/dimensions/outbox-harness.ts
 * @description Shared setup for suites that drive the ingest outbox.
 *
 * The outbox moved from JSON files under `.llmwiki` to rows in `ingest_outbox`, so
 * every suite that touches it now needs a live Stack and the two environment
 * variables the coordinator and host read. That setup is identical across suites
 * and was duplicated until fallow flagged it, which is the point: three copies of a
 * reachability probe drift into three slightly different probes.
 *
 * ## Why each harness gets a unique name
 *
 * `stacks.domain` is UNIQUE and the fixture sets it from the harness name, so two
 * suites using the same label collide with `duplicate key value violates unique
 * constraint "stacks_domain_key"` -- which reads as a database problem rather than
 * a naming one. The suffix makes the name unique without the caller thinking about
 * it.
 */
import { randomUUID } from "node:crypto";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** One suite's private Stack, plus the cleanup that retires it. */
export interface OutboxSetup {
  readonly harness: KgPostgresHarness;
  /** Restore the environment and drop the Stack. Safe to call once. */
  readonly release: () => Promise<void>;
}

/**
 * Provision a Stack for an outbox suite and point the process at it.
 *
 * Sets `AKS_STACK_ID` because the coordinator and host read the Stack from the
 * environment, and `AKS_DATABASE_URL` because `createDimensionsDatabase` otherwise
 * falls back to the vendored default `postgresql://aks:aks@localhost:5432/aks` --
 * the PRODUCTION port -- while the harness listens on 5434. Without that variable
 * the Stack provisions correctly and is never reached, and the failure reads as a
 * missing database rather than a missing variable.
 *
 * @param label - Short suite name; a random suffix is appended for uniqueness.
 * @returns The harness and a release that undoes both the env and the Stack.
 */
export async function provisionOutboxStack(label: string): Promise<OutboxSetup> {
  const harness = await createKgPostgresHarness(`${label}-${randomUUID().slice(0, 8)}`);
  const previousStack = process.env.AKS_STACK_ID;
  const previousUrl = process.env.AKS_DATABASE_URL;
  process.env.AKS_STACK_ID = harness.stackId;
  process.env.AKS_DATABASE_URL = databaseUrl();
  return {
    harness,
    release: async () => {
      restore("AKS_STACK_ID", previousStack);
      restore("AKS_DATABASE_URL", previousUrl);
      await harness.cleanup();
    },
  };
}

/**
 * Is Postgres reachable, asked once per module?
 *
 * A skip must be loud rather than silent: the reason names the missing database, so
 * a suite that did not run cannot be mistaken for a suite that passed.
 *
 * @param label - Short label for the probe's own throwaway Stack.
 * @returns True when a Stack could actually be provisioned.
 */
export async function outboxReachable(label: string): Promise<boolean> {
  const probe = await createKgPostgresHarness(`${label}-probe-${randomUUID().slice(0, 8)}`);
  const ok = probe.reachable;
  await probe.cleanup();
  return ok;
}

/** The harness DSN, matching what `kg-postgres.ts` connects to. */
function databaseUrl(): string {
  return process.env.LLMWIKI_TEST_DATABASE_URL ?? "postgresql://aks:aks@localhost:5434/aks";
}

/** Put an environment variable back the way it was, deleting when it was unset. */
function restore(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}
