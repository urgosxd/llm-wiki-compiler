/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/refusal-dedup.test.ts
 * @description A refusal is recorded once per version, not once per sweep — and a real
 * change is still recorded every single time it happens.
 *
 * WHY THIS FILE EXISTS. `POST /stacks/:stackId/reclassify` separates a human-verified
 * row at selection and never asks about it (S39). Recording that refusal in
 * `kg_classification_log` is right once; repeating it on every sweep is not. A verified
 * row keeps the versions it was verified under, so it stays SELECTED forever, and a
 * refusal row per sweep makes a scheduled operation grow the table without bound.
 *
 * The tests below pin the whole shape of the fix:
 *
 * - the second sweep under the same catalog and classifier versions adds ZERO rows
 *   while the report still counts the refusal, so an operator sees deduplication
 *   rather than a refusal that vanished;
 * - a sweep under a BUMPED catalog version records a fresh refusal, so the suppression
 *   is version-scoped and not a permanent mute;
 * - a real classification change still appends a history row every time it happens,
 *   which is the behavior the guard must never touch.
 *
 * Doubles only: the decision client is `ScriptedJevClient` and the extraction provider
 * is the shared fetch stub, so no assertion here needs a network or a vendor.
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

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import { parseJevConfig } from "../../core/jev/config.js";
import type { JevScriptStep } from "../../core/jev/doubles.js";
import { choiceAnswer, noulAnswer, ScriptedJevClient, vendorResponse } from "../../core/jev/doubles.js";
import {
  ENTITY_CLASSIFICATION_QUESTIONS,
  RELATION_CLASSIFICATION_QUESTIONS,
  SUPPORT_QUESTION_ID,
} from "../../core/jev/questions.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import { createStacksRouter } from "../stacks.js";
import { withFixtureTenant } from "../fixture-tenant.js";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "../../core/extraction-harness.js";
import { createDocument, database, deleteFixtureRows, ingestUrl, skipReason, useDomainPrefix } from "../ingest-harness.js";
import type { ClassificationRuntime } from "../ingest/classify-stage.js";

useDomainPrefix("refusal");

/** The document's prose; every candidate quote below appears in it. */
const BODY = "El Comité de Cambios ejecuta la gestión de cambios.";

/** One in-catalog triplet: a Role and a Process joined by a canonical verb. */
const ANSWER = {
  triplets: [
    {
      subject: { type: "role", name: "Comité de Cambios" },
      relation: { type: "ejecuta" },
      object: { type: "process", name: "Gestión de cambios" },
    },
  ],
  entities: [],
};

/** One scripted entity decision, with the paired "does any option fit" answer. */
function entityAnswer(label: string, fits: number): JevScriptStep {
  return vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.9 }, 0.8),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** One scripted relation decision. */
function relationAnswer(label: string, fits: number): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.9 }, 0.8),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** One scripted semantic-support answer. */
function supportAnswer(top: number): JevScriptStep {
  return vendorResponse({ [SUPPORT_QUESTION_ID]: choiceAnswer("SUPPORTED", { SUPPORTED: top }, 0.8) });
}

/** The whole ingest script for {@link ANSWER}: three support questions, three decisions. */
const INGEST_SCRIPT: readonly JevScriptStep[] = [
  supportAnswer(0.94),
  supportAnswer(0.93),
  supportAnswer(0.92),
  entityAnswer("Role", 0.95),
  entityAnswer("Process", 0.95),
  relationAnswer("executes", 0.9),
];

/** A catalog one version ahead of the default, so every stored decision is stale. */
function catalogAt(version: string) {
  return {
    version,
    entityTypes: [
      { name: "Role", definition: "A part played by an actor in a process." },
      { name: "Process", definition: "A sequence of steps that produces an outcome." },
      { name: "Policy", definition: "A rule that governs how a process runs." },
    ],
    relationTypes: [
      { name: "executes", definition: "An actor carries out a process." },
      { name: "governs", definition: "A policy constrains a process." },
    ],
  };
}

/** Holds the runtime each request should see, so one app covers every shape. */
interface Holder {
  current: ClassificationRuntime | undefined;
}

/** Builds an app with the production transaction shape and an injectable classifier. */
function buildApp(holder: Holder): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));
  const deps: IngestRouterDependencies = {
    wrap,
    apiKey,
    run: createTransactionRunner(database()),
    decisions: () => holder.current,
  };
  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** Builds a runtime over a scripted client, so the test can read its requests. */
function runtime(steps: readonly JevScriptStep[]): {
  client: ScriptedJevClient;
  config: ReturnType<typeof parseJevConfig>;
} {
  return { client: new ScriptedJevClient(steps), config: parseJevConfig({}) };
}

/** Creates a Stack with no `type_catalog`, so the documented default is in force. */
async function createStack(app: Express, label: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: `Refusal ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** Holds the Stack at a catalog version, so the next sweep decides under a new one. */
async function setCatalogVersion(stackId: string, version: string): Promise<void> {
  const catalog = JSON.stringify(catalogAt(version));
  await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute(sql`update stacks set type_catalog = ${catalog}::jsonb where id = ${stackId}`),
  );
}

/** Marks one entity of a Stack as human-verified, the way a reviewer's decision is stored. */
async function verifyRow(stackId: string, name: string): Promise<void> {
  await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute(sql`
      update ontology_entities set verified = true where stack_id = ${stackId} and name = ${name}
    `),
  );
}

/** Ingests one document, with the model answering {@link ANSWER}. */
async function ingest(app: Express, stackId: string): Promise<void> {
  const documentId = await createDocument(stackId, BODY);
  setToolResponse([ANSWER]);
  await request(app).post(ingestUrl(stackId, documentId)).expect(200);
}

/** Every classification-log row of one Stack, oldest first. */
async function logRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      candidate_ref: string;
      previous_canonical_type: string | null;
      new_canonical_type: string | null;
      catalog_version: string | null;
      classifier_version: string | null;
      reason: string | null;
    }>(sql`
      select candidate_ref, previous_canonical_type, new_canonical_type,
             catalog_version, classifier_version, reason
      from kg_classification_log where stack_id = ${stackId} order by created_at, id
    `),
  );
}

/** The refusal rows alone, oldest first. */
async function refusals(stackId: string) {
  const rows = await logRows(stackId);
  return rows.filter((row) => row.reason === "refused:verified_row_preserved");
}

/** The canonical type a Stack currently stores for one entity. */
async function storedType(stackId: string, name: string): Promise<string | null | undefined> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ canonical_type: string | null }>(sql`
      select canonical_type from ontology_entities where stack_id = ${stackId} and name = ${name}
    `),
  );
  return rows[0]?.canonical_type;
}

/** The reclassification endpoint of one Stack. */
function reclassifyUrl(stackId: string): string {
  return `/stacks/${stackId}/reclassify`;
}

/** Ingests the fixture document, then verifies one entity and moves the catalog once. */
async function prepareRefusedStack(app: Express, holder: Holder, label: string): Promise<string> {
  const stackId = await createStack(app, label);
  holder.current = runtime(INGEST_SCRIPT);
  await ingest(app, stackId);
  await verifyRow(stackId, "Comité de Cambios");
  await setCatalogVersion(stackId, "2.0.0");
  return stackId;
}

describe.skipIf(skipReason !== false)("a refusal is recorded once per version", () => {
  let app: Express;
  let holder: Holder;

  beforeEach(async () => {
    await deleteFixtureRows();
    holder = { current: undefined };
    app = buildApp(holder);
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("writes one refusal for a verified row and none on a second sweep under the same versions (S43)", async () => {
    const stackId = await prepareRefusedStack(app, holder, "once");
    holder.current = runtime([entityAnswer("Process", 0.95), relationAnswer("executes", 0.9)]);
    const first = await request(app).post(reclassifyUrl(stackId)).expect(200);

    expect(first.body).toMatchObject({ refused_verified: 1 });
    const afterFirst = await logRows(stackId);
    expect(afterFirst.filter((row) => row.reason === "refused:verified_row_preserved")).toHaveLength(1);

    // Nothing else is stale, so the second sweep selects the verified row and nothing
    // else. It must add NO row: the exact row count is what a scheduled sweep can grow.
    const idle = runtime([]);
    holder.current = idle;
    const second = await request(app).post(reclassifyUrl(stackId)).expect(200);
    expect(await logRows(stackId)).toHaveLength(afterFirst.length);
    // Exactly one refusal row survives two sweeps: the count is what grows without bound.
    expect(await refusals(stackId)).toHaveLength(1);
    expect(idle.client.requests).toHaveLength(0);
    // The refusal is still REPORTED, as one that was deduplicated: an operator must see
    // the refusal being collapsed, not a refusal that silently disappeared. The first
    // sweep had nothing to deduplicate, so it counted zero.
    expect(second.body).toMatchObject({ refused_verified: 1, refused_verified_deduplicated: 1 });
    expect(first.body.refused_verified_deduplicated).toBe(0);
    // ...and the verified row is still exactly the row the human left behind (S39).
    expect(await storedType(stackId, "Comité de Cambios")).toBe("Role");
  });

  it("records a fresh refusal when the catalog version moves again (S43)", async () => {
    const stackId = await prepareRefusedStack(app, holder, "bumped");
    holder.current = runtime([entityAnswer("Process", 0.95), relationAnswer("executes", 0.9)]);
    await request(app).post(reclassifyUrl(stackId)).expect(200);
    const afterFirst = await logRows(stackId);
    expect(await refusals(stackId)).toHaveLength(1);

    await setCatalogVersion(stackId, "3.0.0");
    holder.current = runtime([entityAnswer("Process", 0.95), relationAnswer("executes", 0.9)]);
    const third = await request(app).post(reclassifyUrl(stackId)).expect(200);

    // The refusal is version-scoped, not a permanent mute: deciding under a new catalog
    // is a new refusal, and exactly ONE row is added for it, naming the version it was
    // decided under.
    expect(await logRows(stackId)).toHaveLength(afterFirst.length + 1);
    expect((await refusals(stackId)).map((row) => row.catalog_version)).toEqual(["2.0.0", "3.0.0"]);
    expect(third.body).toMatchObject({ refused_verified: 1, refused_verified_deduplicated: 0 });
  });

  it("appends a history row every time a real classification change happens (S43)", async () => {
    const stackId = await createStack(app, "changes");
    holder.current = runtime(INGEST_SCRIPT);
    await ingest(app, stackId);
    expect(await logRows(stackId)).toHaveLength(3);

    await setCatalogVersion(stackId, "2.0.0");
    holder.current = runtime([entityAnswer("Process", 0.95), entityAnswer("Process", 0.95), relationAnswer("executes", 0.9)]);
    await request(app).post(reclassifyUrl(stackId)).expect(200);
    // The Role became a Process: a genuine transition is a history row.
    expect(await storedType(stackId, "Comité de Cambios")).toBe("Process");
    expect(await logRows(stackId)).toHaveLength(4);

    await setCatalogVersion(stackId, "3.0.0");
    holder.current = runtime([entityAnswer("Role", 0.95), entityAnswer("Process", 0.95), relationAnswer("executes", 0.9)]);
    await request(app).post(reclassifyUrl(stackId)).expect(200);
    // And the second genuine transition is its own row: the refusal guard must never
    // collapse a real classification change.
    const rows = await logRows(stackId);
    expect(rows).toHaveLength(5);
    expect(await storedType(stackId, "Comité de Cambios")).toBe("Role");
    expect(rows.at(-1)).toMatchObject({
      previous_canonical_type: "Process",
      new_canonical_type: "Role",
      catalog_version: "3.0.0",
    });
  });
});
