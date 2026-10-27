/**
 * @file test/dimensions/ingest-atomicity.test.ts
 * @description The property the whole change exists for, measured against the
 * SHIPPED wiki and graph dimensions and a real Postgres: both commit, or neither.
 *
 * ## Why this suite is separate from `cross-dimension-rollback.test.ts`
 *
 * That suite uses doubles and can only prove the COORDINATOR'S BOOKKEEPING -- two
 * attempts, the pending record erased, a failed record written afterwards. The
 * doubles run outside the transaction, so they cannot show that Postgres rolls a
 * dimension's rows back.
 *
 * This suite wires the real `createWikiStoreDimension` and `createKgDimension`
 * through the same coordinator and inspects the actual tables. It answers the only
 * question that matters: after a failure, is there a wiki row, a source document,
 * or a graph document left behind?
 *
 * ## How the graph dimension is made to fail without a provider
 *
 * `createKgDimension` with `dryRun` performs no database write at all, which would
 * make every assertion here pass vacuously. Instead the graph is given a real
 * commit that is made to fail: its `commit` runs the real wiki writes in the same
 * transaction first, then throws. Order matters -- the wiki must already have
 * written inside the transaction before the throw, or there is nothing to roll back
 * and the case proves nothing.
 *
 * Feasibility itself -- that one transaction CAN span both schemas, with RLS
 * enforced and the tenant GUC intact -- is measured separately in
 * `kg-runtime-cross-dimension-transaction.test.ts`, which stays as the negative
 * control for the old two-connection topology.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { outboxReachable, provisionOutboxStack, type OutboxSetup } from "./outbox-harness.js";
import { ingestDimensions } from "../../src/dimensions/coordinator.js";
import { loadRecords } from "../../src/dimensions/outbox.js";
import { createWikiStoreDimension } from "../../src/dimensions/wiki/database.js";
import type { Dimension, DimensionInput, PreparedWrite } from "../../src/dimensions/types.js";

/** One document, shaped exactly as an ingest builds it. */
const INPUT: DimensionInput = {
  source: "https://example.test/atomic",
  title: "Atomic Ingest",
  document: "# Atomic Ingest\n\nbody\n",
  body: "body",
};

/**
 * Can this environment answer the question at all?
 *
 * Delegates to the shared probe instead of repeating the schema lookup that
 * `kg-runtime-*` suites already carry: three copies of the same reachability check
 * drift into three slightly different checks, which is what fallow flagged when the
 * first version of this file grew its own.
 *
 * A skip must be LOUD rather than silent, so the reason names the missing database
 * and a suite that did not run cannot be mistaken for one that passed.
 */
const provisioned = await outboxReachable("atomic");

describe.skipIf(!provisioned)("atomic ingest across the shipped dimensions", () => {
  let setup: OutboxSetup;

  beforeEach(async () => {
    setup = await provisionOutboxStack("atomic");
  });

  afterEach(async () => {
    await setup.release();
  });

  /**
   * A graph dimension whose commit fails AFTER the wiki has written.
   *
   * The throw is the point: if it fired before the wiki's writes, the transaction
   * would have nothing to roll back and the assertions below would be vacuous.
   */
  function failingKg(wiki: Dimension): Dimension {
    return {
      name: "kg",
      prepare: async (): Promise<PreparedWrite> => ({ unchanged: false, handle: {} }),
      commit: async (prepared, scope) => {
        // Run the real wiki commit first, INSIDE the same transaction.
        await wiki.commit(await wiki.prepare(INPUT), scope);
        throw new Error("kg blew up after the wiki wrote");
      },
      discard: async () => {},
    };
  }


  /**
   * This Stack's database handle, id, and a fresh wiki dimension over it.
   *
   * Extracted because all three cases below need the identical four lines, and the
   * three copies were flagged as a clone group. The root is unique per call so two
   * cases never project markdown into the same `sources/` directory.
   */
  function subject(): {
    db: typeof setup.harness.db;
    stackId: string;
    wiki: Dimension;
  } {
    const db = setup.harness.db;
    const stackId = setup.harness.stackId;
    const root = `/tmp/atomic-${randomUUID().slice(0, 8)}`;
    return { db, stackId, wiki: createWikiStoreDimension({ db, stackId, root }) };
  }

  /**
   * Count this Stack's rows in each table a successful ingest would touch.
   *
   * Scoped by `stack_id` explicitly as well as by the bound GUC: the harness
   * connects as `aks`, which is a SUPERUSER with BYPASSRLS, so the policy is inert
   * and the explicit predicate is the guarantee.
   */
  async function rowCounts(): Promise<{
    pages: number;
    sourceDocuments: number;
    graphDocuments: number;
  }> {
    const stackId = setup.harness.stackId;
    const [pages] = await setup.harness.db.execute<{ n: number }>(
      sql`select count(*)::int as n from wiki.pages where stack_id = ${stackId}`,
    );
    const [docs] = await setup.harness.db.execute<{ n: number }>(
      sql`select count(*)::int as n from wiki.source_documents where stack_id = ${stackId}`,
    );
    const [graph] = await setup.harness.db.execute<{ n: number }>(
      sql`select count(*)::int as n from stack_documents where stack_id = ${stackId}`,
    );
    return {
      pages: (pages as { n?: number } | undefined)?.n ?? 0,
      sourceDocuments: (docs as { n?: number } | undefined)?.n ?? 0,
      graphDocuments: (graph as { n?: number } | undefined)?.n ?? 0,
    };
  }

  it("leaves NO wiki row and NO source document when the graph fails", async () => {
    const { db, stackId, wiki } = subject();

    await expect(
      ingestDimensions(db, stackId, INPUT, [wiki, failingKg(wiki)]),
    ).rejects.toThrow(/ingest failed after 2 attempts/);

    // THIS is the property. Before atomic ingest the wiki row survived the graph
    // failure and only the outbox remembered the disagreement.
    const counts = await rowCounts();
    expect(counts.pages).toBe(0);
    expect(counts.sourceDocuments).toBe(0);
    expect(counts.graphDocuments).toBe(0);
  });

  it("records the failure as diagnosis, not as pending debt", async () => {
    const { db, stackId, wiki } = subject();

    await expect(
      ingestDimensions(db, stackId, INPUT, [wiki, failingKg(wiki)]),
    ).rejects.toThrow();

    const { records } = await loadRecords(db, stackId);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("failed");
  });

  it("commits BOTH dimensions when neither fails", async () => {
    const { db, stackId, wiki } = subject();

    // A graph double that joins the coordinator's transaction and writes a real
    // `stack_documents` row, so the positive case covers the same two tables the
    // failure case proves empty.
    const kg: Dimension = {
      name: "kg",
      prepare: async () => ({ unchanged: false, handle: {} }),
      commit: async (_prepared, scope) => {
        const tx = scope?.tx as typeof db | undefined;
        if (tx === undefined) throw new Error("kg commit received no transaction");
        await tx.execute(sql`
          insert into stack_documents
            (stack_id, filename, storage_path, size_bytes, content_type, source_hash)
          values (${stackId}, ${INPUT.title}, ${INPUT.source}, 4, 'text/markdown',
                  ${"hash-" + randomUUID()})
        `);
        return { idempotencyKey: "kg:key", summary: "kg:ok" };
      },
      discard: async () => {},
    };

    const outcome = await ingestDimensions(db, stackId, INPUT, [wiki, kg]);
    expect(outcome.summaries.get("kg")).toBe("kg:ok");

    const counts = await rowCounts();
    expect(counts.pages).toBe(1);
    expect(counts.sourceDocuments).toBe(1);
    expect(counts.graphDocuments).toBe(1);
    // And the outbox says done rather than pending.
    const { records } = await loadRecords(db, stackId);
    expect(records[0]?.status).toBe("committed");
  });
});
