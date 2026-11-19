/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/persist-contract-mode.test.ts
 * @description The third admission contract, `persist`, is part of the endpoint's
 * documented vocabulary — reachable, and named in the same list as the other two.
 *
 * WHY THIS FILE EXISTS. `open` and `strict` answer opposite questions about a triplet
 * the ontology turns away: one takes no verdict at all, the other takes it and drops the
 * triplet. The wiki `kg` dimension takes the verdict and KEEPS the triplet with its
 * class and reason, so the same document through the two entry points produced two
 * different graphs with nothing in the request naming the difference. The fix is a
 * third value that names that behaviour rather than a silent change to `strict`.
 *
 * This file pins only the VOCABULARY half — that the value is accepted by the query
 * schema, that the accepted set is exactly the three values, and that an unknown value
 * is still refused the way it always was. What the mode then DOES to the rows is a
 * different task and a different file, so nothing here compiles a document or reads the
 * graph: a test that proved the mode's effect here would fail for two reasons at once.
 *
 * The value is validated by the same query DTO the measured FastAPI route uses, so a
 * refusal is a 422 in the query section like every other query parameter on this route.
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
import type { Test } from "supertest";

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import { createStacksRouter } from "../stacks.js";
import { createIngestRouter } from "../ingest.js";
import { INGEST_CONTRACTS } from "./models.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { installFetchStub, uninstallFetchStub } from "../../core/extraction-harness.js";

// Unique per file: cleanup deletes by this prefix, so two files sharing one delete each
// other's fixtures mid-test when they run concurrently.
useDomainPrefix("persist");

/** The declaration the Stack is created with, so the request reaches the query parse. */
const DECLARATION = { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["EMPLOYS"] };

const BODY = "Acme employs Ada Lovelace.";

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

/** The app under test, rebuilt per test so one request cannot leak state into another. */
let app: Express;

/** Counter keeping each fixture's domain unique inside this file. */
let sequence = 0;

/** Creates a Stack carrying the declaration this file ingests against. */
async function createStack(label: string): Promise<string> {
  sequence += 1;
  const domain = `w2ex-ingest-persist-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  const created = await request(app)
    .post("/stacks")
    .send({ name: "Persist Ingest", domain, ontology: DECLARATION })
    .expect(201);
  return String(created.body.id);
}

/** A Stack plus one stored document, ready for the ingest phase this file only parses. */
async function fixture(label: string): Promise<{ stackId: string; documentId: string }> {
  const stackId = await createStack(label);
  return { stackId, documentId: await createDocument(stackId, BODY) };
}

/**
 * One ingest request carrying an `ontology_contract` value, or none when omitted.
 *
 * The result is supertest's `Test` — a thenable request — not a settled `Response`, because
 * the call sites still have to attach `.expect(...)`. Awaiting it yields the `Response`.
 */
function ingest(stackId: string, documentId: string, contract?: string): Test {
  const query = contract === undefined ? "" : `?ontology_contract=${contract}`;
  return request(app).post(ingestUrl(stackId, documentId, query));
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

describe.skipIf(skipReason !== false)("the ingest endpoint names a third contract", () => {
  it("accepts ?ontology_contract=persist instead of answering literal_error (S1)", async () => {
    // The RED this file exists for: while the enum has two members this request is
    // refused exactly like `closed` is in the next block.
    const { stackId, documentId } = await fixture("accept");

    const response = await ingest(stackId, documentId, "persist").expect(200);

    expect(response.body).not.toHaveProperty("detail");
  });

  it("offers exactly the three contracts, with nothing else accepted (S1)", () => {
    // The set itself, not a sample of it: a fourth value added without a documented
    // meaning, or one of the three dropped, fails here rather than in a later task.
    expect([...INGEST_CONTRACTS]).toEqual(["open", "strict", "persist"]);
  });
});

describe.skipIf(skipReason !== false)("the refusal path the added value must not soften", () => {
  it("still refuses a value that is none of the three, naming the parameter", async () => {
    // PRESERVE: the measured FastAPI `Literal` answer, unchanged for a value nobody offers.
    const { stackId, documentId } = await fixture("invalid");

    const response = await ingest(stackId, documentId, "closed").expect(422);

    const detail = response.body.detail as Array<{ type: string; loc: string[]; input: unknown }>;
    expect(detail).toHaveLength(1);
    expect(detail[0]?.loc).toEqual(["query", "ontology_contract"]);
    expect(detail[0]?.type).toBe("literal_error");
    expect(detail[0]?.input).toBe("closed");
  });

  it("still accepts the two contracts it already offered (S2)", async () => {
    // PRESERVE: the enum gained a member, so the members it had must keep answering as
    // they did. One ingest per value, on the route that only parses the parameter.
    const open = await fixture("existing-open");
    await ingest(open.stackId, open.documentId, "open").expect(200);

    const strict = await fixture("existing-strict");
    await ingest(strict.stackId, strict.documentId, "strict").expect(200);
  });
});
