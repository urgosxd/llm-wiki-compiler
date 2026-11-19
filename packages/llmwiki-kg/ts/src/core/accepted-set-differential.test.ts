/**
 * @file packages/llmwiki-kg/ts/src/core/accepted-set-differential.test.ts
 * @description For ONE fixed input, the ACCEPTED half of the graph is exactly what it was
 * before this feature, and the rejected triplets are now rows instead of a counter (spec S9).
 *
 * ## Why this file exists beside `rejected-triplet-persistence.test.ts`
 *
 * That file proves the rejected rows exist and carry their reason, and its S9 case compares
 * accepted EDGE ROWS — type, class, reason — but reads no endpoint, so "the same endpoints"
 * was asserted by nobody. The classifier is untouched by this feature and the claim under
 * test is the differential itself, so this file states both halves as full tuples: every
 * accepted entity as (name, type), every accepted edge as (type, from, to), and then the
 * rejected rows beside them. The expected values are literals, which is the whole point:
 * a value recomputed from the same code would agree with a change that moved the graph.
 *
 * Observed through the public write path only — `extractGraphFromChunks` then the same
 * `consolidateEntityRows` / `consolidateRelationshipRows` pair the `kg` dimension calls —
 * so a refactor that keeps the contract keeps this green.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import { afterAll, describe, expect, it, vi } from "vitest";

/** The provider seam, serving the one answer this file's input needs. */
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
import { validateOntology } from "./ontology.js";

/** This process's database, and the gate for the block below. */
const probe = await suiteDatabase("The accepted-set differential needs a Postgres database.");

/** The declaration the input is measured against: one constrained relationship. */
const DECLARED = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
  relationships: [{ type: "EMPLOYS", domains: ["COMPANY"], ranges: ["PERSON"] }],
});

/** The one chunk the input arrives in. */
const CHUNK: ChunkResult = {
  documentId: "33333333-3333-4333-8333-333333333333",
  stackId: "44444444-4444-4444-8444-444444444444",
  chunkIndex: 0,
  content: "Acme employs Ada. Globex partners with Initech. Umbrella employs Ada.",
  contentHash: "2".repeat(64),
  tokenCount: 24,
  embedding: [0, 1],
  chunkerStrategy: "sentence",
};

/**
 * The fixed input: one triplet the ontology accepts, one whose verb it refuses, and one
 * whose subject type it refuses. All three in a single extraction, so one run answers both
 * halves of the differential.
 */
const INPUT = {
  triplets: [
    {
      subject: { type: "COMPANY", name: "Acme" },
      relation: { type: "EMPLOYS" },
      object: { type: "PERSON", name: "Ada" },
    },
    {
      subject: { type: "COMPANY", name: "Globex" },
      relation: { type: "PARTNERS_WITH" },
      object: { type: "COMPANY", name: "Initech" },
    },
    {
      subject: { type: "ALIEN_CONSTRUCT", name: "Umbrella" },
      relation: { type: "EMPLOYS" },
      object: { type: "PERSON", name: "Ada" },
    },
  ],
};

/** An edge as a reader sees it: its verb and both endpoint names, plus its class. */
type EdgeTuple = { type: string; from: string; to: string; verdict: string };

/** An entity as a reader sees it: its name and its type, plus its class. */
type EntityTuple = { name: string; type: string; verdict: string };

/** The fixture Stacks this file created, dropped before it ends. */
const stacks = new FixtureStacks();

/** The rows one extraction under {@link DECLARED} left in the graph, endpoints included. */
async function writeInput(): Promise<{ entities: EntityTuple[]; edges: EdgeTuple[] }> {
  provider.answers.push(INPUT);
  const extraction = await extractGraphFromChunks([CHUNK], "dif-stack", DECLARED);
  return await withClient(probe.url, async (client) => {
    const db = createDatabase(client);
    return await db.transaction(async (tx) => {
      const stackId = randomUUID();
      await tx.execute(sql`
        insert into stacks (id, name, domain)
        values (${stackId}, ${`dif-${stackId.slice(0, 8)}`}, ${`dif-${stackId.slice(0, 8)}`})
      `);
      stacks.add(stackId);
      const documentId = await registerDocumentRow(tx, {
        stackId,
        source: `src-${stackId}`,
        body: "Acme employs Ada.",
        title: "fixture.txt",
      });
      const nameToId = await consolidateEntityRows(tx, stackId, documentId, extraction.entities);
      await consolidateRelationshipRows(tx, stackId, extraction.relationships, nameToId);
      return { entities: await entityTuples(tx, stackId), edges: await edgeTuples(tx, stackId) };
    });
  });
}

/** Every entity of `stackId` as a reader sees it, in a stable order. */
async function entityTuples(tx: DatabaseHandle, stackId: string): Promise<EntityTuple[]> {
  return await tx.execute<EntityTuple>(sql`
    select name, type, ontology_verdict as verdict
    from ontology_entities where stack_id = ${stackId} order by name
  `);
}

/** Every edge of `stackId` with both endpoint names, in a stable order. */
async function edgeTuples(tx: DatabaseHandle, stackId: string): Promise<EdgeTuple[]> {
  return await tx.execute<EdgeTuple>(sql`
    select relationship.type as type, source.name as from, target.name as to,
           relationship.ontology_verdict as verdict
    from ontology_relationships relationship
    join ontology_entities source on source.id = relationship.from_entity_id
    join ontology_entities target on target.id = relationship.to_entity_id
    where relationship.stack_id = ${stackId}
    order by relationship.type, source.name, target.name
  `);
}

describe.skipIf(probe.skipReason !== false)("the accepted set of one fixed input", () => {
  afterAll(async () => {
    await withClient(probe.url, (client) => stacks.deleteAll(createDatabase(client)));
  });

  it("is identical to the survivors-only graph, and the rejected rows are now present", async () => {
    const { entities, edges } = await writeInput();
    const accepted = (tuple: { verdict: string }): boolean => tuple.verdict === "accepted";
    const rejected = (tuple: { verdict: string }): boolean => tuple.verdict === "rejected";

    // Half one: the ACCEPTED graph, as literals — names, types and endpoints, nothing else.
    expect(entities.filter(accepted).map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "Acme", type: "COMPANY" },
      { name: "Ada", type: "PERSON" },
      { name: "Globex", type: "COMPANY" },
      { name: "Initech", type: "COMPANY" },
    ]);
    expect(edges.filter(accepted).map(({ type, from, to }) => ({ type, from, to }))).toEqual([
      { type: "EMPLOYS", from: "Acme", to: "Ada" },
    ]);

    // Half two: what used to be a count and nothing else is a row, endpoints included.
    expect(entities.filter(rejected).map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "Umbrella", type: "ALIEN_CONSTRUCT" },
    ]);
    expect(edges.filter(rejected).map(({ type, from, to }) => ({ type, from, to }))).toEqual([
      { type: "EMPLOYS", from: "Umbrella", to: "Ada" },
      { type: "PARTNERS_WITH", from: "Globex", to: "Initech" },
    ]);
  }, 60_000);
});
