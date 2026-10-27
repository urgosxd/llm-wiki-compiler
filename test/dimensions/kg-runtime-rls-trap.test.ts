/**
 * @file test/dimensions/kg-runtime-rls-trap.test.ts
 * @description Pins the harness trap as a MEASURED fact, so it cannot be
 * rediscovered the expensive way: a suite that "proves" tenant isolation while
 * connected as a BYPASSRLS superuser proves nothing at all.
 *
 * ## What is pinned, and why each half matters
 *
 * 1. **The trap is real.** The shared fixture's connection bypasses RLS. Without
 *    this assertion the trap is folklore that a future reader may dismiss.
 * 2. **The trap is invisible in the assertion it corrupts.** A cross-tenant read
 *    SUCCEEDS on that connection. This is the failure mode stated as behaviour
 *    rather than as prose: the unsafe path looks exactly like a passing test.
 * 3. **The helper removes it.** The same cross-tenant read is REFUSED when it
 *    runs as `llmwiki_app`, with the SQLSTATE a policy violation actually raises.
 *
 * Together they make the guard falsifiable: if anyone later connects the fixture
 * as the app role, case 1 and case 2 fail and point at the right place.
 *
 * ## Why SQLSTATE rather than the message
 *
 * Drizzle re-throws driver failures as a generic "Failed query" wrapper and keeps
 * the driver's own error on `cause`. Matching message text therefore cannot
 * distinguish a policy refusal (42501) from a foreign key (23503) or a check
 * constraint (23514) — all three can fail the same statement. The code can.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { APP_ROLE, asAppRole, connectionBypassesRls, sqlStateOf } from "./kg-runtime-app-role.js";

const harness = await createKgPostgresHarness("kg-runtime-rls-trap");
const { db, stackId, reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

/** Create a REAL second stack, so a cross-tenant write cannot fail on the FK. */
async function createForeignStack(): Promise<string> {
  const id = randomUUID();
  const domain = `rls-trap-${id.slice(0, 8)}`;
  await db.execute(`insert into stacks (id, name, domain) values ('${id}', '${domain}', '${domain}')`);
  return id;
}

/** Count pages for one slug, read on the harness connection (outside any tx). */
async function countPage(slug: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    `select count(*)::int as n from wiki.pages where slug = '${slug}'`,
  );
  return (rows[0] as { n: number } | undefined)?.n ?? 0;
}

describe.skipIf(!reachable)("the RLS trap in the shared Postgres harness", () => {
  /**
   * CASE 1 — the trap exists.
   *
   * Probed from the connection itself (`rolbypassrls or rolsuper`) rather than
   * from the username, so it stays correct if the DSN changes.
   */
  it("connects as a role that bypasses row-level security", async () => {
    expect(await connectionBypassesRls(harness)).toBe(true);
  });

  /**
   * CASE 2 — and the trap looks like a passing test.
   *
   * The SAME cross-tenant insert that case 3 refuses is ACCEPTED here. Stated as
   * a measurement because that is the whole danger: nothing about the assertion
   * would tell a reader the policy never ran.
   */
  it("ACCEPTS a cross-tenant write on that connection, which is the trap", async () => {
    const slug = `rls-trap-super-${randomUUID().slice(0, 8)}`;
    const foreignStack = await createForeignStack();

    try {
      // Bound to `stackId`, writing a row owned by a DIFFERENT stack.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
        await tx.execute(sql`
          insert into wiki.pages (stack_id, page_directory, slug, title, body)
          values (${foreignStack}, 'concepts', ${slug}, ${"T"}, ${"body"})
        `);
      });

      // The unsafe path SUCCEEDS. That is the finding, not a bug in the test.
      expect(await countPage(slug)).toBe(1);
    } finally {
      await db.execute(`delete from stacks where id = '${foreignStack}'`).catch(() => undefined);
    }
  });

  /**
   * CASE 3 — the helper restores the guarantee, and the refusal is the POLICY.
   *
   * SQLSTATE 42501 (`insufficient_privilege`) proves the origin. A foreign key
   * (23503) or check constraint (23514) would also refuse the statement, so
   * asserting HTTP-shaped success/failure alone would leave the cause ambiguous.
   */
  it("refuses the same cross-tenant write under the app role, with SQLSTATE 42501", async () => {
    const slug = `rls-trap-app-${randomUUID().slice(0, 8)}`;
    const foreignStack = await createForeignStack();

    try {
      const error = await asAppRole(harness, async (tx) => {
        await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
        await tx.execute(sql`
          insert into wiki.pages (stack_id, page_directory, slug, title, body)
          values (${foreignStack}, 'concepts', ${slug}, ${"T"}, ${"body"})
        `);
      }).then(
        () => {
          throw new Error(`cross-tenant insert was ACCEPTED as ${APP_ROLE}`);
        },
        (caught: unknown) => caught,
      );

      expect(sqlStateOf(error)).toBe("42501");
      expect(await countPage(slug)).toBe(0);
    } finally {
      await db.execute(`delete from stacks where id = '${foreignStack}'`).catch(() => undefined);
    }
  });
});
