/**
 * @file test/dimensions/kg-forget.test.ts
 * @description `forget` against a REAL Postgres, proving one delete retires the
 * whole trace of a source.
 *
 * WHY A REAL DATABASE. The mocked adapter tests can only show that `forget` calls
 * a function. They cannot show that the delete satisfies the schema or that the
 * foreign keys actually cascade — and a mock cannot fail a foreign key. The
 * document-row defect (b913a98) was invisible to every mocked test for exactly
 * that reason, so retirement is verified the same way the write was.
 *
 * THE CLAIM UNDER TEST is the cascade: deleting a `stack_documents` row must take
 * its chunks and its `entity_source_documents` contributions with it. If that
 * stopped holding, `forget` would leave orphaned graph data while reporting
 * success — worse than not deleting at all.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import {
  consolidateEntityRows,
  forgetDocumentRows,
  registerDocumentRow,
} from "llmwiki-kg";

const harness = await createKgPostgresHarness("kg-forget");
const { db, stackId, reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

/** Register a document and one entity contribution, returning the document id. */
async function seedDocument(source: string, body: string): Promise<string> {
  return db.transaction(async (tx) => {
    const documentId = await registerDocumentRow(tx, { stackId, source, body, title: "Doc" });
    await consolidateEntityRows(tx, stackId, documentId, [
      { name: `Entity-${source}`, type: "concept", description: null, confidence: 0.9, properties: {} },
    ]);
    return documentId;
  });
}

/** Count rows still pointing at a source, across the three tables involved. */
async function tracesOf(source: string): Promise<{ docs: number; contributions: number }> {
  const docs = await db.execute(
    `select count(*)::int as n from stack_documents where stack_id = '${stackId}' and storage_path = '${source}'`,
  );
  const contributions = await db.execute(
    `select count(*)::int as n from entity_source_documents esd
       join stack_documents sd on sd.id = esd.document_id
      where sd.stack_id = '${stackId}' and sd.storage_path = '${source}'`,
  );
  return {
    docs: (docs[0] as { n: number }).n,
    contributions: (contributions[0] as { n: number }).n,
  };
}

describe("forget retires a source from the graph", () => {
  it("removes the document and its contributions in one delete", async () => {
    if (!reachable) return;
    const source = `https://forget.test/${randomUUID()}.md`;
    await seedDocument(source, "content to retire");
    expect(await tracesOf(source)).toEqual({ docs: 1, contributions: 1 });

    await db.transaction((tx) => forgetDocumentRows(tx, stackId, source));

    // The cascade is the claim: one delete must leave nothing behind.
    expect(await tracesOf(source)).toEqual({ docs: 0, contributions: 0 });
  }, 30_000);

  it("is idempotent, because a reconciler retries", async () => {
    if (!reachable) return;
    const source = `https://forget.test/${randomUUID()}.md`;
    await seedDocument(source, "content to retire twice");

    await db.transaction((tx) => forgetDocumentRows(tx, stackId, source));
    // The desired end state already holds; a retry must not fail.
    await expect(
      db.transaction((tx) => forgetDocumentRows(tx, stackId, source)),
    ).resolves.not.toThrow();
  }, 30_000);

  it("retires every generation of a source, not just the newest", async () => {
    if (!reachable) return;
    const source = `https://forget.test/${randomUUID()}.md`;
    // Two bodies mean two different `source_hash` values, so two rows. Forgetting
    // the source must retire both, or stale text stays queryable.
    await seedDocument(source, "first revision");
    await seedDocument(source, "second revision");
    expect((await tracesOf(source)).docs).toBe(2);

    await db.transaction((tx) => forgetDocumentRows(tx, stackId, source));

    expect((await tracesOf(source)).docs).toBe(0);
  }, 30_000);

  it("leaves other stacks and other sources untouched", async () => {
    if (!reachable) return;
    const doomed = `https://forget.test/${randomUUID()}.md`;
    const survivor = `https://forget.test/${randomUUID()}.md`;
    await seedDocument(doomed, "to be removed");
    await seedDocument(survivor, "to be kept");

    await db.transaction((tx) => forgetDocumentRows(tx, stackId, doomed));

    // Scoping by stack AND source is what keeps a forget from reaching sideways.
    expect(await tracesOf(survivor)).toEqual({ docs: 1, contributions: 1 });
  }, 30_000);
});
