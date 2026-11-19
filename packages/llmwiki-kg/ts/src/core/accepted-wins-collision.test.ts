/**
 * @file packages/llmwiki-kg/ts/src/core/accepted-wins-collision.test.ts
 * @description An accepted triplet and a rejected one on one identity: ACCEPTED WINS.
 *
 * ## The rule, and why the schema forces it rather than taste
 *
 * `unique_edge_per_stack (stack_id, from_entity_id, to_entity_id, type)` — the constraint
 * the migration KEPT instead of replacing — admits ONE relationship row per identity, so a
 * rejected triplet and an accepted one naming the same subject, relation and object can
 * never both persist. Something must decide which class the surviving row carries, and
 * "whichever record was folded last" is not a decision: it lets a rejection overwrite an
 * acceptance, after which a reader cites an invalid relation as a fact the ontology
 * vouched for.
 *
 * The rule pinned here: an acceptance is never downgraded, a stored rejection is UPGRADED
 * when a later ingest admits the same identity, and a collision between two rejections
 * keeps the FIRST one so the stored reason never depends on iteration order.
 *
 * ## How it is observed
 *
 * Through the public write path only — `extractGraphFromChunks`, then the same
 * `consolidateEntityRows` / `consolidateRelationshipRows` pair the `kg` dimension calls —
 * and then by reading the three classification columns back. Chunk order is varied WITHIN
 * one ingest (the in-memory merge) and ACROSS ingests (the SQL upsert), because the rule is
 * enforced at both layers and either layer alone leaves the invariant unprotected against
 * the other writer.
 *
 * The model is replaced at ONE seam (`callTool`), because these tests are about what a
 * verdict does to a row, not about an answer a model gave.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import { afterAll, describe, expect, it, vi } from "vitest";

/** The provider seam, and the answers it will serve in call order. */
const provider = vi.hoisted(() => ({ answers: [] as unknown[] }));

vi.mock("./llm_clients.js", () => ({
  callTool: async (): Promise<string> =>
    JSON.stringify(provider.answers.shift() ?? { triplets: [] }),
}));

import { createDatabase } from "../db.js";
import { FixtureStacks } from "../routes/fixture-tenant.js";
import { withClient } from "../testing/per-run-database.js";
import { suiteDatabase } from "../testing/suite-database.js";
import {
  consolidateEntityRows,
  consolidateRelationshipRows,
  registerDocumentRow,
} from "./document-consolidation.js";
import type { ChunkResult } from "./extraction.js";
import { extractGraphFromChunks } from "./graph-extraction.js";
import type { Ontology } from "./ontology.js";
import { validateOntology } from "./ontology.js";

/** This process's database, and the gate for every block below. */
const probe = await suiteDatabase("Collision order needs a Postgres database.");

/** The declaration every case is measured against: one constrained relationship. */
const DECLARED = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
  relationships: [{ type: "EMPLOYS", domains: ["COMPANY"], ranges: ["PERSON"] }],
});

/** One triplet in the shape the tool call returns. */
interface TripletShape {
  readonly subject: { readonly type: string; readonly name: string };
  readonly relation: { readonly type: string };
  readonly object: { readonly type: string; readonly name: string };
}

/** One triplet about the same two names, so only the types and the way differ. */
function tripletOf(subjectType: string, relation: string, objectType: string): TripletShape {
  return {
    subject: { type: subjectType, name: "Acme" },
    relation: { type: relation },
    object: { type: objectType, name: "Ada" },
  };
}

/** One model answer carrying the given triplets, in the order given. */
function answer(...triplets: readonly TripletShape[]): unknown {
  return { triplets };
}

/** Admitted: both endpoints inside the constraint. */
const ADMITTED = answer(tripletOf("COMPANY", "EMPLOYS", "PERSON"));
/** Refused: the subject type is outside `EMPLOYS`'s domain. */
const SUBJECT_OUT_OF_DOMAIN = answer(tripletOf("PERSON", "EMPLOYS", "PERSON"));
/** Refused: the object type is outside `EMPLOYS`'s range. */
const OBJECT_OUT_OF_RANGE = answer(tripletOf("COMPANY", "EMPLOYS", "COMPANY"));
/** Refused: nothing is wrong with the verb, the subject type is undeclared. */
const UNDECLARED_ENTITY = answer(tripletOf("ALIEN_CONSTRUCT", "EMPLOYS", "PERSON"));

/** A stored relationship, by the three columns a reader filters on. */
type EdgeRow = {
  type: string;
  verdict: string;
  reason: string | null;
  offending: string | null;
};

/** A stored node, by the same three columns plus the type its row ended with. */
type EntityRow = {
  name: string;
  type: string;
  verdict: string;
  reason: string | null;
  offending: string | null;
};

/** The one edge an acceptance leaves behind: no reason, nothing refused. */
const ACCEPTED_EMPLOYS: EdgeRow = {
  type: "EMPLOYS",
  verdict: "accepted",
  reason: null,
  offending: null,
};

/** The one edge a refusal for `reason` leaves behind, with what was refused. */
function rejectedEmploys(reason: string, offending: string): EdgeRow {
  return { type: "EMPLOYS", verdict: "rejected", reason, offending };
}

/** Every relationship row of `stackId`, ordered so one row is a stable assertion. */
async function edgeRows(tx: DatabaseHandle, stackId: string): Promise<EdgeRow[]> {
  return await tx.execute<EdgeRow>(sql`
    select type, ontology_verdict as verdict,
           ontology_rejection_reason as reason, ontology_offending_type as offending
    from ontology_relationships
    where stack_id = ${stackId}
    order by type, ontology_offending_type
  `);
}

/** Every entity row of `stackId`, in name order. */
async function entityRows(tx: DatabaseHandle, stackId: string): Promise<EntityRow[]> {
  return await tx.execute<EntityRow>(sql`
    select name, type, ontology_verdict as verdict,
           ontology_rejection_reason as reason, ontology_offending_type as offending
    from ontology_entities
    where stack_id = ${stackId}
    order by name
  `);
}

/** The fixture Stacks this file created, dropped before it ends. */
const stacks = new FixtureStacks();

/** One Stack to write into, so no two cases can read each other's rows. */
async function newStack(): Promise<string> {
  const stackId = randomUUID();
  await withClient(probe.url, async (client) => {
    await createDatabase(client).transaction(async (tx) => {
      await tx.execute(sql`
        insert into stacks (id, name, domain)
        values (${stackId}, ${`aw-${stackId.slice(0, 8)}`}, ${`aw-${stackId.slice(0, 8)}`})
      `);
    });
  });
  stacks.add(stackId);
  return stackId;
}

/** One chunk per answer, so a multi-answer ingest is a multi-chunk document. */
function chunkAt(index: number): ChunkResult {
  return {
    documentId: "11111111-1111-4111-8111-111111111111",
    stackId: "22222222-2222-4222-8222-222222222222",
    chunkIndex: index,
    content: `Acme employs Ada, mention ${String(index)}.`,
    contentHash: String(index + 1).repeat(64),
    tokenCount: 16,
    embedding: [0, 1],
    chunkerStrategy: "sentence",
  };
}

/** Extracts one document of `answers` chunks and consolidates it into `stackId`. */
async function ingest(
  stackId: string,
  source: string,
  ontology: Ontology,
  ...answers: readonly unknown[]
): Promise<void> {
  provider.answers.push(...answers);
  const chunks = answers.map((_ignored, index) => chunkAt(index));
  const extraction = await extractGraphFromChunks(chunks, "aw-stack", ontology);
  await withClient(probe.url, async (client) => {
    await createDatabase(client).transaction(async (tx) => {
      const documentId = await registerDocumentRow(tx, {
        stackId,
        source,
        body: `the body ${source} carries Acme and Ada`,
        title: `${source}.txt`,
      });
      const nameToId = await consolidateEntityRows(tx, stackId, documentId, extraction.entities);
      await consolidateRelationshipRows(tx, stackId, extraction.relationships, nameToId);
    });
  });
}

/** What the graph of `stackId` holds now, by class. */
async function readGraph(
  stackId: string,
): Promise<{ entities: EntityRow[]; edges: EdgeRow[] }> {
  return await withClient(probe.url, async (client) =>
    createDatabase(client).transaction(async (tx) => ({
      entities: await entityRows(tx, stackId),
      edges: await edgeRows(tx, stackId),
    })),
  );
}

describe.skipIf(probe.skipReason !== false)("a rejection colliding with an acceptance", () => {
  afterAll(async () => {
    await withClient(probe.url, (client) => stacks.deleteAll(createDatabase(client)));
  });

  it("keeps the acceptance when the admitted chunk is folded first", async () => {
    const stackId = await newStack();
    await ingest(stackId, "admitted-then-refused", DECLARED, ADMITTED, SUBJECT_OUT_OF_DOMAIN);

    expect((await readGraph(stackId)).edges).toEqual([ACCEPTED_EMPLOYS]);
  });

  it("keeps the acceptance when the refused chunk is folded first", async () => {
    // The order that used to decide the row: the refusal is folded first, so a
    // first-writer-wins merge stored it and the acceptance never reached a row.
    const stackId = await newStack();
    await ingest(stackId, "refused-then-admitted", DECLARED, SUBJECT_OUT_OF_DOMAIN, ADMITTED);

    expect((await readGraph(stackId)).edges).toEqual([ACCEPTED_EMPLOYS]);
  });

  it("keeps the acceptance across a later ingest that refuses the identity", async () => {
    const stackId = await newStack();
    await ingest(stackId, "first-pass", DECLARED, ADMITTED);
    await ingest(stackId, "second-pass", DECLARED, SUBJECT_OUT_OF_DOMAIN);

    expect((await readGraph(stackId)).edges).toEqual([ACCEPTED_EMPLOYS]);
  });

  it("upgrades a stored rejection across a later ingest that admits it", async () => {
    // The other half of the rule: a refusal is not permanent. The reason and the
    // refused type are cleared WITH the verdict, never left beside it.
    const stackId = await newStack();
    await ingest(stackId, "first-pass", DECLARED, OBJECT_OUT_OF_RANGE);
    expect((await readGraph(stackId)).edges).toEqual([
      rejectedEmploys("OBJECT_TYPE_NOT_IN_RANGE", "COMPANY"),
    ]);

    await ingest(stackId, "second-pass", DECLARED, ADMITTED);

    expect((await readGraph(stackId)).edges).toEqual([ACCEPTED_EMPLOYS]);
  });
});

describe.skipIf(probe.skipReason !== false)("two rejections on one identity", () => {
  it("collapse to one row, the first refusal deciding the reason", async () => {
    // Two different refusals, one identity. `unique_edge_per_stack` admits one row, so
    // the survivor must be the FIRST refusal the document produced -- not whichever
    // record a Map happened to yield -- and its reason must satisfy the equivalence
    // CHECK, which a `rejected` row with no reason does not.
    const stackId = await newStack();
    await ingest(
      stackId,
      "two-refusals",
      DECLARED,
      answer(tripletOf("PERSON", "EMPLOYS", "PERSON"), tripletOf("COMPANY", "EMPLOYS", "COMPANY")),
    );

    expect((await readGraph(stackId)).edges).toEqual([
      rejectedEmploys("SUBJECT_TYPE_NOT_IN_DOMAIN", "PERSON"),
    ]);
  });
});

describe.skipIf(probe.skipReason !== false)("an entity row", () => {
  it("is upgraded to accepted by a later ingest that admits it", async () => {
    const stackId = await newStack();
    await ingest(stackId, "first-pass", DECLARED, UNDECLARED_ENTITY);
    expect((await readGraph(stackId)).entities).toContainEqual({
      name: "Acme",
      type: "ALIEN_CONSTRUCT",
      verdict: "rejected",
      reason: "UNKNOWN_ENTITY_TYPE",
      offending: "ALIEN_CONSTRUCT",
    });

    await ingest(stackId, "second-pass", DECLARED, ADMITTED);

    // The admitted type replaces the refused one: an accepted row carrying an
    // undeclared type would be a row no reader could tell from garbage.
    expect((await readGraph(stackId)).entities).toContainEqual({
      name: "Acme",
      type: "COMPANY",
      verdict: "accepted",
      reason: null,
      offending: null,
    });
  });

  it("is never downgraded by a later ingest that refuses it", async () => {
    const stackId = await newStack();
    await ingest(stackId, "first-pass", DECLARED, ADMITTED);
    await ingest(stackId, "second-pass", DECLARED, UNDECLARED_ENTITY);

    expect((await readGraph(stackId)).entities).toContainEqual({
      name: "Acme",
      type: "COMPANY",
      verdict: "accepted",
      reason: null,
      offending: null,
    });
  });
});

describe.skipIf(probe.skipReason !== false)("an admitted edge re-ingested", () => {
  it("stays the one accepted row it already was", async () => {
    // PRESERVE. The upsert this rule is added to: a re-ingest of the same identity must
    // still raise confidence in place, keep the row single, and leave the class alone.
    const stackId = await newStack();
    await ingest(stackId, "first-pass", DECLARED, ADMITTED);
    await ingest(stackId, "second-pass", DECLARED, ADMITTED);

    expect((await readGraph(stackId)).edges).toEqual([ACCEPTED_EMPLOYS]);
  });
});
