/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/strict-contract-drops.test.ts
 * @description The asymmetry, pinned in both directions: the closed contract DROPS the
 * row, the default contract KEEPS it.
 *
 * WHY THIS FILE EXISTS. The two-class rule (a rejected triplet becomes a row carrying
 * its verdict and its reason) landed on the whole write path, and that silently reached
 * the one caller who had explicitly asked for a closed graph: `?ontology_contract=strict`
 * is an ADMISSION FILTER, so a rollout of the two classes must not hand that caller rows
 * the ontology refused. `contract-mode.test.ts` caught the break and stays untouched; it
 * asserts the strict side alone, so a fix that dropped the row on BOTH contracts would
 * keep that file green while making the open contract drop what it exists to keep.
 *
 * Both halves therefore run here on the SAME input, which is what makes this one rule
 * instead of two coincidences:
 *
 * - strict   — the row is ABSENT, in both tables, and the refusal is still counted in
 *              the document's `audit.ontology`. Nothing the ontology refused is written.
 * - default  — the row is PRESENT, beside the admitted one, with the ending the open
 *              contract gives it: `accepted`, and the fact that the catalog does not
 *              name that predicate recorded in `audit.open` instead.
 *
 * ## What this test does NOT claim, and why
 *
 * It does not claim the default path stores that triplet `rejected`. Under the open
 * contract the declaration ORIENTS the extraction and refuses nothing for its sake
 * (`core/open-admission.ts`: pair compatibility is not an admission rule, and every
 * out-of-catalog candidate is admitted), so this triplet's row is an open-contract
 * ADMISSION and its class is `accepted`. The `rejected` class is produced by the
 * enforcing side of `rejectTriplet`, which the endpoint reaches only through `strict`.
 *
 * The distinction still matters, and it is the one this file pins: the closed contract
 * DROPS the row and the default KEEPS it, so a fix that dropped it on both — or on
 * neither — fails here.
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
  compileUrl,
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "../../core/extraction-harness.js";

// Unique across the suite: cleanup deletes by prefix, and two files sharing one delete
// each other's fixtures when they run concurrently (`"contract"` belongs to
// `contract-mode.test.ts`, `"admission"` to the file this one sits beside).
useDomainPrefix("strictdrop");

/** Two entity types and ONE verb: the declaration cannot name `ACQUIRED`. */
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

/** A triplet whose verb the declaration does not name: the ONLY thing refused. */
const OUT_OF_ONTOLOGY = {
  subject: { type: "COMPANY", name: "Globex" },
  relation: { type: "ACQUIRED" },
  object: { type: "PERSON", name: "Nobody" },
};

const STRICT = "?ontology_contract=strict";

/** One stored edge, as the three classification columns describe it. */
type EdgeRow = {
  readonly type: string;
  readonly ontology_verdict: string;
  readonly ontology_rejection_reason: string | null;
  readonly ontology_offending_type: string | null;
};

/** One stored node, as the same three columns describe it. */
type NodeRow = {
  readonly name: string;
  readonly ontology_verdict: string;
};

/** The app under test, built once per test by the hook below. */
let app: Express;

/** Makes every Stack domain unique within this file's cleanup prefix. */
let sequence = 0;

/** Builds an app with the production transaction shape and no classifier. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));

  const built = express();
  built.use(express.json({ strict: false }));
  built.use("/stacks", createStacksRouter({ wrap, apiKey }));
  built.use(createIngestRouter({ wrap, apiKey, run: createTransactionRunner(database()) }));
  built.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return built;
}

/** Creates a Stack carrying the declaration these runs ingest against. */
async function createStack(label: string): Promise<string> {
  sequence += 1;
  const domainValue = `w2ex-ingest-strictdrop-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  const created = await request(app)
    .post("/stacks")
    .send({ name: "Strict Drops", domain: domainValue, ontology: DECLARATION })
    .expect(201);
  return String(created.body.id);
}

/** Ingests and compiles one document whose answer is exactly the two triplets above. */
async function runIngest(stackId: string, query: string): Promise<void> {
  const documentId = await createDocument(stackId, BODY);
  await request(app).post(ingestUrl(stackId, documentId)).expect(200);
  setToolResponse([{ triplets: [IN_ONTOLOGY, OUT_OF_ONTOLOGY] }]);
  await request(app).post(compileUrl(stackId, documentId, query)).expect(200);
}

/** Every relationship row the Stack holds, with its class, by `type`. */
async function storedEdges(stackId: string): Promise<EdgeRow[]> {
  return await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<EdgeRow>(sql`
      select type, ontology_verdict, ontology_rejection_reason, ontology_offending_type
      from ontology_relationships
      where stack_id = ${stackId}
      order by type
    `),
  );
}

/** Every entity row the Stack holds, with its class, by `name`. */
async function storedNodes(stackId: string): Promise<NodeRow[]> {
  return await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<NodeRow>(sql`
      select name, ontology_verdict
      from ontology_entities
      where stack_id = ${stackId}
      order by name
    `),
  );
}

/** The document's audit blob, which is where a refusal is COUNTED. */
async function storedAudit(stackId: string): Promise<Record<string, unknown>> {
  const documents = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ audit: unknown }>(sql`select audit from stack_documents where stack_id = ${stackId}`),
  );
  return (documents[0]?.audit ?? {}) as Record<string, unknown>;
}

/**
 * The STRICT half: an explicit opt-in to a closed graph.
 *
 * Nothing the ontology refused may appear, in either table, even though the refusal is
 * still counted. The endpoints of a refused PREDICATE stay as bare entities, which is
 * what the closed contract has always done for that reason (only an undeclared entity
 * type used to take its nodes with it).
 *
 * @param stackId - The Stack the strict run wrote to.
 */
async function expectStrictDrops(stackId: string): Promise<void> {
  const edges = await storedEdges(stackId);
  expect(edges.map((edge) => edge.type)).toEqual(["EMPLOYS"]);
  expect(edges.map((edge) => edge.ontology_verdict)).toEqual(["accepted"]);
  // The refused triplet's own edge is absent, and so is any other rejected row: the
  // filter is the CLASS, not one known reason.
  expect(edges.filter((edge) => edge.ontology_verdict === "rejected")).toEqual([]);
  const nodes = await storedNodes(stackId);
  expect(nodes.filter((node) => node.ontology_verdict === "rejected")).toEqual([]);
  expect(nodes.map((node) => node.name)).toEqual(["Acme", "Ada Lovelace", "Globex", "Nobody"]);
  // Counting and writing are two different questions: the audit says the ontology
  // refused one triplet, and no row was written for it.
  expect((await storedAudit(stackId))["ontology"]).toMatchObject({
    rejected: 1,
    reason_codes: ["UNKNOWN_RELATIONSHIP_TYPE"],
  });
}

/**
 * The DEFAULT half: the open contract, on the same input and the same declaration.
 *
 * The triplet the closed contract dropped is a ROW here, which is the whole difference
 * between the two contracts. Its class is `accepted`, because the open contract
 * ADMITTED it — the declaration orients an open run and refuses nothing for its sake,
 * so "outside the catalog" is recorded in that run's own `open` section instead of
 * being laundered into a rejection the contract never made. The rejected row that
 * carries a reason and a refused type is pinned where that class is actually produced:
 * `core/rejected-triplet-persistence.test.ts`.
 *
 * @param stackId - The Stack the default run wrote to.
 */
async function expectDefaultKeeps(stackId: string): Promise<void> {
  const edges = await storedEdges(stackId);
  expect(edges.map((edge) => edge.type)).toEqual(["ACQUIRED", "EMPLOYS"]);
  expect(edges[0]).toEqual({
    type: "ACQUIRED",
    ontology_verdict: "accepted",
    ontology_rejection_reason: null,
    ontology_offending_type: null,
  });
  expect((await storedAudit(stackId))["open"]).toMatchObject({
    outside_catalog: 1,
    kinds: ["predicate"],
  });
  expect((await storedAudit(stackId))["ontology"]).toMatchObject({ rejected: 0 });
}

describe.skipIf(skipReason !== false)("the closed contract drops what the default keeps", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("drops the refused triplet under strict and keeps it on the default path", async () => {
    const strictStack = await createStack("strict");
    await runIngest(strictStack, STRICT);
    await expectStrictDrops(strictStack);

    const defaultStack = await createStack("default");
    await runIngest(defaultStack, "");
    await expectDefaultKeeps(defaultStack);
  });
});
