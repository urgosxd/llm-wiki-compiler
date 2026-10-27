/**
 * @file test/dimensions/kg-runtime-cross-dimension-transaction.test.ts
 * @description Can ONE Postgres transaction span the kg dimension and the wiki
 * dimension, so a failure in either rolls back the other? This suite answers that
 * with a measurement instead of an argument.
 *
 * ## Why this question exists
 *
 * `src/dimensions/coordinator.ts` opens with a premise: "The two dimensions
 * cannot share a transaction: one writes a local directory, the other writes rows
 * in an external Postgres." The outbox, the saga, `discard`, and the
 * forward-only reconciler are ALL built on top of that premise.
 *
 * That premise has expired. `src/dimensions/wiki/schema.sql` puts compiled pages
 * in a `wiki` schema beside the graph tables in `public`, in the same database,
 * reached through the same pooled client. The two dimensions are no longer "a
 * local directory and a remote database"; they are two schemas of one database.
 *
 * Whether one transaction can therefore cover both is NOT obvious and must not be
 * inferred from DDL alone. Three things could break it, and each is MEASURED
 * here:
 *
 *   1. **Tenant binding.** Both stores scope writes with
 *      `set_config('app.stack_id', $1, true)`, where `true` makes the setting
 *      transaction-local. Two dimensions binding the same GUC in ONE transaction
 *      could reset each other, and a binding that silently lost its value would
 *      make the second write fail a policy check the first passed.
 *   2. **RLS actually being enforced.** `aks` is a SUPERUSER with BYPASSRLS, and
 *      the shared harness connects as `aks`. Running this suite as that role
 *      would prove nothing: RLS would be inert and every policy question would
 *      answer "yes". The test body therefore drops to `llmwiki_app` — the
 *      non-superuser role production uses — with transaction-scoped
 *      `set local role`.
 *   3. **Cross-schema visibility inside one transaction.** A row written to
 *      `public` must be visible to a policy-checked read in `wiki` before commit.
 *
 * ## What this suite deliberately does NOT do
 *
 * No product code is changed. This is a feasibility measurement: if the answer is
 * "no", the existing saga is vindicated; if "yes", the stale premise in
 * `coordinator.ts` is what needs revisiting. Either outcome is a useful result,
 * and neither is this suite's decision to make.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, createDatabase } from "llmwiki-kg";

import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import {
  asAppRole as runAsAppRole,
  sqlStateOf,
  type AppRoleExecutor,
} from "./kg-runtime-app-role.js";

const harness = await createKgPostgresHarness("kg-runtime-xdim-tx");

/**
 * Executor shape the insertion helpers below accept.
 *
 * An ALIAS of the shared {@link AppRoleExecutor} rather than a local twin, so the
 * helpers accept exactly what `asAppRole` hands them and the two cannot drift.
 */
type Executor = AppRoleExecutor;

/**
 * Is the environment able to answer the question at all?
 *
 * A missing `wiki` schema or a missing `llmwiki_app` role would each turn every
 * assertion below into a vacuous pass, so both are checked once and the suite
 * skips LOUDLY rather than looking green for the wrong reason.
 */
const provisioned = await (async (): Promise<boolean> => {
  if (!harness.reachable) return false;
  try {
    const tables = await harness.db.execute<{ n: number }>(`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'wiki' and table_name = 'pages'
    `);
    if ((tables[0] as { n: number } | undefined)?.n !== 1) {
      console.warn("kg-runtime-xdim-tx: wiki.pages missing; run src/dimensions/wiki/schema.sql");
      return false;
    }
    const roles = await harness.db.execute<{ ok: boolean }>(`
      select exists (select 1 from pg_roles where rolname = 'llmwiki_app') as ok
    `);
    if ((roles[0] as { ok: boolean } | undefined)?.ok !== true) {
      console.warn("kg-runtime-xdim-tx: llmwiki_app missing; run migration_rls_tenancy.sql");
      return false;
    }
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await harness.cleanup();
});

/** A slug unique per case, so no two cases collide on a primary key. */
function uniqueSlug(label: string): string {
  return `xdim-${label}-${randomUUID().slice(0, 8)}`;
}

/**
 * Run `work` as the production application role inside ONE transaction.
 *
 * Thin binding of the SHARED helper (`kg-runtime-app-role.ts`), which owns the
 * `set local role` scope rule and the reasoning behind it. Bound to one argument
 * here so every call site below reads as `asAppRole(fn)` instead of threading the
 * harness through each one.
 *
 * @param work - Statements to run under the app role.
 * @returns Whatever `work` produced, after COMMIT.
 */
function asAppRole<T>(work: (tx: Executor) => Promise<T>): Promise<T> {
  return runAsAppRole(harness, work);
}

/** Write one page row into `wiki.pages` for the harness stack (the wiki dimension). */
async function insertWikiPage(tx: Executor, slug: string): Promise<void> {
  await tx.execute(sql`
    insert into wiki.pages (stack_id, page_directory, slug, title, body, source_identity)
    values (${harness.stackId}, 'concepts', ${slug}, ${"T " + slug}, ${"body"}, ${"src://" + slug})
  `);
}

/**
 * Write one document row into `public.stack_documents` (the kg dimension's
 * parent row). This is the table `registerDocumentRow` inserts, and the row every
 * entity contribution foreign-keys onto.
 */
async function insertKgDocument(tx: Executor, slug: string): Promise<void> {
  await tx.execute(sql`
    insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
    values (${harness.stackId}, ${slug}, ${"src://" + slug}, ${4}, ${"hash-" + slug})
  `);
}

/** Count `wiki.pages` rows for one slug, read OUTSIDE any transaction. */
async function countWikiPage(slug: string): Promise<number> {
  const rows = await harness.db.execute<{ n: number }>(`
    select count(*)::int as n from wiki.pages where slug = '${slug}'
  `);
  return (rows[0] as { n: number } | undefined)?.n ?? 0;
}

/** Count `stack_documents` rows for one storage path, read OUTSIDE any transaction. */
async function countKgDocument(slug: string): Promise<number> {
  const rows = await harness.db.execute<{ n: number }>(`
    select count(*)::int as n from stack_documents where storage_path = 'src://${slug}'
  `);
  return (rows[0] as { n: number } | undefined)?.n ?? 0;
}

/**
 * Create a SECOND real stack, so a cross-tenant write can fail on the policy
 * rather than on the `stack_id` foreign key.
 *
 * Created through the harness's superuser handle because `stacks` is itself
 * RLS-protected and the app role cannot insert tenants.
 *
 * @returns The new stack's id.
 */
async function createForeignStack(): Promise<string> {
  const id = randomUUID();
  const domain = `xdim-foreign-${id.slice(0, 8)}`;
  await harness.db.execute(
    `insert into stacks (id, name, domain) values ('${id}', '${domain}', '${domain}')`,
  );
  return id;
}

/**
 * Delete a stack created by {@link createForeignStack}, leaving no residue.
 *
 * @param id - The stack to drop; pages and documents cascade from it.
 */
async function dropForeignStack(id: string): Promise<void> {
  await harness.db.execute(`delete from stacks where id = '${id}'`).catch(() => undefined);
}

describe.skipIf(!provisioned)("one transaction across the kg and wiki dimensions", () => {
  /**
   * THE CORE MEASUREMENT.
   *
   * Both dimensions write inside one transaction, then the transaction aborts. If
   * the coordinator's premise still holds, at least one write survives — because
   * the two systems "cannot share a transaction". If the premise has expired,
   * BOTH must be absent afterwards.
   */
  it("rolls back BOTH dimensions when the transaction fails", async () => {
    const slug = uniqueSlug("abort");

    await expect(
      asAppRole(async (tx) => {
        // The binding is REQUIRED before either write, and that is itself a
        // finding: without it the FIRST insert is refused by the policy, not the
        // transaction. Binding once must serve both schemas for the measurement
        // below to be about atomicity rather than about a missing GUC.
        await tx.execute(sql`select set_config('app.stack_id', ${harness.stackId}, true)`);
        await insertWikiPage(tx, slug);
        await insertKgDocument(tx, slug);
        // Fail AFTER both writes landed: the exact shape of "kg committed, then
        // something downstream failed" that the outbox exists to paper over.
        throw new Error("simulated cross-dimension failure");
      }),
    ).rejects.toThrow("simulated cross-dimension failure");

    expect(await countWikiPage(slug)).toBe(0);
    expect(await countKgDocument(slug)).toBe(0);
  });

  /**
   * Tenant binding is the likeliest way atomicity breaks, because BOTH stores set
   * the SAME transaction-local GUC. A second `set_config` that clobbered the first
   * would make one dimension's rows invisible to its own policy check, and the
   * failure would look like a random permission error under load.
   *
   * The order here mirrors production: wiki binds and writes first, kg binds and
   * writes second.
   */
  it("keeps the tenant binding valid across two sequential binds", async () => {
    const slug = uniqueSlug("bind");

    const observed = await asAppRole(async (tx) => {
      await tx.execute(sql`select set_config('app.stack_id', ${harness.stackId}, true)`);
      await insertWikiPage(tx, slug);
      // A second dimension binding the same GUC inside one transaction.
      await tx.execute(sql`select set_config('app.stack_id', ${harness.stackId}, true)`);
      await insertKgDocument(tx, slug);
      const wiki = await tx.execute(sql`
        select count(*)::int as n from wiki.pages where slug = ${slug}
      `);
      const kg = await tx.execute(sql`
        select count(*)::int as n from stack_documents where storage_path = ${"src://" + slug}
      `);
      return {
        wiki: (wiki[0] as { n: number } | undefined)?.n,
        kg: (kg[0] as { n: number } | undefined)?.n,
      };
    });

    expect(observed).toEqual({ wiki: 1, kg: 1 });
    // Both survive the COMMIT, so the binding permitted more than a read.
    expect(await countWikiPage(slug)).toBe(1);
    expect(await countKgDocument(slug)).toBe(1);
  });

  /**
   * RLS must actually bite, or every conclusion above is an artifact of a
   * BYPASSRLS superuser. Binding stack A and then writing a row owned by stack B
   * must be refused BY THE POLICY.
   *
   * WHY THE FOREIGN STACK MUST EXIST. An earlier draft used a random uuid for
   * stack B, which made the insert fail on the `stack_id` foreign key instead of
   * on RLS — a green assertion proving the wrong thing. The failure MODE is the
   * whole subject here, so the second stack is created for real and the error
   * text is asserted to name row-level security.
   *
   * This case is also what catches a harness regression: the shared fixture
   * connects as `aks`, so without `set local role llmwiki_app` this insert would
   * SUCCEED and prove the opposite of what the suite claims.
   */
  it("enforces the tenant policy under the app role, not the superuser", async () => {
    const slug = uniqueSlug("rls");
    const foreignStack = await createForeignStack();

    try {
      const error = await asAppRole(async (tx) => {
        await tx.execute(sql`select set_config('app.stack_id', ${harness.stackId}, true)`);
        // A REAL stack this session is not bound to, so only the policy can
        // refuse it.
        await tx.execute(sql`
          insert into wiki.pages (stack_id, page_directory, slug, title, body)
          values (${foreignStack}, 'concepts', ${slug}, ${"T"}, ${"body"})
        `);
      }).then(
        () => { throw new Error("the cross-tenant insert was ACCEPTED"); },
        (caught: unknown) => caught,
      );

      // SQLSTATE 42501 is `insufficient_privilege`, which is what a policy
      // violation raises. Asserting the CODE rather than the prose matters:
      // drizzle wraps driver errors in a generic "Failed query" message and
      // hides the driver's own text on `cause`, so matching the outer message
      // would only ever see "Failed query". The code also proves the refusal
      // came from the policy and not from a foreign key (23503) or a check
      // constraint (23514) that happens to fail on the same insert.
      expect(sqlStateOf(error)).toBe("42501");
      expect(await countWikiPage(slug)).toBe(0);
    } finally {
      await dropForeignStack(foreignStack);
    }
  });

  /**
   * THE NEGATIVE CONTROL, and the reason the positive result above means
   * anything.
   *
   * A passing "both roll back" test proves nothing on its own: it could be
   * passing because the two writes never really shared a transaction in a way
   * that matters. So this case reproduces what the product does TODAY — `kg`
   * opens its OWN client (`src/dimensions/kg/index.ts:212`) while the wiki uses
   * the coordinator's handle — and shows that a failure in one does NOT undo the
   * other.
   *
   * Together the two cases localize the defect precisely: the transaction handle
   * is the only thing standing between the current saga and real atomicity. It is
   * not the schemas, not the tenant GUC, and not Postgres.
   */
  it("DOES NOT roll back across two separate clients, which is today's shape", async () => {
    const slug = uniqueSlug("split");
    const secondClient = createClient(DATABASE_URL, 10);
    const secondDb = createDatabase(secondClient);

    try {
      // The kg-side write commits on its OWN connection, exactly as
      // `writeGraph` does with `createClient(...)` + `db.transaction(...)`.
      await secondDb.transaction(async (tx) => {
        await tx.execute(sql`set local role llmwiki_app`);
        await tx.execute(sql`select set_config('app.stack_id', ${harness.stackId}, true)`);
        await insertKgDocument(tx as unknown as Executor, slug);
      });

      // Then the wiki side fails on its own connection. It cannot roll back a
      // transaction it was never part of.
      await expect(
        asAppRole(async (tx) => {
          await tx.execute(sql`select set_config('app.stack_id', ${harness.stackId}, true)`);
          await insertWikiPage(tx, slug);
          throw new Error("wiki side failed after kg committed");
        }),
      ).rejects.toThrow("wiki side failed after kg committed");

      // THE DEFECT, stated as a measurement: the wiki write is gone, kg's is not.
      expect(await countWikiPage(slug)).toBe(0);
      expect(await countKgDocument(slug)).toBe(1);
    } finally {
      await secondClient.end({ timeout: 10 });
    }
  });
});
