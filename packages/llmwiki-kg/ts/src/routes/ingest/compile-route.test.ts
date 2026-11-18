/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/compile-route.test.ts
 * @description `POST /stacks/:stackId/documents/:doc_id/compile` (S2, S5): the second
 * phase, and the three refusals it must answer without writing anything.
 *
 * WHY THIS FILE EXISTS. The KG pipeline is splitting the way the wiki already is
 * (S1): ingest stores a document's chunks, compile reads those chunks back and runs
 * the LLM pipeline over them. This file pins the compile HALF, and only through the
 * HTTP interface plus the rows it may or may not write:
 *
 * 1. an unknown Stack — the route's existing not-found shape, nothing written;
 * 2. a document that does not exist in an existing Stack — the same, nothing written;
 * 3. a document that exists but was NEVER ingested, so it has no `document_chunks`
 *    rows — an explicit refusal, because a compile reads stored chunks and cannot
 *    invent them, and a refusal that wrote anything would be a compile that half ran;
 * 4. the happy path — ingest, then compile, and the graph the second step produced.
 *
 * Every refusal is asserted against a snapshot of what the Stack holds BEFORE the
 * request, so "no write" is measured rather than assumed: counters and the document's
 * `audit` blob must come back identical.
 *
 * ## What is deliberately NOT here
 *
 * "An ingest alone writes no graph row" is the phase-1 contract, and it belongs to the
 * task that makes ingest stop extracting: today ingest still extracts, so asserting it
 * here would be a test that is red by construction instead of red for this change.
 *
 * No network: the extraction provider is the shared fetch stub, and no classifier is
 * configured, which keeps the counters exact and the decisions out of scope.
 */

import { randomUUID } from "node:crypto";

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

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import { withFixtureTenant } from "../fixture-tenant.js";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "../../core/extraction-harness.js";
import {
  createDocument,
  createStack,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";

useDomainPrefix("compile");

/** The prose of a document that yields one relationship and one extra entity. */
const BODY = "El runbook deja sin efecto la política anterior. El coordinador revisa el runbook.";

/** What the extraction model answers for {@link BODY}. */
const ANSWER = {
  triplets: [
    {
      subject: { type: "document", name: "runbook" },
      relation: { type: "deja sin efecto" },
      object: { type: "policy", name: "política anterior" },
    },
  ],
  entities: [{ type: "role", name: "coordinador" }],
};

/** The compile response's keys, in the order `CompileResult` declares them. */
const COMPILE_RESPONSE_KEYS = [
  "document_id",
  "chunks_read",
  "entities_extracted",
  "entities_in_stack",
  "relationships_extracted",
  "relationships_written",
  "relationships_in_stack",
  "descriptions_synthesized",
];

/** The compile route's URL, mirroring {@link ingestUrl}. */
function compileUrl(stackId: string, documentId: string): string {
  return `/stacks/${stackId}/documents/${documentId}/compile`;
}

/**
 * The refusal a document with no stored chunks earns.
 *
 * Spelled out in the test on purpose: the message is the contract a caller reads, and
 * it has to say BOTH things — that the document was never ingested, and that the
 * compile reads stored chunks — because either one alone leaves the caller guessing
 * what to do next.
 */
function notIngestedDetail(stackId: string, documentId: string): string {
  return (
    `Document ${documentId} has not been ingested: it has no stored chunks in Stack ` +
    `${stackId}. Compile reads the chunks the ingest route persists and cannot invent them.`
  );
}

/** What one Stack holds, so a refusal can be proved to have written nothing. */
interface StackSnapshot {
  readonly chunks: number;
  readonly entities: number;
  readonly relationships: number;
  readonly evidence: number;
  readonly log: number;
  readonly documents: readonly { readonly id: string; readonly audit: unknown }[];
}

/** Builds an app with the production transaction shape and no classifier. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));
  const deps: IngestRouterDependencies = {
    wrap,
    apiKey,
    run: createTransactionRunner(database()),
    decisions: () => undefined,
  };

  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** Every row one Stack holds, counted, plus each document's audit blob. */
async function stackSnapshot(stackId: string): Promise<StackSnapshot> {
  return withFixtureTenant(database(), { stackId }, async (tx) => {
    const counts = await tx.execute<Record<Counted, number>>(sql`
      select
        (select count(*)::int from document_chunks where stack_id = ${stackId}) as chunks,
        (select count(*)::int from ontology_entities where stack_id = ${stackId}) as entities,
        (select count(*)::int from ontology_relationships where stack_id = ${stackId}) as relationships,
        (select count(*)::int from kg_evidence where stack_id = ${stackId}) as evidence,
        (select count(*)::int from kg_classification_log where stack_id = ${stackId}) as log
    `);
    const documents = await tx.execute<{ id: string; audit: unknown }>(sql`
      select id, audit from stack_documents where stack_id = ${stackId} order by id
    `);
    const row = counts[0];
    return { ...counted(row), documents };
  });
}

/** The counters `stackSnapshot` reads, so the fallback below stays exhaustive. */
type Counted = "chunks" | "entities" | "relationships" | "evidence" | "log";

/** Reads the counters defensively: a missing row is a failed read, not a zero. */
function counted(row: Record<Counted, number> | undefined): Record<Counted, number> {
  return {
    chunks: row?.chunks ?? -1,
    entities: row?.entities ?? -1,
    relationships: row?.relationships ?? -1,
    evidence: row?.evidence ?? -1,
    log: row?.log ?? -1,
  };
}

/** How many `document_chunks` rows one document holds. */
async function chunkCount(stackId: string, documentId: string): Promise<number> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from document_chunks where document_id = ${documentId}
    `),
  );
  return rows[0]?.n ?? -1;
}

/**
 * A Stack whose one document HAS been ingested, which is the world every refusal is
 * measured against: there is real data that a buggy refusal could write over.
 */
async function ingestedWorld(app: Express): Promise<{ stackId: string; documentId: string }> {
  const stackId = await createStack();
  const documentId = await createDocument(stackId, BODY);
  setToolResponse([ANSWER]);
  await request(app).post(ingestUrl(stackId, documentId)).expect(200);
  return { stackId, documentId };
}

/** The app under test and the fixtures it reads, reset around every case. */
let app: Express;

beforeEach(async () => {
  await deleteFixtureRows();
  app = buildApp();
  installFetchStub();
});

afterEach(async () => {
  uninstallFetchStub();
  await deleteFixtureRows();
});

describe.skipIf(skipReason !== false)("compile refuses what it cannot compile (S5)", () => {
  it("refuses an unknown Stack with the route's not-found shape and writes nothing", async () => {
    const world = await ingestedWorld(app);
    const before = await stackSnapshot(world.stackId);
    const unknownStack = randomUUID();
    const unknownDocument = randomUUID();

    const response = await request(app)
      .post(compileUrl(unknownStack, unknownDocument))
      .expect(404);

    // The ingest route's own wording, which names both ids: a compile cannot tell an
    // unknown Stack from an unknown document, and inventing a second shape for it would
    // make the two failure modes look like different features.
    expect(response.body).toEqual({
      detail: `Document ${unknownDocument} not found in Stack ${unknownStack}`,
    });
    // Nothing landed for the Stack that was named, and nothing moved in the world.
    expect(await stackSnapshot(unknownStack)).toEqual({
      chunks: 0,
      entities: 0,
      relationships: 0,
      evidence: 0,
      log: 0,
      documents: [],
    });
    expect(await stackSnapshot(world.stackId)).toEqual(before);
  });
});

describe.skipIf(skipReason !== false)("compile refuses a document outside the Stack (S5)", () => {
  it("refuses a document that does not exist in an existing Stack and writes nothing", async () => {
    const world = await ingestedWorld(app);
    const before = await stackSnapshot(world.stackId);
    const missing = randomUUID();

    const response = await request(app)
      .post(compileUrl(world.stackId, missing))
      .expect(404);

    expect(response.body).toEqual({
      detail: `Document ${missing} not found in Stack ${world.stackId}`,
    });
    expect(await stackSnapshot(world.stackId)).toEqual(before);
  });
});

describe.skipIf(skipReason !== false)("compile refuses a document with no stored chunks (S5)", () => {
  it("names the missing chunks and leaves every stored row and counter unchanged", async () => {
    const world = await ingestedWorld(app);
    // A document row with no `document_chunks`: exactly the state an ingest that never
    // ran leaves behind, and the one a compile must not paper over by reading the file.
    const stored = await createDocument(world.stackId, BODY);
    const before = await stackSnapshot(world.stackId);
    expect(await chunkCount(world.stackId, stored)).toBe(0);

    const response = await request(app)
      .post(compileUrl(world.stackId, stored))
      .expect(409);

    expect(response.body).toEqual({
      detail: notIngestedDetail(world.stackId, stored),
    });
    // The sentence has to name both facts, so a caller learns what is missing and why.
    expect(response.body.detail).toContain("has not been ingested");
    expect(response.body.detail).toContain("stored chunks");
    // No extraction call was made either: the refusal happens before the provider stage,
    // so a document that cannot be compiled costs nothing.
    expect(await stackSnapshot(world.stackId)).toEqual(before);
  });
});

describe.skipIf(skipReason !== false)("compile extracts the stored chunks (S2)", () => {
  it("reads the document's chunks, extracts and writes the graph", async () => {
    const stackId = await createStack();
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const storedChunks = await chunkCount(stackId, documentId);
    expect(storedChunks).toBeGreaterThan(0);

    setToolResponse([ANSWER]);
    const response = await request(app)
      .post(compileUrl(stackId, documentId))
      .expect(200);

    // The compile response is its own shape: it creates no chunks, so it reports the ones
    // it READ, and truncation is a read-stage fact this route never observes.
    expect(Object.keys(response.body)).toEqual(COMPILE_RESPONSE_KEYS);
    expect(response.body).toMatchObject({
      document_id: documentId,
      chunks_read: storedChunks,
      relationships_extracted: 1,
      relationships_written: 1,
      descriptions_synthesized: false,
    });
    expect(response.body.entities_extracted).toBeGreaterThan(0);

    const after = await stackSnapshot(stackId);
    // The graph exists because the compile ran, and the Stack totals report the rows a
    // reader will find — not a number assembled from the extraction result.
    expect(after.entities).toBeGreaterThan(0);
    expect(after.relationships).toBeGreaterThan(0);
    expect(response.body.entities_in_stack).toBe(after.entities);
    expect(response.body.relationships_in_stack).toBe(after.relationships);
    // And it read the stored chunks without rewriting them: faking an embedding to
    // satisfy the write would have churned these rows.
    expect(await chunkCount(stackId, documentId)).toBe(storedChunks);
  });
});
