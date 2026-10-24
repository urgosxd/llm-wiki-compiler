/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-ontology.test.ts
 * @description A Stack created with an ontology has that ontology enforced by
 * the very next ingest.
 *
 * WHY THIS FILE EXISTS. Every other ingest suite stops short of this. The
 * contract suites ingest a whitespace-only document so no provider call happens,
 * and the gateway suite spends real money but creates its Stack with a direct
 * `insert` that has no declaration. So the one property the feature exists for —
 * create with a declaration, then ingest, and the graph contains only what was
 * declared — was never executed end to end.
 *
 * Each test here drives the real HTTP surface: `POST /stacks` writes the
 * declaration, `POST /stacks/:id/documents/:doc/ingest` reads it back through
 * `s.ontology` and enforces it. Only the provider is a stub, which is what makes
 * the "the model emitted something out of ontology" case reproducible at all —
 * a live model cannot be asked to misbehave on cue.
 *
 * ## What is asserted, and why not the response body
 *
 * `IngestionResult` is nine fixed keys, byte-identical to the oracle, and it
 * carries no rejection count. So the rejection report cannot be observed on the
 * wire and the assertions read the graph tables instead. That is also the honest
 * place: what matters is what got WRITTEN, not what got counted.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Provider configuration, hoisted above every import.
 *
 * `config` parses `process.env` once at module load, and the pipeline reaches it
 * through `../config.js` — so these values must be in place BEFORE that module
 * is imported. `vi.hoisted` runs above all imports, which is what makes this
 * possible without a setup file.
 *
 * It has to live here and not in `ingest-harness.ts`: a helper module is imported
 * too late, and the symptom is not an error but a silent success against the real
 * `api.openai.com` and `api.anthropic.com` — measured while writing this file,
 * which is why `installFetchStub` would record no chat call at all.
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

import request from "supertest";
import express from "express";
import type { Express } from "express";
import { sql } from "drizzle-orm";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import { createRequestTransactionWrapper } from "../db.js";
import { createStacksRouter } from "./stacks.js";
import { createIngestRouter } from "./ingest.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "./ingest-harness.js";
import {
  installFetchStub,
  setToolResponse,
  uninstallFetchStub,
} from "../core/extraction-harness.js";

useDomainPrefix("ontology");

/** The declaration the Stack is created with. */
const DECLARATION = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
};

/** One chunk of prose, so the pipeline has something to send to the model. */
const BODY = "Acme employs Ada Lovelace. Globex employs nobody at all.";

/** A triplet inside the declaration: kept. */
const IN_ONTOLOGY = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Ada Lovelace" },
};

/** A triplet whose relation was never declared: dropped. */
const BAD_RELATION = {
  subject: { type: "COMPANY", name: "Globex" },
  relation: { type: "ACQUIRED" },
  object: { type: "PERSON", name: "Nobody" },
};

/** A triplet whose entity type was never declared: dropped. */
const BAD_ENTITY = {
  subject: { type: "ALIEN_CONSTRUCT", name: "Vex" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Nobody" },
};

/** Build an app exposing both routers, sharing one transaction wrapper. */
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
  return app;
}

/** Create a Stack through the API, returning its id. */
async function createStackWith(
  app: Express,
  domain: string,
  ontology?: unknown,
): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({
      name: "Ontology Ingest",
      domain,
      ...(ontology === undefined ? {} : { ontology }),
    })
    .expect(201);
  return String(created.body.id);
}

/** Every entity type actually written to the Stack's graph, sorted. */
async function writtenEntityTypes(stackId: string): Promise<string[]> {
  const rows = await database().execute<{ type: string }>(
    sql`select distinct type from ontology_entities where stack_id = ${stackId} order by type`,
  );
  return rows.map((row) => row.type);
}

/** Every relationship type actually written to the Stack's graph, sorted. */
async function writtenRelationTypes(stackId: string): Promise<string[]> {
  const rows = await database().execute<{ type: string }>(
    sql`select distinct type from ontology_relationships where stack_id = ${stackId} order by type`,
  );
  return rows.map((row) => row.type);
}

describe.skipIf(skipReason !== false)("ingest respects a Stack's ontology", () => {
  let app: Express;
  let sequence = 0;

  /** Unique domain per call, carrying the cleanup prefix. */
  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-ontology-${label}-${Date.now().toString(36)}-${String(sequence)}`;
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

  it("drops triplets outside the declaration and keeps the ones inside it", async () => {
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION, BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("mixed"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // Only declared types reached the graph; the two out-of-ontology triplets
    // were dropped rather than stored under a free-text type.
    expect(await writtenEntityTypes(stackId)).toEqual(["COMPANY", "PERSON"]);
    expect(await writtenRelationTypes(stackId)).toEqual(["EMPLOYS"]);
  });

  it("writes everything the model emits when the Stack has no declaration", async () => {
    // The oracle's `strict=False` behaviour, preserved: no declaration means the
    // type hints are a suggestion and whatever arrives is stored.
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION, BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("plain"));
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await writtenEntityTypes(stackId)).toEqual([
      "ALIEN_CONSTRUCT",
      "COMPANY",
      "PERSON",
    ]);
    expect(await writtenRelationTypes(stackId)).toEqual(["ACQUIRED", "EMPLOYS"]);
  });

  it("shows the declared types in the tool schema the model is given", async () => {
    // Enforcement is two-sided: the model is told the allowed types AND the
    // parser drops what ignores them. This asserts the first half, which a
    // stored-then-ignored declaration would silently fail.
    setToolResponse([{ triplets: [IN_ONTOLOGY] }]);
    const stackId = await createStackWith(app, domain("schema"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const { recorded } = await import("../core/extraction-harness.js");
    const chat = recorded.filter((entry) => entry.url.endsWith("/chat/completions")).at(-1);
    const serialized = JSON.stringify(chat?.body);
    expect(serialized).toContain("'COMPANY'");
    expect(serialized).toContain("'PERSON'");
    expect(serialized).toContain("'EMPLOYS'");
  });

  it("enforces an ontology edited by PATCH, not only the one set at creation", async () => {
    // The declaration is read per ingest, so narrowing it must take effect on the
    // next run rather than requiring a new Stack.
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION] }]);
    const stackId = await createStackWith(app, domain("patch"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app)
      .patch(`/stacks/${stackId}`)
      .send({ ontology: { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["REPORTS_TO"] } })
      .expect(200);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // `EMPLOYS` is no longer declared, so the triplet that used it is dropped.
    expect(await writtenEntityTypes(stackId)).toEqual([]);
    expect(await writtenRelationTypes(stackId)).toEqual([]);
  });
});
