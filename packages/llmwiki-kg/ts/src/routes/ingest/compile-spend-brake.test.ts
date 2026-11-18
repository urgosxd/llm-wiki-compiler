/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/compile-spend-brake.test.ts
 * @description The compile route's spend brake (S1, S2, S6, S9).
 *
 * WHY THIS FILE EXISTS. `POST .../compile` runs one chat request per stored chunk and,
 * until this brake, had no bound at all: a document that chunks into two hundred pieces
 * cost two hundred completions through a reachable HTTP route. The ingest phase and the
 * wiki dimension were both bounded; phase two was not.
 *
 * The three cases pin the three answers the route must give:
 *
 * 1. over the cap — refused with `413` and the cap module's own sentence, spending
 *    nothing and writing nothing;
 * 2. exactly at the cap — ADMITTED, and the graph is written. A cap that only a
 *    do-nothing path satisfies is a disable, not a brake (S6);
 * 3. an unresolvable cap value — `500`, because a deployment misconfiguration is not the
 *    caller's fault and must not be reported as a request problem.
 *
 * ## Why zero spend is measured this way
 *
 * `toolCalls()` and `embeddingCalls()` read the recording fetch double, which is the only
 * provider in these suites. They are read as absolutes AFTER the stub is reinstalled, so
 * the ingest phase's own embeddings — real spend, but phase one's — cannot be mistaken
 * for the compile's.
 *
 * ## Why the refusal message is not spelled out here
 *
 * It is produced by calling the cap module's own assertion and catching it. A copy of
 * the sentence in this file would let the contract change without the test noticing.
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

import {
  ExtractionRequestCapError,
  KG_EXTRACTION_REQUEST_CAP_ENV_VAR,
  assertWithinExtractionRequestCap,
  resolveExtractionRequestCap,
} from "@repo/foundation/extraction-request-cap";

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import {
  embeddingCalls,
  installFetchStub,
  setToolResponse,
  toolCalls,
  uninstallFetchStub,
} from "../../core/extraction-harness.js";
import {
  compileUrl,
  createDocument,
  createStack,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  stackFingerprint,
  useDomainPrefix,
} from "../ingest-harness.js";

useDomainPrefix("spend-brake");

/** A document that chunks into exactly one piece, so the chunk count is the cap. */
const BODY =
  "El runbook deja sin efecto la política anterior. El coordinador revisa el runbook.";

/**
 * A document long enough to chunk into SEVERAL pieces.
 *
 * The exact count is read from storage rather than assumed: the cap is then set one
 * below it, which is what makes the case an over-cap case whatever the chunker does.
 * Measured at three chunks with the 1024-token/200-overlap defaults.
 */
const LONG_BODY = Array.from(
  { length: 120 },
  (_, index) => `Section ${String(index + 1)}. The coordinator reviews the runbook.`,
).join(" ");

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

/** Builds an app with the production transaction shape and no classifier. */
function buildApp(): Express {
  const deps: IngestRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
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

/** Sets (or clears) the cap variable for the next request. */
function setCap(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[KG_EXTRACTION_REQUEST_CAP_ENV_VAR];
  } else {
    process.env[KG_EXTRACTION_REQUEST_CAP_ENV_VAR] = value;
  }
}

/**
 * The cap module's own refusal text for this chunk count and cap.
 *
 * Derived by asking the module rather than by formatting the sentence here, so the
 * assertion pins the contract instead of a copy of it.
 */
function capRefusalMessage(chunkCount: number, cap: number): string {
  try {
    assertWithinExtractionRequestCap(chunkCount, cap);
  } catch (error) {
    if (error instanceof ExtractionRequestCapError) return error.message;
    throw error;
  }
  throw new Error(`expected ${String(chunkCount)} chunks to exceed a cap of ${String(cap)}`);
}

/** The cap module's own configuration problem for an unusable value. */
function invalidCapProblem(raw: string): string {
  const resolved = resolveExtractionRequestCap({ [KG_EXTRACTION_REQUEST_CAP_ENV_VAR]: raw });
  if (resolved.kind !== "invalid") throw new Error(`expected "${raw}" to be reported invalid`);
  return resolved.problem;
}

/**
 * Ingests one document, then empties the recording double.
 *
 * The ingest phase embeds every chunk — real spend, but phase one's. Clearing here is
 * what lets the compile's counters be read as absolutes.
 */
async function ingested(app: Express, text: string): Promise<{ stackId: string; documentId: string }> {
  const stackId = await createStack();
  const documentId = await createDocument(stackId, text);
  await request(app).post(ingestUrl(stackId, documentId)).expect(200);
  uninstallFetchStub();
  installFetchStub();
  return { stackId, documentId };
}

let app: Express;

beforeEach(async () => {
  await deleteFixtureRows();
  app = buildApp();
  installFetchStub();
  setCap(undefined);
});

afterEach(async () => {
  setCap(undefined);
  uninstallFetchStub();
  await deleteFixtureRows();
});

describe.skipIf(skipReason !== false)("compile refuses a run that exceeds the cap (S1, S2, S9)", () => {
  it("answers 413 with the cap sentence and leaves every row and counter untouched", async () => {
    const world = await ingested(app, LONG_BODY);
    const before = await stackFingerprint(world.stackId);
    // The premise of the case: more than one chunk, so "one below" is a real cap.
    expect(before.chunks).toBeGreaterThan(1);
    const cap = before.chunks - 1;
    setCap(String(cap));

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(413);

    // 413 Payload Too Large: the request is larger than the limit this server will
    // process, and the remedy the sentence names is exactly "raise the cap or ingest a
    // smaller document".
    expect(response.body).toEqual({ detail: capRefusalMessage(before.chunks, cap) });
    // Nothing written: no entity, no relationship, no chunk mutation, no evidence row,
    // no classification log entry, and no audit change on the document. The fingerprint
    // carries a per-table digest, so an UPDATE fails this too.
    expect(await stackFingerprint(world.stackId)).toEqual(before);
    // Nothing spent: the refusal is decided before the first paid call.
    expect(toolCalls()).toBe(0);
    expect(embeddingCalls()).toBe(0);
  });
});

describe.skipIf(skipReason !== false)("compile admits a run exactly at the cap (S6)", () => {
  it("extracts, writes the graph and sends one chat request per chunk", async () => {
    const world = await ingested(app, BODY);
    const stored = await stackFingerprint(world.stackId);
    const cap = stored.chunks;
    setCap(String(cap));
    setToolResponse(Array.from({ length: cap }, () => ANSWER));

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(200);

    // The boundary is INCLUSIVE: the cap is a maximum, not a strict bound.
    expect(response.body.chunks_read).toBe(cap);
    expect(toolCalls()).toBe(cap);
    const after = await stackFingerprint(world.stackId);
    // A cap satisfiable only by a path that does nothing would show here.
    expect(after.entities).toBeGreaterThan(stored.entities);
    expect(after.relationships).toBeGreaterThan(stored.relationships);
    // And it read the stored chunks without rewriting them: same rows, same CONTENT.
    expect(after.digests.document_chunks).toBe(stored.digests.document_chunks);
    // A successful compile does write `entity_source_documents`, which is counted here
    // precisely so a refusal cannot leave that write unnoticed.
    expect(after.sourceDocuments).toBeGreaterThan(stored.sourceDocuments);
  });
});

describe.skipIf(skipReason !== false)("compile refuses an unusable cap value (S9)", () => {
  it("answers 500 naming the variable and spends nothing", async () => {
    const world = await ingested(app, BODY);
    const before = await stackFingerprint(world.stackId);
    setCap("unlimited");

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(500);

    // A deployment misconfiguration, not the caller's fault: the variable is named, and
    // the problem text is the cap module's own.
    expect(response.body).toEqual({ detail: invalidCapProblem("unlimited") });
    expect(response.body.detail).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
    expect(await stackFingerprint(world.stackId)).toEqual(before);
    expect(toolCalls()).toBe(0);
    expect(embeddingCalls()).toBe(0);
  });
});
