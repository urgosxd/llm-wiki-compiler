/**
 * @file packages/llmwiki-kg/ts/src/core/rejected-triplet-persistence.test.ts
 * @description A triplet the ontology turns away is STORED, carrying its class.
 *
 * ## Why this file exists
 *
 * The classifier has always reported what it refused, but the row set was built from
 * the survivors alone, so the verdict stopped at a counter: the graph kept nothing and
 * an operator could not tell which source claimed what. Under the two-class model a
 * rejected triplet is written like any other row, with `ontology_verdict = 'rejected'`,
 * its SPECIFIC reason and the type that was refused, so a reader can filter, count and
 * join on the class instead of parsing prose.
 *
 * ## How it is observed
 *
 * Through the public write path — `extractGraphFromChunks`, then the same
 * `consolidateEntityRows` / `consolidateRelationshipRows` pair the `kg` dimension
 * calls — against this process's own Postgres database, and then by reading the three
 * classification columns back. No private helper is called and no internal shape is
 * asserted, so a refactor that keeps the contract keeps these tests green.
 *
 * The model is replaced at ONE seam (`callTool`), because these tests are about the
 * rows a verdict produces and not about an answer a model gave.
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
import { validateOntology } from "./ontology.js";
import type { Ontology } from "./ontology.js";

/** This process's database, and the gate for every block below. */
const probe = await suiteDatabase(
  "Rejected-triplet persistence needs a Postgres database.",
);

/** The one chunk every case extracts, so a run costs exactly one model answer. */
const CHUNK: ChunkResult = {
  documentId: "11111111-1111-4111-8111-111111111111",
  stackId: "22222222-2222-4222-8222-222222222222",
  chunkIndex: 0,
  content: "Acme employs Ada.",
  contentHash: "1".repeat(64),
  tokenCount: 16,
  embedding: [0, 1],
  chunkerStrategy: "sentence",
};

/** The declaration every case is measured against: one constrained relationship. */
const DECLARED = validateOntology({
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
  relationships: [{ type: "EMPLOYS", domains: ["COMPANY"], ranges: ["PERSON"] }],
});

/** The reconciled entities and edges this process's Stack now holds, by class. */
type EntityRow = {
  name: string;
  type: string;
  verdict: string;
  reason: string | null;
  offending: string | null;
};

type EdgeRow = {
  type: string;
  verdict: string;
  reason: string | null;
  offending: string | null;
};

/** One triplet payload in the shape the tool call returns. */
function payload(subjectType: string, relation: string, objectType: string): unknown {
  return {
    triplets: [
      {
        subject: { type: subjectType, name: "Acme" },
        relation: { type: relation },
        object: { type: objectType, name: "Ada" },
      },
    ],
  };
}

/** The row an admitted edge produces: no reason, nothing refused. */
function acceptedEdge(type: string): EdgeRow {
  return { type, verdict: "accepted", reason: null, offending: null };
}

/** The row a refused edge produces: its own reason, and what was refused. */
function rejectedEdge(type: string, reason: string, offending: string): EdgeRow {
  return { type, verdict: "rejected", reason, offending };
}

/** The row an admitted node produces. */
function acceptedEntity(name: string, type: string): EntityRow {
  return { name, type, verdict: "accepted", reason: null, offending: null };
}

/** The row a refused node produces: the refused type is kept ON the row. */
function rejectedEntity(name: string, type: string, reason: string): EntityRow {
  return { name, type, verdict: "rejected", reason, offending: type };
}

/** Every entity row of `stackId`, in name order, with its classification columns. */
async function entityRows(tx: DatabaseHandle, stackId: string): Promise<EntityRow[]> {
  return await tx.execute<EntityRow>(sql`
    select name, type, ontology_verdict as verdict,
           ontology_rejection_reason as reason, ontology_offending_type as offending
    from ontology_entities
    where stack_id = ${stackId}
    order by name
  `);
}

/** Every relationship row of `stackId`, in type order, with its classification columns. */
async function edgeRows(tx: DatabaseHandle, stackId: string): Promise<EdgeRow[]> {
  return await tx.execute<EdgeRow>(sql`
    select type, ontology_verdict as verdict,
           ontology_rejection_reason as reason, ontology_offending_type as offending
    from ontology_relationships
    where stack_id = ${stackId}
    order by type
  `);
}

/** The fixture Stacks this file created, dropped before it ends. */
const stacks = new FixtureStacks();

/** One Stack to write into, so no two cases can read each other's rows. */
async function newStack(tx: DatabaseHandle): Promise<string> {
  const stackId = randomUUID();
  await tx.execute(sql`
    insert into stacks (id, name, domain)
    values (${stackId}, ${`rej-${stackId.slice(0, 8)}`}, ${`rej-${stackId.slice(0, 8)}`})
  `);
  stacks.add(stackId);
  return stackId;
}

/** What one extraction under `ontology` left in the graph, read back by column. */
async function writeGraph(
  payloadValue: unknown,
  ontology: Ontology,
): Promise<{ entities: EntityRow[]; edges: EdgeRow[] }> {
  provider.answers.push(payloadValue);
  const extraction = await extractGraphFromChunks([CHUNK], "rej-stack", ontology);
  return await withClient(probe.url, async (client) => {
    const db = createDatabase(client);
    return await db.transaction(async (tx) => {
      const stackId = await newStack(tx);
      const documentId = await registerDocumentRow(tx, {
        stackId,
        source: `src-${stackId}`,
        body: "Acme employs Ada.",
        title: "fixture.txt",
      });
      const nameToId = await consolidateEntityRows(tx, stackId, documentId, extraction.entities);
      await consolidateRelationshipRows(tx, stackId, extraction.relationships, nameToId);
      return { entities: await entityRows(tx, stackId), edges: await edgeRows(tx, stackId) };
    });
  });
}

/** One payload per rejection reason, and the reason each must land on the row. */
const REASON_CASES: readonly { readonly reason: string; readonly triplet: unknown }[] = [
  {
    reason: "UNKNOWN_ENTITY_TYPE",
    triplet: payload("ALIEN_CONSTRUCT", "EMPLOYS", "PERSON"),
  },
  {
    reason: "UNKNOWN_RELATIONSHIP_TYPE",
    triplet: payload("COMPANY", "PARTNERS_WITH", "PERSON"),
  },
  {
    reason: "SUBJECT_TYPE_NOT_IN_DOMAIN",
    triplet: payload("PERSON", "EMPLOYS", "PERSON"),
  },
  {
    reason: "OBJECT_TYPE_NOT_IN_RANGE",
    triplet: payload("COMPANY", "EMPLOYS", "COMPANY"),
  },
];

describe.skipIf(probe.skipReason !== false)("a rejected triplet", () => {
  afterAll(async () => {
    await withClient(probe.url, (client) => stacks.deleteAll(createDatabase(client)));
  });

  it("is written as a relationship row carrying its SPECIFIC reason", async () => {
    // `PARTNERS_WITH` is not declared, so only the verb is at fault: the edge is
    // stored as rejected with that reason, and both endpoints — about which nothing
    // was found wrong — stay accepted nodes.
    const { entities, edges } = await writeGraph(
      payload("COMPANY", "PARTNERS_WITH", "COMPANY"),
      DECLARED,
    );

    expect(edges).toEqual([
      rejectedEdge("PARTNERS_WITH", "UNKNOWN_RELATIONSHIP_TYPE", "PARTNERS_WITH"),
    ]);
    expect(entities).toEqual([
      acceptedEntity("Acme", "COMPANY"),
      acceptedEntity("Ada", "COMPANY"),
    ]);
  });

  it("writes entity rows for an undeclared entity type, the offending end rejected", async () => {
    // The shape that changes most. Today this triplet stores NOTHING — no edge and no
    // node — because an undeclared entity type read as "there is nothing to keep".
    // Now the refused type is retained on the row that carries the verdict.
    const { entities, edges } = await writeGraph(
      payload("ALIEN_CONSTRUCT", "EMPLOYS", "PERSON"),
      DECLARED,
    );

    expect(entities).toEqual([
      rejectedEntity("Acme", "ALIEN_CONSTRUCT", "UNKNOWN_ENTITY_TYPE"),
      acceptedEntity("Ada", "PERSON"),
    ]);
    expect(edges).toEqual([rejectedEdge("EMPLOYS", "UNKNOWN_ENTITY_TYPE", "ALIEN_CONSTRUCT")]);
  });
});

describe.skipIf(probe.skipReason !== false)("an admitted triplet", () => {
  it("still writes accepted rows when nothing is rejected", async () => {
    // PRESERVE. The previous behaviour of the write path this change shares: an
    // admitted triplet keeps producing one accepted edge, two accepted nodes, and no
    // reason on either.
    const { entities, edges } = await writeGraph(
      payload("COMPANY", "EMPLOYS", "PERSON"),
      DECLARED,
    );

    expect(edges).toEqual([acceptedEdge("EMPLOYS")]);
    expect(entities).toEqual([
      acceptedEntity("Acme", "COMPANY"),
      acceptedEntity("Ada", "PERSON"),
    ]);
  });
});

describe.skipIf(probe.skipReason !== false)("the two classes", () => {
  it("carries its own literal reason, one case per reason", async () => {
    // The whole point of two classes: the row says WHY, so a reader can count
    // rejections by cause. A boolean, or the string "rejected", would answer nothing.
    const observed: (string | null | undefined)[] = [];
    for (const testCase of REASON_CASES) {
      const { edges } = await writeGraph(testCase.triplet, DECLARED);
      expect(edges.map((edge) => edge.verdict)).toEqual(["rejected"]);
      observed.push(edges[0]?.reason);
    }

    expect(observed).toEqual(REASON_CASES.map((testCase) => testCase.reason));
  });
});

describe.skipIf(probe.skipReason !== false)("the accepted set of one document", () => {
  it("is identical, and only the rejected rows are new", async () => {
    // The S9 differential, both halves in one place. The classifier is untouched, so
    // the admitted rows for this input must be exactly what the survivors-only path
    // produced, while the rejected triplet stops being absent.
    const { entities, edges } = await writeGraph(
      {
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
        ],
      },
      DECLARED,
    );

    expect(edges.filter((edge) => edge.verdict === "accepted")).toEqual([acceptedEdge("EMPLOYS")]);
    expect(entities.filter((entity) => entity.verdict === "accepted")).toEqual([
      acceptedEntity("Acme", "COMPANY"),
      acceptedEntity("Ada", "PERSON"),
      acceptedEntity("Globex", "COMPANY"),
      acceptedEntity("Initech", "COMPANY"),
    ]);
    expect(edges.filter((edge) => edge.verdict === "rejected")).toEqual([
      rejectedEdge("PARTNERS_WITH", "UNKNOWN_RELATIONSHIP_TYPE", "PARTNERS_WITH"),
    ]);
  });
});
