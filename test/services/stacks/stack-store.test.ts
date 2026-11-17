/**
 * @file test/services/stacks/stack-store.test.ts
 * @description What a Stack lookup does with an id — and what it says when the
 * database it is pointed at never ran `db/migration_stack_active.sql`.
 *
 * ## Why the missing-column case is here and not in a doc
 *
 * `stackResolution` selects `stacks.active` unconditionally, so a database that has not
 * applied that migration fails EVERY Stack lookup. The documented instruction to apply
 * it was carried only by prose, and the failure an operator actually met was a raw
 * `PostgresError 42703` surfacing from three layers down — which reads as a broken
 * query, not as "you did not run the migration". A documented mandatory step with no
 * check is the gap this file closes: the failure has to name the file to apply.
 *
 * ## Why the column is really dropped instead of mocked
 *
 * The scenario is built the way an operator meets it. `test/fixtures/per-run-database.ts`
 * provisions a fully migrated database (`scripts/apply-schemas.sh`), so the column is
 * dropped here with `alter table stacks drop column active` and restored afterwards. A
 * mocked driver error would pin the guard against a guess about the error shape; this
 * pins it against the one Postgres actually emits.
 *
 * ## And why the migrated half stays
 *
 * Dropping a column is a drastic fixture. The tri-state answer (`active` / `inactive` /
 * `absent`) is the contract every caller branches on, so it is pinned on a migrated
 * database in the same file: a guard that made the migration visible by breaking the
 * normal answer would be a worse bug than the one it fixes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createKgPostgresHarness } from "../../fixtures/kg-postgres.js";
import {
  stackExists,
  stackResolution,
} from "../../../packages/wiki/src/services/stacks/stack-store.js";

const harness = await createKgPostgresHarness("stack-store");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

/** The column shape this build requires, as `migration_stack_active.sql` writes it. */
const RESTORE_ACTIVE =
  "alter table stacks add column if not exists active boolean not null default true";

/** The exact term an operator has to be able to act on. */
const NAMES_THE_MIGRATION = /migration_stack_active\.sql/;

/**
 * Run a lookup and hand back whatever it threw, so the error's own shape can be read.
 *
 * `rejects.toThrow` stops at the message; "is this the raw driver error or a named
 * refusal" is a question about the value, and the value is what an operator's log and
 * the HTTP envelope both carry.
 *
 * @param run - The lookup to perform.
 * @returns The thrown value.
 */
async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the lookup to refuse, but it answered");
}

describe.skipIf(!reachable)("stackResolution on a migrated database", () => {
  afterEach(async () => {
    await db.execute(`update stacks set active = true where id = '${harness.stackId}'`);
  });

  it("answers active, inactive and absent, unchanged by the presence of the guard", async () => {
    expect(await stackResolution(db, harness.stackId)).toBe("active");
    expect(await stackExists(db, harness.stackId)).toBe(true);

    // `DELETE` retires a Stack by flag (S4), and the retirement has to be visible here
    // or every surface would keep serving a Stack an operator just retired.
    await db.execute(`update stacks set active = false where id = '${harness.stackId}'`);
    expect(await stackResolution(db, harness.stackId)).toBe("inactive");
    expect(await stackExists(db, harness.stackId)).toBe(false);

    // Absent is a DIFFERENT answer from inactive: one can be reactivated, the other
    // cannot, and the two refusals carry different codes (S10).
    expect(await stackResolution(db, "00000000-0000-4000-8000-000000000000")).toBe("absent");
    expect(await stackExists(db, "00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});

describe.skipIf(!reachable)("a database that never ran the stack-active migration", () => {
  beforeAll(async () => {
    await db.execute("alter table stacks drop column active");
  });

  afterAll(async () => {
    await db.execute(RESTORE_ACTIVE);
  });

  it("names the migration instead of surfacing the raw undefined_column error", async () => {
    const error = await thrownBy(() => stackResolution(db, harness.stackId));

    // The words an operator can act on. `42703 column "active" does not exist` is what
    // this replaced, and it names neither the file nor the step that is missing.
    expect((error as Error).message).toMatch(NAMES_THE_MIGRATION);
    expect((error as Error).message).toContain("stacks.active");

    // Not the driver error reaching the caller raw. Two things it must not be: an
    // unnamed `Error` (nothing to branch on), and drizzle's `Failed query: …` wrapper,
    // which is what the caller met before this guard and reads as a broken SELECT.
    expect((error as Error).name).toBe("MissingStackColumnError");
    expect((error as Error).message.startsWith("Failed query:")).toBe(false);
  });

  it("keeps the driver error as the cause, so the gap is not swallowed", async () => {
    const error = await thrownBy(() => stackResolution(db, harness.stackId));

    const cause = (error as { cause?: unknown }).cause;
    expect(cause, "the underlying driver error must be chained, not discarded").toBeInstanceOf(
      Error,
    );
    expect((cause as Error).message).toContain('column "active" does not exist');
  });

  it("names the migration through stackExists too, the wrapper every caller uses", async () => {
    const error = await thrownBy(() => stackExists(db, harness.stackId));

    expect((error as Error).message).toMatch(NAMES_THE_MIGRATION);
    expect((error as Error).name).toBe("MissingStackColumnError");
  });
});
