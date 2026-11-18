/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/compile-dry-run.test.ts
 * @description The compile route's `dry_run` override (S3).
 *
 * WHY THIS FILE EXISTS. The spend brake refuses an over-cap compile with `413`, which is
 * the right answer to "do it" and the wrong answer to "tell me whether you would". Before
 * this override an operator had no way to ask what a document would cost without either
 * paying for it or provoking a refusal whose remedy — "raise the cap or ingest a smaller
 * document" — was unreachable information.
 *
 * `dry_run` answers both halves in one request: the plan this run would cost, and whether
 * that plan would be refused. The REAL run keeps refusing with `413`, and the over-cap
 * case below pins the two behaviours against each other in the same test so the pair
 * cannot drift apart.
 *
 * ## Zero spend is measured, not asserted
 *
 * `toolCalls()` and `embeddingCalls()` read the recording fetch double after the stub is
 * reinstalled, so the ingest phase's own embeddings cannot be mistaken for the dry run's
 * spend. A before/after `stackSnapshot` proves the same about stored rows.
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

import { KG_EXTRACTION_REQUEST_CAP_ENV_VAR } from "@repo/foundation/extraction-request-cap";

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import {
  embeddingCalls,
  installFetchStub,
  toolCalls,
  uninstallFetchStub,
} from "../../core/extraction-harness.js";
import {
  RESPONSE_KEYS,
  compileUrl,
  createDocument,
  createStack,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  stackSnapshot,
  useDomainPrefix,
} from "../ingest-harness.js";

useDomainPrefix("dry-run");

/** A document that chunks into exactly one piece. */
const BODY =
  "El runbook deja sin efecto la política anterior. El coordinador revisa el runbook.";

/** A document long enough to chunk into several pieces, measured at three. */
const LONG_BODY = Array.from(
  { length: 120 },
  (_, index) => `Section ${String(index + 1)}. The coordinator reviews the runbook.`,
).join(" ");

/** The plan's keys, in the order `CompilePlan` declares them. */
const PLAN_KEYS = ["dry_run", "planned_chunks", "planned_chat_requests", "cap", "would_refuse"];

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

/** Ingests one document, then empties the recording double. */
async function ingested(
  app: Express,
  text: string,
): Promise<{ stackId: string; documentId: string }> {
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

describe.skipIf(skipReason !== false)("compile dry run reports the plan (S3)", () => {
  it("answers the plan for an under-cap document and spends nothing", async () => {
    const world = await ingested(app, BODY);
    const before = await stackSnapshot(world.stackId);
    setCap("5");

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId, "?dry_run=true"))
      .expect(200);

    // The whole payload, so a plan can never be mistaken for a compile result: it
    // carries no `chunks_read`, no `entities_extracted` and no `relationships_written`.
    expect(response.body).toEqual({
      dry_run: true,
      planned_chunks: before.chunks,
      planned_chat_requests: before.chunks,
      cap: 5,
      would_refuse: false,
    });
    expect(Object.keys(response.body)).toEqual(PLAN_KEYS);
    expect(toolCalls()).toBe(0);
    expect(embeddingCalls()).toBe(0);
    expect(await stackSnapshot(world.stackId)).toEqual(before);
  });
});

describe.skipIf(skipReason !== false)("compile dry run answers a refusal question (S3)", () => {
  it("plans an over-cap document as would_refuse while the real run still answers 413", async () => {
    const world = await ingested(app, LONG_BODY);
    const before = await stackSnapshot(world.stackId);
    expect(before.chunks).toBeGreaterThan(1);
    const cap = before.chunks - 1;
    setCap(String(cap));

    const plan = await request(app)
      .post(compileUrl(world.stackId, world.documentId, "?dry_run=true"))
      .expect(200);

    expect(plan.body).toEqual({
      dry_run: true,
      planned_chunks: before.chunks,
      planned_chat_requests: before.chunks,
      cap,
      would_refuse: true,
    });
    expect(toolCalls()).toBe(0);
    expect(embeddingCalls()).toBe(0);
    expect(await stackSnapshot(world.stackId)).toEqual(before);

    // The SAME document, the same cap, without the override: still refused, still
    // spending nothing. The pair is pinned here so neither half can drift.
    const real = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(413);
    expect(real.body.detail).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
    expect(await stackSnapshot(world.stackId)).toEqual(before);
    expect(toolCalls()).toBe(0);
  });
});

describe.skipIf(skipReason !== false)("compile dry run cannot plan a misconfiguration (S3)", () => {
  it("still answers 500 for an unusable cap value instead of a plan", async () => {
    const world = await ingested(app, BODY);
    const before = await stackSnapshot(world.stackId);
    setCap("0");

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId, "?dry_run=true"))
      .expect(500);

    expect(response.body.detail).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
    expect(await stackSnapshot(world.stackId)).toEqual(before);
    expect(toolCalls()).toBe(0);
  });
});

describe.skipIf(skipReason !== false)("compile dry run is validated like its siblings (S3)", () => {
  it("refuses an uninterpretable dry_run value in the query section", async () => {
    const world = await ingested(app, BODY);
    const before = await stackSnapshot(world.stackId);

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId, "?dry_run=maybe"))
      .expect(422);

    const detail = response.body.detail as Array<{ type: string; loc: string[] }>;
    expect(detail).toHaveLength(1);
    expect(detail[0]?.loc).toEqual(["query", "dry_run"]);
    expect(detail[0]?.type).toBe("bool_parsing");
    expect(await stackSnapshot(world.stackId)).toEqual(before);
    expect(toolCalls()).toBe(0);
  });
});

describe.skipIf(skipReason !== false)("the ingest route ignores dry_run (S6)", () => {
  it("still stores the chunks and answers the ingest shape unchanged", async () => {
    const stackId = await createStack();
    const documentId = await createDocument(stackId, BODY);

    const response = await request(app)
      .post(ingestUrl(stackId, documentId, "?dry_run=true"))
      .expect(200);

    // The flag is a compile override; the shared parser accepting it must not give the
    // ingest phase a second behaviour.
    expect(Object.keys(response.body)).toEqual([...RESPONSE_KEYS]);
    expect(response.body).not.toHaveProperty("dry_run");
    expect(response.body).toMatchObject({ chunks_created: 1, entities_extracted: 0 });
    // It really ran: the chunk was embedded, and no chat request was sent.
    expect(embeddingCalls()).toBeGreaterThan(0);
    expect(toolCalls()).toBe(0);
    const after = await stackSnapshot(stackId);
    expect(after.chunks).toBe(1);
    expect(after.entities).toBe(0);
  });
});
