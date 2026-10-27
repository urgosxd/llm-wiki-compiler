/**
 * @file test/dimensions/kg-runtime-savepoint-binding.test.ts
 * @description Measures the two gaps `orchestrator-main` named against the
 * atomicity proposal, because both decide whether one spanning transaction is
 * even representable.
 *
 * ## The two objections, restated as questions a database can answer
 *
 * 1. **"`wiki` commit is three nested transactions, not one upsert."** True as
 *    read from the branch: `store-dimension.ts` calls `saveSource` (a file
 *    write), then `saveSourceDocument` (its OWN `db.transaction`), then
 *    `withTenant` (ANOTHER `db.transaction`). So the proposal cannot merely
 *    "pass a tx to the wiki commit" — the wiki commit has to be REWRITTEN to
 *    accept an ambient handle. That is a real scope increase for whoever owns
 *    that file, and this suite does not pretend otherwise.
 *
 * 2. **"`SET LOCAL` under nested savepoints is unmeasured."** This is the
 *    question that could sink the whole design, so it is measured first. Both
 *    stores scope writes with `set_config('app.stack_id', $1, true)`, and
 *    `true` makes the setting transaction-local. If a savepoint could not see
 *    the outer binding, every dimension joining a shared transaction would fail
 *    its policy check. If a savepoint's rebind LEAKED upward, one dimension
 *    could silently retarget another's tenant.
 *
 * ## The mistake this suite exists to prevent repeating
 *
 * A first attempt measured this with `db.transaction(...)` nested inside another
 * `db.transaction(...)`. That is NOT a savepoint: drizzle's pool hands the inner
 * call a DIFFERENT connection, so the inner body correctly saw `null` and the
 * result said "savepoints do not inherit" — which would have been a false
 * conclusion about the design. A savepoint requires `tx.transaction(...)` on the
 * outer handle. Case S1 pins that distinction so the wrong shape cannot come
 * back.
 *
 * ## What is and is not claimed
 *
 * Measured: inheritance, isolation on rollback, and that RLS still refuses a
 * foreign write from inside a savepoint. NOT measured or claimed: that the wiki
 * commit is cheap to rewrite. See objection 1 — it is not.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { asAppRole, sqlStateOf } from "./kg-runtime-app-role.js";

const harness = await createKgPostgresHarness("kg-runtime-savepoint");
const { db, stackId, reachable } = harness;

/** A second real stack, so a foreign write fails on the policy, never the FK. */
let foreignStackId = "";

const provisioned = await (async (): Promise<boolean> => {
  if (!reachable) return false;
  try {
    const tables = await db.execute<{ n: number }>(`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'wiki' and table_name = 'pages'
    `);
    if ((tables[0] as { n: number } | undefined)?.n !== 1) {
      console.warn("kg-runtime-savepoint: wiki.pages missing; run schema.sql");
      return false;
    }
    foreignStackId = randomUUID();
    const domain = `sp-foreign-${foreignStackId.slice(0, 8)}`;
    await db.execute(
      `insert into stacks (id, name, domain) values ('${foreignStackId}', '${domain}', '${domain}')`,
    );
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  if (foreignStackId !== "") {
    await db.execute(`delete from stacks where id = '${foreignStackId}'`).catch(() => undefined);
  }
  await harness.cleanup();
});

/** Read the tenant GUC the way a policy sees it. */
async function boundStackOf(executor: { execute: (q: ReturnType<typeof sql>) => Promise<unknown[]> }) {
  const rows = await executor.execute(sql`select current_setting('app.stack_id', true) as v`);
  return (rows[0] as { v: string | null } | undefined)?.v;
}

/** A transaction handle that can also open savepoints, as drizzle exposes it. */
interface SavepointCapable {
  execute(query: ReturnType<typeof sql>): Promise<unknown[]>;
  transaction<T>(fn: (tx: SavepointCapable) => Promise<T>): Promise<T>;
}

/**
 * Run `work` as the app role with the harness Stack ALREADY BOUND on the outer
 * transaction.
 *
 * The outer bind is not a convenience: measured, a savepoint INHERITS an existing
 * binding and does not create one, so without this every inner write is refused
 * 42501. Folding it in here keeps each case about savepoints rather than about
 * remembering a `set_config`.
 */
function withBoundOuter<T>(work: (outer: SavepointCapable) => Promise<T>): Promise<T> {
  return asAppRole(harness, async (outerTx) => {
    const outer = outerTx as unknown as SavepointCapable;
    await outer.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return work(outer);
  });
}

/** Count how many `wiki.pages` rows exist for one slug. */
async function countPage(slug: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    `select count(*)::int as n from wiki.pages where slug = '${slug}'`,
  );
  return (rows[0] as { n: number } | undefined)?.n ?? 0;
}

/** Insert one concept page for the harness Stack inside `tx`. */
async function insertPage(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown[]> },
  ownerStackId: string,
  slug: string,
): Promise<void> {
  await tx.execute(sql`
    insert into wiki.pages (stack_id, page_directory, slug, title, body)
    values (${ownerStackId}, 'concepts', ${slug}, ${"T"}, ${"body"})
  `);
}

/** A slug unique per case. */
function slugOf(label: string): string {
  return `sp-${label}-${randomUUID().slice(0, 8)}`;
}

describe.skipIf(!provisioned)("SET LOCAL and savepoints", () => {
  /**
   * S1 — a SAVEPOINT inherits the outer binding.
   *
   * Load-bearing: without inheritance, joining a shared transaction would break
   * every dimension's policy check.
   */
  it("a savepoint inherits the outer tenant binding", async () => {
    const seen = await withBoundOuter(async (outer) => {
      let inner: string | null | undefined;
      await outer.transaction(async (tx) => {
        inner = await boundStackOf(tx);
      });
      return inner;
    });

    expect(seen).toBe(stackId);
  });

  /**
   * S2 — a savepoint that REBINDS and then rolls back leaves the outer binding
   * intact, and the outer transaction can still write.
   *
   * Without this, one dimension joining a shared transaction could retarget the
   * tenant for every other dimension in it — a cross-tenant write hidden inside a
   * recoverable-looking rollback.
   */
  it("a rolled-back savepoint cannot steal the outer binding", async () => {
    const slug = slugOf("rebind");

    await withBoundOuter(async (outer) => {
      await expect(
        outer.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.stack_id', ${foreignStackId}, true)`);
          throw new Error("abandon the savepoint");
        }),
      ).rejects.toThrow("abandon the savepoint");

      expect(await boundStackOf(outer)).toBe(stackId);
      // The outer transaction is still permitted to write.
      await insertPage(outer, stackId, slug);
    });

    expect(await countPage(slug)).toBe(1);
  });

  /**
   * S3 — a savepoint can WRITE for the outer's Stack, which is exactly what a
   * dimension joining a shared transaction needs to do.
   */
  it("a savepoint can write for the stack the outer transaction bound", async () => {
    const slug = slugOf("innerwrite");

    await withBoundOuter(async (outer) => {
      await outer.transaction(async (tx) => {
        await insertPage(tx, stackId, slug);
      });
    });

    expect(await countPage(slug)).toBe(1);
  });

  /**
   * S5 — the coordinator's single bind survives BOTH dimensions writing in one
   * transaction, including `kg`'s own internal `bindCallerStack` rebind.
   *
   * This is the case that decides whether `CommitScope` needs a `stackId` field.
   * `registerDocumentRow`, `consolidateEntityRows` and `consolidateRelationshipRows`
   * each rebind the GUC to the value they were constructed with. If that rebind
   * were harmful, the scope would have to carry the tenant; if it is inert, the
   * dimension's constructed `options.stackId` is enough and a scope field would
   * only add a call site someone can forget.
   *
   * Measured: inert. All three writes land.
   */
  it("both dimensions write in one bound transaction despite kg's internal rebind", async () => {
    const slug = slugOf("both");

    await withBoundOuter(async (outer) => {
      // wiki-shaped write: does not rebind
      await insertPage(outer, stackId, slug);
      // kg-shaped writes, including the same-value rebind each helper performs
      await outer.execute(sql`
        insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
        values (${stackId}, ${slug}, ${"src://" + slug}, ${4}, ${"h-" + slug})
      `);
      await outer.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
      await outer.execute(sql`
        insert into ontology_entities (stack_id, name, type) values (${stackId}, ${slug}, 'concept')
      `);
    });

    expect(await countPage(slug)).toBe(1);
    const docs = await db.execute<{ n: number }>(
      `select count(*)::int as n from stack_documents where storage_path = 'src://${slug}'`,
    );
    expect((docs[0] as { n: number } | undefined)?.n).toBe(1);
    const ents = await db.execute<{ n: number }>(
      `select count(*)::int as n from ontology_entities where name = '${slug}'`,
    );
    expect((ents[0] as { n: number } | undefined)?.n).toBe(1);
  });

  /**
   * S4 — RLS still refuses a FOREIGN write from inside a savepoint.
   *
   * The negative control for S1-S3: if inheritance worked by weakening the
   * policy, this would pass and the design would be trading isolation for
   * atomicity. It must refuse with 42501.
   */
  it("a savepoint still cannot write for a foreign stack", async () => {
    const slug = slugOf("foreign");
    let raised: unknown;

    await withBoundOuter(async (outer) => {
      await outer.transaction(async (tx) => {
        await insertPage(tx, foreignStackId, slug);
      });
    }).catch((error: unknown) => {
      raised = error;
    });

    expect(sqlStateOf(raised)).toBe("42501");
    expect(await countPage(slug)).toBe(0);
  });
});
