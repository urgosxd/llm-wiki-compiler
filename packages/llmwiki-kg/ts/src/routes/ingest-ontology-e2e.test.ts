/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-ontology-e2e.test.ts
 * @description End to end: a document ingested into a declared Stack is
 * QUERYABLE through the AKS endpoints, and contains only declared types.
 *
 * ## The gap this closes
 *
 * Every existing suite stops at its own boundary. The `aks-*` suites seed
 * `ontology_entities` with direct `insert` statements, so they prove the query
 * layer works on rows that were placed there by a test. The `ingest-*` suites
 * prove rows are written, but never ask the query surface what it can see. No
 * test in this package mounted the ingest router and the AKS router together.
 *
 * So the property that actually matters to a caller — *I ingested my document
 * into a Stack with a declared ontology, and the graph I can query reflects
 * exactly that declaration* — had no test across the middle. This file is that
 * test: it never writes graph rows directly. Every row it asserts on was produced
 * by the ingest pipeline, and every assertion reads through HTTP.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";
import { sql } from "drizzle-orm";

import { installFetchStub, setToolResponse, uninstallFetchStub } from "../core/extraction-harness.js";
import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import { createRequestTransactionWrapper } from "../db.js";
import { createAksRouter } from "./aks.js";
import { createDocumentsRouter } from "./documents.js";
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

/**
 * Provider configuration, hoisted above every import: `config` parses
 * `process.env` once at module load and the pipeline reaches it through
 * `../config.js`. In the harness it would run too late, and the symptom is not an
 * error but a silent success against the real provider APIs.
 */
vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
});

useDomainPrefix("e2e");

/** The declaration the Stack is created with. */
const DECLARATION = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
};

/** The document's prose. Only the provider stub sees it. */
const BODY =
  "Acme employs Ada Lovelace. Acme employs Grace Hopper. Globex acquired Initech.";

/** Endpoints of one in-ontology triplet. */
const ACME_ADA = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Ada Lovelace" },
};

/** A second in-ontology triplet, sharing the subject with the first. */
const ACME_GRACE = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Grace Hopper" },
};

/** Out of ontology: `ACQUIRED` is not a declared relationship type. */
const GLOBEX_INITECH = {
  subject: { type: "COMPANY", name: "Globex" },
  relation: { type: "ACQUIRED" },
  object: { type: "COMPANY", name: "Initech" },
};

/** Build one app over all three routers, sharing a transaction wrapper. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));

  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  app.use(createIngestRouter({ wrap, apiKey }));
  // The documents router declares absolute paths on two prefixes, so it is
  // mounted at the root — see the note in `documents/router.ts`.
  app.use(createDocumentsRouter({ wrap, apiKey }));
  app.use("/aks/v1", createAksRouter({ wrap, apiKey }));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  // Without this, a thrown handler produces an empty 500 and the assertion says
  // only "expected 201, got 500" — which names the symptom and hides the cause.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ detail: message });
    },
  );
  return app;
}

describe.skipIf(skipReason !== false)("ingest to query, end to end", () => {
  let app: Express;
  let sequence = 0;
  let stackDomain = "";

  /** Unique domain per call, carrying the cleanup prefix. */
  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-e2e-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  /** Creates a Stack through the API and records its domain for querying. */
  async function createStack(ontology: unknown): Promise<string> {
    stackDomain = domain("stack");
    const created = await request(app)
      .post("/stacks")
      .send({ name: "E2E Stack", domain: stackDomain, ontology });
    expect({ status: created.status, body: created.body }).toMatchObject({ status: 201 });
    return String(created.body.id);
  }

  /** Ingests the shared body into one Stack. */
  async function ingest(stackId: string, triplets: readonly unknown[]) {
    setToolResponse([{ triplets }]);
    const documentId = await createDocument(stackId, BODY);
    return request(app).post(ingestUrl(stackId, documentId));
  }

  /** Entity names and types as the AKS query surface reports them. */
  async function queriedEntities(): Promise<Array<{ name: string; type: string }>> {
    const response = await request(app)
      .get("/aks/v1/entities")
      .query({ domain: stackDomain })
      .expect(200);
    return (response.body as Array<{ name: string; type: string }>).map((entity) => ({
      name: entity.name,
      type: entity.type,
    }));
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

  it("ingests a document and exposes only declared entity types through AKS", async () => {
    const stackId = await createStack(DECLARATION);

    const ingested = await ingest(stackId, [ACME_ADA, ACME_GRACE, GLOBEX_INITECH]);
    expect(ingested.status).toBe(200);

    // Globex/Initech were dropped with their triplet, so neither reaches AKS.
    expect(await queriedEntities()).toEqual([
      { name: "Acme", type: "COMPANY" },
      { name: "Ada Lovelace", type: "PERSON" },
      { name: "Grace Hopper", type: "PERSON" },
    ]);
  });

  it("makes the declared relationship traversable from one endpoint to the other", async () => {
    const stackId = await createStack(DECLARATION);
    await ingest(stackId, [ACME_ADA, ACME_GRACE, GLOBEX_INITECH]).then((r) => expect(r.status).toBe(200));

    const walked = await request(app)
      .get("/aks/v1/traverse")
      .query({ start: "Acme", domain: stackDomain, max_depth: 1 })
      .expect(200);

    // Assert the whole edge, not just the far endpoint: the point is that the
    // DECLARED relationship is what a caller can walk, with the type they
    // declared on it.
    //
    // Compared as a set, not a sequence: the endpoint promises BFS depth order,
    // not an order between two edges at the same depth, and asserting one would
    // pin an implementation detail as if it were a contract.
    const edges = (walked.body.steps as Array<Record<string, unknown>>).map((step) => ({
      from_entity: step["from_entity"],
      relationship: step["relationship"],
      to_entity: step["to_entity"],
      depth: step["depth"],
    }));
    expect(edges).toEqual(
      expect.arrayContaining([
        { from_entity: "Acme", relationship: "EMPLOYS", to_entity: "Grace Hopper", depth: 1 },
        { from_entity: "Acme", relationship: "EMPLOYS", to_entity: "Ada Lovelace", depth: 1 },
      ]),
    );
    expect(edges).toHaveLength(2);
    // The undeclared `ACQUIRED` edge never entered the graph, so nothing from
    // that triplet is reachable from Acme.
    const names = JSON.stringify(walked.body);
    expect(names).not.toContain("Globex");
    expect(names).not.toContain("ACQUIRED");
  });

  it("reports the same entity through a single-entity read", async () => {
    const stackId = await createStack(DECLARATION);
    await ingest(stackId, [ACME_ADA]).then((r) => expect(r.status).toBe(200));

    const single = await request(app)
      .get("/aks/v1/entities/Acme")
      .query({ domain: stackDomain })
      .expect(200);

    expect(single.body).toMatchObject({ name: "Acme", type: "COMPANY" });
  });

  it("stores everything when the Stack declares no ontology", async () => {
    // The control: without a declaration the same document yields all four
    // entities, including the ones the declaration above rejected.
    stackDomain = domain("plain");
    const created = await request(app)
      .post("/stacks")
      .send({ name: "Plain Stack", domain: stackDomain })
      .expect(201);
    await ingest(String(created.body.id), [ACME_ADA, GLOBEX_INITECH]).then((r) =>
      expect(r.status).toBe(200),
    );

    const names = (await queriedEntities()).map((entity) => entity.name).sort();
    expect(names).toEqual(["Acme", "Globex", "Initech", "Ada Lovelace"].sort());
  });

  it("counts only the admitted knowledge in the Stack totals", async () => {
    // `entities_in_stack` is what a caller reads to decide whether a document
    // contributed. It must count what survived enforcement, not what the model
    // produced — otherwise a rejected document looks productive.
    const stackId = await createStack(DECLARATION);

    const response = await ingest(stackId, [ACME_ADA, ACME_GRACE, GLOBEX_INITECH]);

    expect(response.body).toMatchObject({
      entities_extracted: 3,
      entities_in_stack: 3,
      relationships_extracted: 2,
      relationships_in_stack: 2,
    });
  });

  it("keeps the rejection visible in the document audit after the request ends", async () => {
    const stackId = await createStack(DECLARATION);
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([{ triplets: [ACME_ADA, GLOBEX_INITECH] }]);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const stored = await request(app)
      .get(`/documents/${documentId}`)
      .expect(200);

    expect(stored.body.audit).toMatchObject({
      ontology: {
        enforced: true,
        rejected: 1,
        reason_codes: ["UNKNOWN_RELATIONSHIP_TYPE"],
      },
    });
  });

  it("re-ingests idempotently without growing the graph", async () => {
    // A second ingest of unchanged content must not double the entities: the
    // consolidation is keyed on (stack_id, name). This is what makes a retried
    // compile safe, and it is only observable end to end.
    const stackId = await createStack(DECLARATION);
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([{ triplets: [ACME_ADA] }, { triplets: [ACME_ADA] }]);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const before = await queriedEntities();
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await queriedEntities()).toEqual(before);
    expect(before).toHaveLength(2);
  });

  it("writes no graph rows at all when every triplet is rejected", async () => {
    const stackId = await createStack(DECLARATION);

    const response = await ingest(stackId, [GLOBEX_INITECH]);

    expect(response.status).toBe(200);
    expect(await queriedEntities()).toEqual([]);
    expect(response.body).toMatchObject({ entities_extracted: 0, relationships_in_stack: 0 });
  });
});
