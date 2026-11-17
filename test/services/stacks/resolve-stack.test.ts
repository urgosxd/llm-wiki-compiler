/**
 * @file test/services/stacks/resolve-stack.test.ts
 * @description The Stack a command works on: the id the caller named, or a refusal
 * that names what is missing — and never a Stack created on the way past.
 *
 * ## What these cases pin
 *
 * Two rules: an explicitly configured Stack is used AS GIVEN (no lookup, no second
 * answer), and a caller that named no Stack is REFUSED by name without a row being
 * written. The second rule is the reversal of a contract, on purpose (S1 and S12 of
 * `odd/tasks/stack-authority-per-request.md`): this file used to assert that an
 * unconfigured run fell back to a default Stack that the resolver materialized, and
 * now asserts that nothing is materialized at all. The table is read around the
 * refusal, because a resolver that provisions the Stack it then reports as missing
 * would pass a message-only assertion.
 *
 * ## Why the rows are read through SQL, on the suite's own database
 *
 * `select id from stacks` is the only observation that answers "did the resolver write
 * anything": asking the product would let a bug answer for itself. The whole id list is
 * compared before and after rather than a count alone, so the assertion also names WHICH
 * rows exist. The database is this process's own (`test/fixtures/per-run-database.ts`), so
 * no live or shared database is read.
 */

import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@repo/foundation";

import { createKgPostgresHarness } from "../../fixtures/kg-postgres.js";
import { resolveStackForCommand } from "../../../packages/wiki/src/services/stacks/resolve-stack.js";

const harness = await createKgPostgresHarness("resolve-stack");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

/**
 * The id of every Stack row, in id order, read through SQL.
 *
 * @param handle - Handle to read through.
 * @returns Every Stack id the database holds.
 */
async function stackIds(handle: DatabaseHandle): Promise<readonly string[]> {
  const rows = await handle.execute<{ id: string }>("select id from stacks order by id");
  return rows.map((row) => row.id);
}

describe.skipIf(!reachable)("resolveStackForCommand", () => {
  it("refuses by name when no Stack is configured, and creates no row", async () => {
    const before = await stackIds(db);

    await expect(resolveStackForCommand(db, {})).rejects.toThrow(
      /AKS_DATABASE_URL is configured, so this run must have a Stack/,
    );

    // After the throw, not before: a resolver that provisions on its way out would still
    // satisfy the message assertion above.
    expect(
      await stackIds(db),
      "a refusal must not create the Stack it then reports as missing",
    ).toEqual(before);
  });

  it("returns a configured Stack as given, creating no row", async () => {
    const before = await stackIds(db);

    const stackId = await resolveStackForCommand(db, { AKS_STACK_ID: harness.stackId });

    expect(stackId).toBe(harness.stackId);
    expect(await stackIds(db), "an explicit Stack is used as given, not provisioned").toEqual(before);
  });
});
