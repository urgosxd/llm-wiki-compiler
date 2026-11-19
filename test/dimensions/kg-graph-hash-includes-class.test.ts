/**
 * @file test/dimensions/kg-graph-hash-includes-class.test.ts
 * @description The graph hash covers rows of BOTH classes, and covers identities rather
 * than classes (spec S8).
 *
 * ## What is true, measured
 *
 * `graphHashFor` discovers entities with `select name, type ... where stack_id = ?` and
 * relationships with a join filtered by `relationship.stack_id` alone: neither query has a
 * class predicate, so a rejected row is inside the hash exactly like an accepted one. What
 * the digest is taken OVER, however, is identity only — `(name, type)` and
 * `(from, type, to)` — so the `ontology_verdict` column is not part of the canonical form.
 * Both facts are load-bearing here, and they point in opposite directions:
 *
 *  - Flipping a row's class on an unchanged identity CANNOT move the digest, and a test
 *    demanding that it does would be asserting a shape this instrument does not have;
 *  - a `where ontology_verdict = 'accepted'` added to either query WOULD change the graph
 *    the digest describes, silently narrowing the baseline to half the rows.
 *
 * So the pin is the second fact, from both directions: with every row rejected the digest is
 * still the digest of those rows (a filter would report the empty graph instead), and each
 * newly WRITTEN rejected row must move it (a filter would ignore the row entirely).
 */
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { graphHashFor } from "../fixtures/kg-ingest-measure.js";

const harness = await createKgPostgresHarness("kg-graph-hash-class");
const { db, stackId, reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

/** Insert one entity row and return its id; `verdict` decides which class it lands in. */
async function addEntity(name: string, type: string, verdict: string): Promise<string> {
  const rejection = verdict === "accepted" ? "null, null" : `'UNKNOWN_ENTITY_TYPE', '${type}'`;
  const rows = await db.execute<{ id: string }>(
    `insert into ontology_entities
       (stack_id, name, type, ontology_verdict, ontology_rejection_reason, ontology_offending_type)
     values ('${stackId}', '${name}', '${type}', '${verdict}', ${rejection}) returning id`,
  );
  return rows[0]?.id ?? "";
}

/** Insert one edge row between two entity ids. */
async function addEdge(from: string, to: string, type: string, verdict: string): Promise<void> {
  const rejection = verdict === "accepted" ? "null, null" : `'UNKNOWN_RELATIONSHIP_TYPE', '${type}'`;
  await db.execute(
    `insert into ontology_relationships
       (stack_id, from_entity_id, to_entity_id, type,
        ontology_verdict, ontology_rejection_reason, ontology_offending_type)
     values ('${stackId}', '${from}', '${to}', '${type}', '${verdict}', ${rejection})`,
  );
}

describe.skipIf(!reachable)("the graph hash", () => {
  it("covers rejected rows, and its canonical form is the identities", async () => {
    const acme = await addEntity("Acme", "COMPANY", "accepted");
    const ada = await addEntity("Ada", "PERSON", "accepted");
    await addEdge(acme, ada, "EMPLOYS", "accepted");
    const accepted = await graphHashFor(db, stackId);

    // Every row of this Stack is now rejected, with the same identities as before. The
    // digest must be UNCHANGED: a class predicate on either discovery query would hash the
    // empty graph here and this line would fail — which is the whole reason it exists.
    await db.execute(
      `update ontology_entities set ontology_verdict = 'rejected',
              ontology_rejection_reason = 'UNKNOWN_ENTITY_TYPE',
              ontology_offending_type = type
        where stack_id = '${stackId}'`,
    );
    await db.execute(
      `update ontology_relationships set ontology_verdict = 'rejected',
              ontology_rejection_reason = 'UNKNOWN_RELATIONSHIP_TYPE',
              ontology_offending_type = type
        where stack_id = '${stackId}'`,
    );
    expect(await graphHashFor(db, stackId)).toBe(accepted);

    // A rejected ENTITY row is a row: writing one moves the digest.
    const umbrella = await addEntity("Umbrella", "ALIEN_CONSTRUCT", "rejected");
    const withRejectedEntity = await graphHashFor(db, stackId);
    expect(withRejectedEntity).not.toBe(accepted);

    // And so is a rejected EDGE row.
    await addEdge(umbrella, ada, "EMPLOYS", "rejected");
    expect(await graphHashFor(db, stackId)).not.toBe(withRejectedEntity);
  });
});
