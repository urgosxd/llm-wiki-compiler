/**
 * @file test/services/ingest/default-stack-ingest.test.ts
 * @description An ingest on a checkout that configured a database and NAMED no Stack
 * refuses by name, instead of writing to a Stack nobody created.
 *
 * ## The contract this pins, and the one it reverses
 *
 * This file used to pin the opposite: that an ingest with no `AKS_STACK_ID` reached
 * its work and wrote to a default Stack the resolver materialized on the way past.
 * That is deleted by decision (S1 of `odd/tasks/stack-authority-per-request.md` — no
 * Stack may be created implicitly, a Stack is created by its owner over HTTP or from
 * an explicit declaration), so the assertion is REVERSED on purpose and not
 * retargeted to another Stack: the run must fail, the failure must name what is
 * missing, and no row may appear.
 *
 * Why the count matters as much as the message: a refusal that provisions the Stack
 * it then reports as missing would satisfy a message-only assertion, and that is
 * precisely the defect this file exists to catch.
 *
 * ## Why the environment is passed and not exported into `process.env`
 *
 * `ingestSource` takes the environment it writes with, so the case can hand it a bare
 * one -- a connection string and NO Stack id -- instead of mutating `process.env` and
 * restoring it. The smaller blast radius is the point: nothing else in this worker can
 * observe this case.
 *
 * ## Teardown
 *
 * The source file and its root live in a temp directory outside the worktree, removed
 * in `finally`. The database is this process's own (`test/fixtures/kg-postgres.ts`),
 * so nothing here can be another suite's row.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseHandle } from "@repo/foundation";

import { AKS_DATABASE_URL_ENV_VAR } from "../../../packages/wiki/src/dimensions/activation.js";
import { DATABASE_URL, createKgPostgresHarness } from "../../fixtures/kg-postgres.js";
import { ingestSource } from "../../../packages/wiki/src/services/ingest/service.js";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "A short document ingested by a checkout that never named a Stack.";

/** The environment a deployment has before it created its first Stack. */
const BARE_ENV: NodeJS.ProcessEnv = { [AKS_DATABASE_URL_ENV_VAR]: DATABASE_URL };

const harness = await createKgPostgresHarness("ingest-default-stack");
const { reachable } = harness;

afterAll(() => harness.cleanup());

/**
 * How many rows `public.stacks` holds right now.
 *
 * @param handle - Handle to read through.
 * @returns The row count of `public.stacks`.
 */
async function countStacks(handle: DatabaseHandle): Promise<number> {
  const rows = await handle.execute<{ n: number }>("select count(*)::int as n from public.stacks");
  return Number(rows[0]?.n);
}

describe.skipIf(!reachable)("ingest with no Stack named", () => {
  it("refuses by name and creates no Stack, instead of writing to one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingest-default-stack-"));
    try {
      const source = path.join(root, "bare-checkout.md");
      await writeFile(source, BODY, "utf-8");
      const before = await countStacks(harness.db);

      const outcome = await ingestSource(root, source, undefined, BARE_ENV).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(
        `${AKS_DATABASE_URL_ENV_VAR} is configured, so this run must have a Stack`,
      );
      // Measured after the refusal, never before: provisioning on the way out is the
      // behaviour this assertion exists to forbid. A count, not an id list, because this
      // suite's Stack is shared with the fixture that provisioned it.
      expect(
        await countStacks(harness.db),
        "an ingest that named no Stack must not create one",
      ).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
