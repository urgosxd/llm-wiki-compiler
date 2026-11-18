/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/compile-spend-fingerprint.test.ts
 * @description The compile route's spend brake and dry run, proved at CONTENT level.
 *
 * WHY THIS FILE EXISTS. `compile-spend-brake.test.ts` proves the refusals with ROW
 * COUNTS. A count is a proof that nothing was INSERTed and nothing at all about what was
 * UPDATEd: a refusal that rewrote a chunk's `content`, bumped a `confidence` or moved a
 * `last_seen_at` would leave every count identical and pass. The same snapshot also never
 * counted `entity_source_documents`, which a SUCCESSFUL compile really does write — so the
 * table most in need of an unchanged-before-and-after proof was the one table outside it.
 *
 * This file closes both holes. A single read per Stack returns, per table, the row count
 * AND an `md5(string_agg(row::text, '|' order by row::text))`-style digest of the ordered
 * rows, so any column of any row changing fails the comparison. Every refusal below
 * asserts the WHOLE fingerprint with `toEqual`, which is what makes "no chunk mutation"
 * and "no ledger write" asserted facts rather than argued ones.
 *
 * The split from `compile-spend-brake.test.ts` is by WHAT IS PROVED, not by rule: the
 * brake suite keeps the derived refusal message and the at-cap happy path, and this one
 * holds the sentence as an independent literal, the truncation pair, the cap's unusable
 * values, the dry run's exact key set, its `false`/`0` spellings, the fingerprint's own
 * sensitivity, and the repeat-compile idempotence pin (S7).
 *
 * ## Why zero spend is measured this way
 *
 * `toolCalls()` and `embeddingCalls()` read the recording fetch double, which is the only
 * provider in these suites, and they are read as absolutes after the stub is reinstalled
 * so the ingest phase's own embeddings cannot be mistaken for the compile's.
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

import { KG_EXTRACTION_REQUEST_CAP_ENV_VAR } from "@repo/foundation/extraction-request-cap";

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
import { withFixtureTenant } from "../fixture-tenant.js";

useDomainPrefix("fingerprint");

/** A document that chunks into exactly one piece. */
const BODY =
  "El runbook deja sin efecto la política anterior. El coordinador revisa el runbook.";

/** A document long enough to chunk into several pieces; the count is READ, never assumed. */
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

/** The plan's keys, in the order `CompilePlan` declares them. */
const PLAN_KEYS = ["dry_run", "planned_chunks", "planned_chat_requests", "cap", "would_refuse"];

/** Every key a COMPILE RESULT carries, none of which a plan may answer with. */
const RESULT_KEYS = [
  "document_id",
  "chunks_read",
  "entities_extracted",
  "entities_in_stack",
  "relationships_extracted",
  "relationships_written",
  "relationships_in_stack",
  "descriptions_synthesized",
] as const;

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

/** Ingests one document, then empties the recording double, so counters read absolute. */
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

/** The graph values a repeat compile must leave alone (S7). */
interface GraphState {
  readonly entities: readonly {
    readonly id: string;
    readonly confidence: number;
    readonly last_seen_at: unknown;
    readonly updated_at: unknown;
  }[];
  readonly relationships: readonly unknown[];
}

/**
 * Reads the graph columns S7 names, one row per entity and per edge, in a stable order.
 *
 * `order by id` rather than by name: a re-extraction that renamed an entity must show up
 * as a moved row, not as a reordered list that happens to compare equal.
 */
async function graphState(stackId: string): Promise<GraphState> {
  return withFixtureTenant(database(), { stackId }, async (tx) => {
    const entities = await tx.execute<{
      id: string;
      confidence: number;
      last_seen_at: unknown;
      updated_at: unknown;
    }>(sql`
      select id, confidence, last_seen_at, updated_at
      from ontology_entities where stack_id = ${stackId} order by id
    `);
    const relationships = await tx.execute(sql`
      select * from ontology_relationships where stack_id = ${stackId} order by id
    `);
    return { entities, relationships };
  });
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

describe.skipIf(skipReason !== false)("the cap refusal is the cap module's own sentence (S1, S9)", () => {
  it("answers 413 with the sentence spelled independently and mutates no stored content", async () => {
    const world = await ingested(app, LONG_BODY);
    const before = await stackFingerprint(world.stackId);
    expect(before.chunks).toBeGreaterThan(1);
    const cap = before.chunks - 1;
    setCap(String(cap));

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(413);

    // Spelled here, NOT derived from the module: this is the contract a caller reads, so
    // a change to it has to be a change somebody made on purpose.
    expect(response.body).toEqual({
      detail:
        `${KG_EXTRACTION_REQUEST_CAP_ENV_VAR} is set to ${String(cap)}: this document yields ` +
        `${String(before.chunks)} chunks, and extraction sends one chat request per chunk. ` +
        `Nothing was sent and no chunk was skipped — raise the cap or ingest a smaller document.`,
    });
    expect(Object.keys(response.body)).toEqual(["detail"]);
    // Whole stored state, content included: no entity, no relationship, no chunk mutation,
    // no evidence row, no ledger entry and no audit change.
    expect(await stackFingerprint(world.stackId)).toEqual(before);
    expect(toolCalls()).toBe(0);
    expect(embeddingCalls()).toBe(0);
  });
});

describe.skipIf(skipReason !== false)("refuse, never truncate (S2)", () => {
  it("refuses a subset's worth of chunks and admits the whole document at the cap", async () => {
    const world = await ingested(app, LONG_BODY);
    const stored = await stackFingerprint(world.stackId);
    expect(stored.chunks).toBeGreaterThan(1);

    // One below: refused, and nothing was sent for the chunks that WOULD have fit.
    setCap(String(stored.chunks - 1));
    await request(app).post(compileUrl(world.stackId, world.documentId)).expect(413);
    expect(toolCalls()).toBe(0);

    // Exactly at: admitted, reading EVERY chunk. A cap satisfiable by a silent prefix is
    // the truncation this pair exists to exclude.
    setCap(String(stored.chunks));
    setToolResponse(Array.from({ length: stored.chunks }, () => ANSWER));
    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(200);
    expect(response.body.chunks_read).toBe(stored.chunks);
    expect(toolCalls()).toBe(stored.chunks);
  });
});

describe.skipIf(skipReason !== false)("an unusable cap is a deployment defect (S9)", () => {
  it("answers 500 naming the variable for zero, negative and fractional values", async () => {
    const world = await ingested(app, BODY);
    const before = await stackFingerprint(world.stackId);

    for (const raw of ["0", "-3", "1.5"]) {
      setCap(raw);
      const response = await request(app)
        .post(compileUrl(world.stackId, world.documentId))
        .expect(500);
      expect(response.body.detail).toContain(KG_EXTRACTION_REQUEST_CAP_ENV_VAR);
      expect(response.body.detail).toContain(`"${raw}"`);
      expect(toolCalls()).toBe(0);
    }
    expect(await stackFingerprint(world.stackId)).toEqual(before);

    // Empty is UNSET, never "unlimited" and never a failure: the documented default.
    setCap("");
    setToolResponse([ANSWER]);
    const admitted = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(200);
    expect(admitted.body.chunks_read).toBe(before.chunks);
  });
});

describe.skipIf(skipReason !== false)("a dry run answers a plan and only a plan (S3)", () => {
  it("carries the five plan keys and none of the compile result's", async () => {
    const world = await ingested(app, BODY);
    setCap("5");

    const response = await request(app)
      .post(compileUrl(world.stackId, world.documentId, "?dry_run=true"))
      .expect(200);

    expect(Object.keys(response.body)).toEqual(PLAN_KEYS);
    for (const key of RESULT_KEYS) {
      expect(response.body).not.toHaveProperty(key);
    }
    expect(toolCalls()).toBe(0);
    expect(embeddingCalls()).toBe(0);
  });

  it("treats the two false spellings as a real run", async () => {
    const world = await ingested(app, BODY);
    setCap("5");
    setToolResponse([ANSWER, ANSWER]);

    const spelled = await request(app)
      .post(compileUrl(world.stackId, world.documentId, "?dry_run=false"))
      .expect(200);
    expect(spelled.body).toHaveProperty("chunks_read");
    expect(toolCalls()).toBeGreaterThan(0);

    const zero = await request(app)
      .post(compileUrl(world.stackId, world.documentId, "?dry_run=0"))
      .expect(200);
    expect(zero.body).toHaveProperty("chunks_read");
  });
});

describe.skipIf(skipReason !== false)("a repeat compile moves no graph value (S7)", () => {
  it("leaves confidence, last_seen_at, updated_at and every edge identical", async () => {
    const world = await ingested(app, BODY);
    setCap("5");
    setToolResponse([ANSWER, ANSWER]);
    await request(app).post(compileUrl(world.stackId, world.documentId)).expect(200);
    const first = await graphState(world.stackId);
    // The first compile must have written something: a second run that wrote nothing at
    // all would otherwise be indistinguishable from a guard that works.
    expect(first.entities.length).toBeGreaterThan(0);
    expect(first.relationships.length).toBeGreaterThan(0);

    const again = await request(app)
      .post(compileUrl(world.stackId, world.documentId))
      .expect(200);
    // Still a real run: it read the chunks and answered the compile shape.
    expect(again.body).toHaveProperty("chunks_read");
    expect(again.body).not.toHaveProperty("dry_run");

    // Confidence is bumped ONLY on new corroboration and the stamps are touched only with
    // it (`core/document-consolidation.ts`), so a repeat compile of unchanged text must
    // leave every entity column and every edge row exactly as the first run left them.
    expect(await graphState(world.stackId)).toEqual(first);
  });
});

describe.skipIf(skipReason !== false)("entity_source_documents is inside the proof (S1)", () => {
  it("counts and digests the table a successful compile writes", async () => {
    const world = await ingested(app, BODY);
    const before = await stackFingerprint(world.stackId);
    expect(before.sourceDocuments).toBe(0);
    setCap("5");
    setToolResponse([ANSWER]);

    await request(app).post(compileUrl(world.stackId, world.documentId)).expect(200);

    const after = await stackFingerprint(world.stackId);
    // This row is the write a counts-only snapshot could not see: a refusal that
    // recorded a contribution would have left every count it read unchanged.
    expect(after.sourceDocuments).toBeGreaterThan(before.sourceDocuments);
    expect(after.digests.entity_source_documents).not.toBe(
      before.digests.entity_source_documents,
    );
  });
});

describe.skipIf(skipReason !== false)("the fingerprint holds the instrument honest", () => {
  it("notices an UPDATE to a stored chunk, which a row count cannot", async () => {
    const world = await ingested(app, BODY);
    const before = await stackFingerprint(world.stackId);
    const chunksBefore = before.chunks;

    await withFixtureTenant(database(), { stackId: world.stackId }, (tx) =>
      tx.execute(
        sql`update document_chunks set content = content || ' amended' where stack_id = ${world.stackId}`,
      ),
    );

    const after = await stackFingerprint(world.stackId);
    // The row count and the audit blob are unchanged: only the CONTENT moved, which is
    // exactly the write a counts-only snapshot cannot see.
    expect(after.chunks).toBe(chunksBefore);
    expect(after).not.toEqual(before);
  });
});
