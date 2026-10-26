/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-formation.test.ts
 * @description Entities and relationships are actually FORMED: the rows exist,
 * carry their provenance, and point at each other correctly.
 *
 * ## Why this is separate from the AKS end-to-end file
 *
 * `ingest-ontology-e2e.test.ts` asks the query surface what is *reachable*. That
 * is the caller's view, and it is the view that matters — but it cannot tell a
 * correctly formed entity from one that merely made it into a list. A row with a
 * null `extracted_by_model`, an edge pointing at another Stack's entity, or a
 * contribution record attributing it to the wrong document would all be invisible
 * from `GET /aks/v1/entities`.
 *
 * So this file asserts the storage layer directly, and only about **formation**:
 * did an entity row appear, did a relationship row appear, do the ids line up, and
 * is the provenance honest. It deliberately asserts nothing about whether those
 * entities are *good* — no duplicate scores, no staleness, no quality
 * classification, no recommendation. Those are the spec's quality audit, this
 * package does not implement it, and this file must not imply otherwise.
 *
 * ## The invariant that matters most
 *
 * A relationship's `from_entity_id` and `to_entity_id` are foreign keys onto
 * `ontology_entities`, so referential integrity is enforced by Postgres. What
 * Postgres cannot enforce is that both endpoints belong to the SAME STACK as the
 * edge — `unique_edge_per_stack` only stops duplicate edges, it does not stop a
 * cross-stack one. That is a property of the consolidation code, and it is what
 * the last test here verifies.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { withFixtureTenant } from "./fixture-tenant.js";

import { installFetchStub, setToolResponse, uninstallFetchStub } from "../core/extraction-harness.js";
import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import { createRequestTransactionWrapper } from "../db.js";
import { createIngestRouter } from "./ingest.js";
import { createStacksRouter } from "./stacks.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "./ingest-harness.js";

/** Provider configuration, hoisted above every import — see the e2e file. */
vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
});

useDomainPrefix("formation");

/** The declaration every fixture Stack carries. */
const DECLARATION = { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["EMPLOYS"] };

const BODY = "Acme employs Ada Lovelace.";

/** One triplet whose endpoints and edge are all declared. */
const TRIPLET = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Ada Lovelace" },
};

/** One `ontology_entities` row, as this suite asserts on it. */
interface EntityRow {
  readonly id: string;
  readonly stack_id: string;
  readonly name: string;
  readonly type: string;
  readonly confidence: number;
  readonly verified: boolean;
  readonly extracted_by_model: string | null;
  readonly source_kind: string | null;
  readonly pipeline: string | null;
}

/** One `ontology_relationships` row. */
interface RelationshipRow {
  readonly id: string;
  readonly stack_id: string;
  readonly from_entity_id: string;
  readonly to_entity_id: string;
  readonly type: string;
  readonly extracted_by_model: string | null;
  readonly source_kind: string | null;
}

/** Build one app over the two routers this file needs. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));

  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  app.use(createIngestRouter({ wrap, apiKey }));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ detail: err instanceof Error ? err.message : String(err) });
    },
  );
  return app;
}

/** Creates a Stack through the API, returning its id. */
async function createStack(app: Express, domain: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: "Formation Stack", domain, ontology: DECLARATION });
  expect(created.status).toBe(201);
  return String(created.body.id);
}

/** All entity rows for one Stack. */
async function entityRows(stackId: string): Promise<EntityRow[]> {
  return withFixtureTenant(database(), { stackId }, (tx) => tx.execute<EntityRow>(sql`
    select id, stack_id, name, type, confidence, verified,
           extracted_by_model, source_kind, pipeline
    from ontology_entities
    where stack_id = ${stackId}
    order by name
  `));
}

/** All relationship rows for one Stack. */
async function relationshipRows(stackId: string): Promise<RelationshipRow[]> {
  return withFixtureTenant(database(), { stackId }, (tx) => tx.execute<RelationshipRow>(sql`
    select id, stack_id, from_entity_id, to_entity_id, type,
           extracted_by_model, source_kind
    from ontology_relationships
    where stack_id = ${stackId}
  `));
}

/** Contribution rows linking entities to the document that mentioned them. */
async function contributions(
  stackId: string,
  documentId: string,
): Promise<Array<{ entity_id: string }>> {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ entity_id: string }>(sql`
      select entity_id from entity_source_documents where document_id = ${documentId}
    `),
  );
}

describe.skipIf(skipReason !== false)("entities and relationships are formed", () => {
  let app: Express;
  let sequence = 0;

  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-formation-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  /** Creates a Stack, a document, and ingests the shared triplet. */
  async function ingestOnce(label: string, triplets: readonly unknown[] = [TRIPLET]) {
    const stackId = await createStack(app, domain(label));
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([{ triplets }]);
    const response = await request(app).post(ingestUrl(stackId, documentId));
    expect(response.status).toBe(200);
    return { stackId, documentId };
  }

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("forms one entity row per endpoint, with the declared type", async () => {
    const { stackId } = await ingestOnce("entities");

    const rows = await entityRows(stackId);

    expect(rows.map((row) => ({ name: row.name, type: row.type }))).toEqual([
      { name: "Acme", type: "COMPANY" },
      { name: "Ada Lovelace", type: "PERSON" },
    ]);
  });

  it("forms one relationship row joining the two entities by id", async () => {
    const { stackId } = await ingestOnce("relationship");

    const [relationship] = await relationshipRows(stackId);
    const entities = await entityRows(stackId);
    const byName = new Map(entities.map((entity) => [entity.name, entity.id]));

    expect(relationship).toBeDefined();
    expect(relationship?.type).toBe("EMPLOYS");
    // Both endpoints resolve to entity rows of this Stack, by id and not by name.
    expect(relationship?.from_entity_id).toBe(byName.get("Acme"));
    expect(relationship?.to_entity_id).toBe(byName.get("Ada Lovelace"));
  });

  it("records honest provenance on both kinds of row", async () => {
    const { stackId } = await ingestOnce("provenance");

    const [entity] = await entityRows(stackId);
    const [relationship] = await relationshipRows(stackId);

    // Machine-extracted knowledge is unverified until a human says otherwise.
    // That is a spec MUST, and the column default alone does not prove the
    // insert left it alone.
    expect(entity?.verified).toBe(false);
    expect(entity?.source_kind).toBe("document");
    expect(entity?.extracted_by_model).toBeTruthy();
    expect(entity?.pipeline).toBeTruthy();
    expect(typeof entity?.confidence).toBe("number");
    expect(relationship?.source_kind).toBe("document");
    expect(relationship?.extracted_by_model).toBeTruthy();
  });

  it("attributes every formed entity to the document that mentioned it", async () => {
    // `entity_source_documents` is what makes a compiled entity traceable to a
    // source. Without these rows the graph exists but nothing explains it.
    const { stackId, documentId } = await ingestOnce("contributions");

    const rows = await contributions(stackId, documentId);
    const entityIds = new Set((await entityRows(stackId)).map((entity) => entity.id));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(entityIds.has(row.entity_id)).toBe(true);
    }
  });

  it("keeps both nodes but drops the edge when a relationship is undeclared", async () => {
    // This test used to assert the opposite — that Globex and Initech had no row
    // at all — which documented the cost rather than a requirement: one
    // unrecognised verb deleted two entities the document really named. The edge
    // is what the ontology refused, so the edge is what is lost.
    //
    // `ACQUIRES` IS in the default vocabulary; it is not in this Stack's
    // declaration, which is the rejection being exercised.
    const { stackId } = await ingestOnce("partial", [
      TRIPLET,
      {
        subject: { type: "COMPANY", name: "Globex" },
        relation: { type: "ACQUIRES" },
        object: { type: "COMPANY", name: "Initech" },
      },
    ]);

    expect((await entityRows(stackId)).map((row) => row.name).sort()).toEqual([
      "Acme",
      "Ada Lovelace",
      "Globex",
      "Initech",
    ].sort());
    // One edge: the declared one. The rejected pair contributes nodes only.
    expect(await relationshipRows(stackId)).toHaveLength(1);
  });

  it("reuses an entity row across documents instead of forming a duplicate", async () => {
    // Consolidation keys on (stack_id, name), so a second document mentioning the
    // same entity must contribute to it, not create a twin.
    const { stackId } = await ingestOnce("reuse");
    const secondDoc = await createDocument(stackId, BODY);
    setToolResponse([{ triplets: [TRIPLET] }]);
    await request(app).post(ingestUrl(stackId, secondDoc)).expect(200);

    const rows = await entityRows(stackId);

    expect(rows).toHaveLength(2);
    // Both documents are recorded against the same entity rows.
    expect(await contributions(stackId, secondDoc)).toHaveLength(2);
  });

  it("never forms an edge whose endpoints belong to another Stack", async () => {
    // `unique_edge_per_stack` stops duplicate edges but says nothing about the
    // endpoints' stack. A cross-stack edge would be invisible to a per-stack
    // query yet present in the table, so it is asserted directly.
    const first = await ingestOnce("cross-a");
    const second = await ingestOnce("cross-b");

    const mismatched = await database().execute<{ n: number }>(sql`
      select count(*)::int as n
      from ontology_relationships r
      join ontology_entities f on f.id = r.from_entity_id
      join ontology_entities t on t.id = r.to_entity_id
      where r.stack_id in (${first.stackId}, ${second.stackId})
        and (f.stack_id <> r.stack_id or t.stack_id <> r.stack_id)
    `);

    expect(mismatched[0]?.n).toBe(0);
  });
});

describe("endpoints recovered from a rejected relationship", () => {
  let app: Express;
  let sequence = 0;

  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-rescue-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("keeps both entities when only the relationship is undeclared", async () => {
    // The cost this fixes. Before: `Globex PARTNERS_WITH Initech` left neither
    // name as a row. Now the edge is lost and the nodes remain.
    const stackId = await createStack(app, domain("relation"));
    const documentId = await createDocument(stackId, "Globex partners with Initech.");
    setToolResponse([
      {
        triplets: [
          {
            subject: { type: "COMPANY", name: "Globex" },
            relation: { type: "PARTNERS_WITH" },
            object: { type: "COMPANY", name: "Initech" },
          },
        ],
      },
    ]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const rows = await entityRows(stackId);

    expect(rows.map((row) => row.name).sort()).toEqual(["Globex", "Initech"]);
  });

  it("forms no relationship row for a rescued pair", async () => {
    // A recovered node carries no evidence that the two are related, so the graph
    // must gain nodes and no edge.
    const stackId = await createStack(app, domain("no-edge"));
    const documentId = await createDocument(stackId, "Globex partners with Initech.");
    setToolResponse([
      {
        triplets: [
          {
            subject: { type: "COMPANY", name: "Globex" },
            relation: { type: "PARTNERS_WITH" },
            object: { type: "COMPANY", name: "Initech" },
          },
        ],
      },
    ]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const edges = await database().execute<{ n: number }>(sql`
      select count(*)::int as n from ontology_relationships where stack_id = ${stackId}
    `);

    expect(edges[0]?.n).toBe(0);
  });

  it("does not rescue the endpoints of a triplet with an undeclared entity type", async () => {
    // The allowlist still wins: an undeclared entity type means there is nothing
    // to keep, and keeping it would make the ontology optional.
    const stackId = await createStack(app, domain("alien"));
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([
      {
        triplets: [
          {
            subject: { type: "ALIEN_CONSTRUCT", name: "Vex" },
            relation: { type: "EMPLOYS" },
            object: { type: "PERSON", name: "Nobody" },
          },
        ],
      },
    ]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await entityRows(stackId)).toEqual([]);
  });

  it("keeps an admitted triplet as an edge while rescuing a sibling's endpoints", async () => {
    // Both in one chunk: the declared sentence keeps its edge, the undeclared one
    // keeps its nodes.
    const stackId = await createStack(app, domain("mixed"));
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([
      {
        triplets: [
          TRIPLET,
          {
            subject: { type: "COMPANY", name: "Globex" },
            relation: { type: "PARTNERS_WITH" },
            object: { type: "COMPANY", name: "Initech" },
          },
        ],
      },
    ]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const names = (await entityRows(stackId)).map((row) => row.name).sort();
    const edges = await database().execute<{ n: number }>(sql`
      select count(*)::int as n from ontology_relationships where stack_id = ${stackId}
    `);

    expect(names).toEqual(["Acme", "Ada Lovelace", "Globex", "Initech"].sort());
    expect(edges[0]?.n).toBe(1);
  });
});

describe("standalone entities", () => {
  let app: Express;
  let sequence = 0;

  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-standalone-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  /** Ingests a payload carrying `entities` and no triplets at all. */
  async function ingestEntities(label: string, entities: readonly unknown[]) {
    const stackId = await createStack(app, domain(label));
    const documentId = await createDocument(stackId, "We decided to use Postgres.");
    setToolResponse([{ triplets: [], entities }]);
    const response = await request(app).post(ingestUrl(stackId, documentId));
    expect(response.status).toBe(200);
    return { stackId, documentId, response };
  }

  /** Creates a Stack whose declaration admits a type that rarely has edges. */
  async function createWideStack(label: string): Promise<string> {
    const created = await request(app).post("/stacks").send({
      name: "Wide Stack",
      domain: domain(label),
      // PERSON is required here: TRIPLET is COMPANY EMPLOYS PERSON, and a
      // declaration without it would drop the triplet and take its endpoints too.
      ontology: { entityTypes: ["DECISION", "COMPANY", "PERSON"], relationshipTypes: ["EMPLOYS"] },
    });
    expect(created.status).toBe(201);
    return String(created.body.id);
  }

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("stores an entity that takes part in no relationship", async () => {
    // The whole point of `entities` in the schema. Before it, a document saying
    // "we decided to use Postgres" produced no rows, because the only place a
    // node could live was inside a triplet.
    const stackId = await createWideStack("one");
    const documentId = await createDocument(stackId, "We decided to use Postgres.");
    setToolResponse([{ triplets: [], entities: [{ type: "DECISION", name: "Use Postgres" }] }]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const rows = await entityRows(stackId);

    expect(rows.map((row) => ({ name: row.name, type: row.type }))).toEqual([
      { name: "Use Postgres", type: "DECISION" },
    ]);
  });

  it("forms no relationship row for a standalone entity", async () => {
    const stackId = await createWideStack("no-edge");
    const documentId = await createDocument(stackId, "We decided to use Postgres.");
    setToolResponse([{ triplets: [], entities: [{ type: "DECISION", name: "Use Postgres" }] }]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const edges = await database().execute<{ n: number }>(sql`
      select count(*)::int as n from ontology_relationships where stack_id = ${stackId}
    `);

    expect(edges[0]?.n).toBe(0);
  });

  it("drops a standalone entity whose type is undeclared", async () => {
    const { stackId } = await ingestEntities("undeclared", [
      { type: "ALIEN_CONSTRUCT", name: "Vex" },
    ]);

    expect(await entityRows(stackId)).toEqual([]);
  });

  it("keeps a standalone entity beside triplet endpoints from the same chunk", async () => {
    // Both shapes in one payload. `Acme` and `Ada` come from the triplet, the
    // decision from `entities`; all three must be rows.
    const stackId = await createWideStack("mixed");
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([
      {
        triplets: [TRIPLET],
        entities: [{ type: "DECISION", name: "Use Postgres" }],
      },
    ]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const names = (await entityRows(stackId)).map((row) => row.name).sort();

    expect(names).toEqual(["Acme", "Ada Lovelace", "Use Postgres"].sort());
  });

  it("keeps one row when a node is reported as both an endpoint and an entity", async () => {
    // The type from the triplet wins, because that is the one a relationship
    // already constrains. Two rows for one name would split the graph.
    const { stackId } = await ingestEntities("both", [
      { type: "COMPANY", name: "Acme" },
    ]);
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([
      { triplets: [TRIPLET], entities: [{ type: "COMPANY", name: "Acme" }] },
    ]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const rows = await entityRows(stackId);
    const acme = rows.filter((row) => row.name === "Acme");

    expect(acme).toHaveLength(1);
    expect(acme[0]?.type).toBe("COMPANY");
  });
});
