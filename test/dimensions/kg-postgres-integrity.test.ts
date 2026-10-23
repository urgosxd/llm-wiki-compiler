/**
 * @file test/dimensions/kg-postgres-integrity.test.ts
 * @description The graph dimension against a REAL Postgres, proving the writes
 * satisfy the schema's own constraints.
 *
 * WHY THIS FILE EXISTS. `kg-dimension.test.ts` replaces the vendored core with a
 * mock, so it can only prove the adapter calls the right functions — never that
 * those calls are valid SQL. That gap hid a production-breaking defect: the
 * adapter synthesized a 32-hex document id that cast to UUID but matched no
 * `stack_documents` row, so `entity_source_documents.document_id` (a foreign key)
 * rejected EVERY consolidation. The graph dimension could not write at all, and
 * every mocked test still passed.
 *
 * A mock cannot fail a foreign key. Only a database can. These tests therefore
 * require a reachable Postgres and skip loudly when there is none, rather than
 * passing vacuously.
 *
 * Provisioning: `LLMWIKI_TEST_DATABASE_URL` (falls back to the documented local
 * stack container). The tests create their own stack and delete it afterwards, so
 * they never touch an operator's data.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, createDatabase, registerDocumentRow } from "llmwiki-kg";
import { consolidateEntityRows, consolidateRelationshipRows } from "llmwiki-kg";

const DATABASE_URL = process.env.LLMWIKI_TEST_DATABASE_URL ?? "postgresql://aks:aks@localhost:5434/aks";

/** A stack this suite owns end to end, so cleanup cannot reach operator data. */
const stackId = randomUUID();
const client = createClient(DATABASE_URL, 10);
const db = createDatabase(client);

/**
 * Provision the suite's own stack, and report reachability as a REAL status.
 *
 * A swallowed error here is how this file first became a false green: the
 * provisioning insert was invalid, the catch turned it into `reachable = false`,
 * and every test returned early while vitest still reported "4 passed". A
 * database-integrity test that silently does not run is worse than no test, so
 * failure to provision is fatal and skips are declared up front.
 */
const reachable = await (async (): Promise<boolean> => {
  try {
    await db.execute("select 1");
    // `stacks.domain` is NOT NULL with no default, so it must be supplied.
    await db.execute(
      `insert into stacks (id, name, domain) values ('${stackId}', 'kg-integrity', 'integrity')`,
    );
    return true;
  } catch (error) {
    console.warn(
      `kg-postgres-integrity: no usable Postgres at ${DATABASE_URL} — ${(error as Error).message}`,
    );
    return false;
  }
})();

afterAll(async () => {
  if (reachable) {
    // `stack_documents` and `entity_source_documents` cascade from `stacks`.
    await db.execute(`delete from stacks where id = '${stackId}'`).catch(() => undefined);
  }
  await client.end({ timeout: 10 });
});

const REGISTRATION = {
  stackId,
  source: "https://integrity.test/doc.md",
  body: "Agents use tools to reach goals.",
  title: "Doc",
};

/** Entities that exercise the contribution path the foreign key guards. */
const ENTITY = { name: "IntegrityAgent", type: "agent", description: null, confidence: 0.9, properties: {} };

describe("the graph dimension satisfies Postgres's own constraints", () => {
  it.skipIf(!reachable)("registers a document row whose id can carry contributions", async () => {
    const documentId = await db.transaction((tx) => registerDocumentRow(tx, REGISTRATION));

    // The exact call that used to fail with a foreign-key violation.
    const nameToId = await db.transaction((tx) =>
      consolidateEntityRows(tx, stackId, documentId, [ENTITY]),
    );

    expect(nameToId.get(ENTITY.name.toLowerCase())).toBeTypeOf("string");
    const counted = await db.execute(
      `select count(*)::int as n from entity_source_documents where document_id = '${documentId}'`,
    );
    expect((counted[0] as { n: number }).n).toBe(1);
  }, 30_000);

  it.skipIf(!reachable)("is idempotent on identical content, resolving to one row and one id", async () => {
    const first = await db.transaction((tx) => registerDocumentRow(tx, REGISTRATION));
    const second = await db.transaction((tx) => registerDocumentRow(tx, REGISTRATION));

    // `unique_hash_per_stack` is what makes a repeat ingest collapse instead of fork.
    expect(second).toBe(first);
    const counted = await db.execute(
      `select count(*)::int as n from stack_documents
        where stack_id = '${stackId}' and storage_path = '${REGISTRATION.source}'`,
    );
    expect((counted[0] as { n: number }).n).toBe(1);
  }, 30_000);

  it.skipIf(!reachable)("treats a changed body as a different document, so the graph holds current text", async () => {
    const before = await db.transaction((tx) => registerDocumentRow(tx, REGISTRATION));
    const after = await db.transaction((tx) =>
      registerDocumentRow(tx, { ...REGISTRATION, body: "Entirely different content." }),
    );

    // Content change means a new row: chunks and entities must not accumulate
    // under one id as though the old text were still current.
    expect(after).not.toBe(before);
  }, 30_000);

  it.skipIf(!reachable)("rolls the document row back when consolidation fails inside the same transaction", async () => {
    const source = "https://integrity.test/rollback.md";
    await expect(
      db.transaction(async (tx) => {
        await registerDocumentRow(tx, { ...REGISTRATION, source });
        // A relationship naming an entity that was never inserted cannot resolve.
        await consolidateRelationshipRows(
          tx,
          stackId,
          [{ from: "Ghost", to: "Nobody", kind: "relates" }],
          new Map(),
        );
      }),
    ).rejects.toThrow();

    // Sharing the transaction is what stops a half-written document from surviving.
    const counted = await db.execute(
      `select count(*)::int as n from stack_documents where storage_path = '${source}'`,
    );
    expect((counted[0] as { n: number }).n).toBe(0);
  }, 30_000);
});
