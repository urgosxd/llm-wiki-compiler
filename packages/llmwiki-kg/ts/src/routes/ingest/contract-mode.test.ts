/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/contract-mode.test.ts
 * @description Both admission contracts are reachable from the ingest endpoint, and
 * the default is the OPEN one.
 *
 * WHY THIS FILE EXISTS. The open contract replaced a declaration that FILTERED the
 * graph, which is what S1 and S7 require. The strict contract did not disappear — it
 * is still `ExtractionOptions.contract`'s default and still the oracle-parity
 * behaviour — but the HTTP endpoint stopped offering it. That is the one thing a
 * Stack that really wants a closed graph lost, so it comes back here as an explicit
 * opt-in, on the SAME endpoint, named with the programmatic option's own vocabulary.
 *
 * Both directions are pinned on the same endpoint, because a test that only proves
 * the opt-in would let the default drift to closed, and a test that only proves the
 * default would let the opt-in rot.
 *
 * The query flag is parsed by the same DTO the measured FastAPI route uses, so its
 * rejection is a 422 in the query section like every other query parameter here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  delete process.env["TYPESAFE_API_KEY"];
});

import request from "supertest";
import express from "express";
import type { Express } from "express";
import { sql } from "drizzle-orm";

import { withFixtureTenant } from "../fixture-tenant.js";
import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import { createStacksRouter } from "../stacks.js";
import { createIngestRouter } from "../ingest.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "../../core/extraction-harness.js";

// The prefix must be unique across the suite: cleanup deletes by prefix, so two files
// sharing one delete each other's fixtures mid-test when they run concurrently.
// `"contract"` is already taken by `ingest-contract.test.ts`.
useDomainPrefix("admission");

/** The declaration the Stack is created with: it names two types and one verb. */
const DECLARATION = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
};

const BODY = "Acme employs Ada Lovelace. Globex acquired nobody at all.";

/** A triplet the declaration names, so both contracts admit it. */
const IN_ONTOLOGY = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Ada Lovelace" },
};

/** A triplet whose verb the declaration does not name. */
const OUT_OF_ONTOLOGY = {
  subject: { type: "COMPANY", name: "Globex" },
  relation: { type: "ACQUIRED" },
  object: { type: "PERSON", name: "Nobody" },
};

/** Builds an app with the production transaction shape and no classifier. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));

  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  app.use(createIngestRouter({ wrap, apiKey, run: createTransactionRunner(database()) }));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** Which query value each mode carries, so a test never spells one twice. */
const OPEN = "?ontology_contract=open";
const STRICT = "?ontology_contract=strict";

/**
 * What one ingest wrote, as the two facts a mode can change.
 *
 * @param stackId - The Stack to read.
 * @returns Sorted entity types, sorted relation types, and the stored audit blob.
 */
async function writtenGraph(stackId: string): Promise<{
  entityTypes: string[];
  relationTypes: string[];
  audit: Record<string, unknown>;
}> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ type: string }>(sql`
      select distinct type from ontology_entities where stack_id = ${stackId} order by type
    `),
  );
  const edges = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ type: string }>(sql`
      select distinct type from ontology_relationships where stack_id = ${stackId} order by type
    `),
  );
  const documents = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ audit: unknown }>(sql`select audit from stack_documents where stack_id = ${stackId}`),
  );
  return {
    entityTypes: rows.map((row) => row.type),
    relationTypes: edges.map((row) => row.type),
    audit: (documents[0]?.audit ?? {}) as Record<string, unknown>,
  };
}

describe.skipIf(skipReason !== false)("the ingest endpoint offers both contracts", () => {
  let app: Express;
  let sequence = 0;

  /** Unique domain per call, carrying this file's cleanup prefix. */
  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-admission-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  /** Creates a Stack carrying the declaration this file ingests against. */
  async function createStack(label: string): Promise<string> {
    const created = await request(app)
      .post("/stacks")
      .send({ name: "Contract Ingest", domain: domain(label), ontology: DECLARATION })
      .expect(201);
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

  it("keeps out-of-catalog candidates by default, with no query parameter at all (S2, S7)", async () => {
    setToolResponse([{ triplets: [IN_ONTOLOGY, OUT_OF_ONTOLOGY] }]);
    const stackId = await createStack("default");
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const graph = await writtenGraph(stackId);
    expect(graph.entityTypes).toEqual(["COMPANY", "PERSON"]);
    expect(graph.relationTypes).toEqual(["ACQUIRED", "EMPLOYS"]);
    expect(graph.audit["ontology"]).toMatchObject({ rejected: 0 });
    expect(graph.audit["open"]).toMatchObject({ outside_catalog: 1, kinds: ["predicate"] });
  });

  it("keeps exactly the same graph when the open contract is named explicitly", async () => {
    setToolResponse([{ triplets: [IN_ONTOLOGY, OUT_OF_ONTOLOGY] }]);
    const stackId = await createStack("explicit");
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId, OPEN)).expect(200);

    const graph = await writtenGraph(stackId);
    expect(graph.relationTypes).toEqual(["ACQUIRED", "EMPLOYS"]);
    expect(graph.audit["open"]).toMatchObject({ outside_catalog: 1 });
  });

  it("DROPS out-of-catalog candidates when the closed contract is requested", async () => {
    // Exactly the old pipeline: the declaration is an admission filter, the loss is
    // counted with its reason codes, and no open section is written because an
    // enforcing run keeps nothing outside the vocabulary.
    setToolResponse([{ triplets: [IN_ONTOLOGY, OUT_OF_ONTOLOGY] }]);
    const stackId = await createStack("strict");
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId, STRICT)).expect(200);

    const graph = await writtenGraph(stackId);
    expect(graph.entityTypes).toEqual(["COMPANY", "PERSON"]);
    expect(graph.relationTypes).toEqual(["EMPLOYS"]);
    expect(graph.audit["ontology"]).toMatchObject({
      enforced: true,
      declared: true,
      rejected: 1,
      reason_codes: ["UNKNOWN_RELATIONSHIP_TYPE"],
    });
    expect(graph.audit).not.toHaveProperty("open");
  });

  it("refuses a value that is neither contract, naming the parameter", async () => {
    const stackId = await createStack("invalid");
    const documentId = await createDocument(stackId, BODY);

    const response = await request(app)
      .post(ingestUrl(stackId, documentId, "?ontology_contract=closed"))
      .expect(422);

    const detail = response.body.detail as Array<{ type: string; loc: string[]; input: unknown }>;
    expect(detail).toHaveLength(1);
    expect(detail[0]?.loc).toEqual(["query", "ontology_contract"]);
    expect(detail[0]?.type).toBe("literal_error");
    expect(detail[0]?.input).toBe("closed");
  });

  it("still honours the description flag it shares the query with", async () => {
    // PRESERVE: the DTO gained a key, so the option it already had has to keep its
    // measured behaviour — including next to the new one.
    setToolResponse([{ triplets: [IN_ONTOLOGY] }]);
    const stackId = await createStack("synthesize");
    const documentId = await createDocument(stackId, BODY);

    const response = await request(app)
      .post(ingestUrl(stackId, documentId, `${OPEN}&synthesize_descriptions=false`))
      .expect(200);

    expect(response.body.descriptions_synthesized).toBe(false);
  });
});
