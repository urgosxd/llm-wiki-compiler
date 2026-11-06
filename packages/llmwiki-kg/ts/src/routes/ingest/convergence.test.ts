/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/convergence.test.ts
 * @description Two ingest-level facts a reclassification pass depends on: a
 * re-ingest must not duplicate the evidence it already recorded, and two
 * assertions that fold onto ONE stored edge must not lose the second one
 * silently.
 *
 * WHY THIS FILE EXISTS. Both are silent by nature.
 *
 * - `kg_evidence` is append-only and was written with a plain INSERT, so a
 *   re-ingest of the same document recorded the same quote twice and "how many
 *   sources back this fact" became a count of retries (S45.12).
 * - `unique_edge_per_stack` is `(stack_id, from, to, type)`, and `type` is the
 *   FOLDED label, so two spellings of one verb between the same endpoints
 *   collide there while their identity keys differ. The `on conflict do update`
 *   keeps the first predicate — which is the right survivor — but said nothing
 *   about the second assertion, so the loss was invisible (S43).
 *
 * No classifier is configured in this file: neither fact is a classification, and
 * leaving the decision stage out keeps the counts exact.
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
import { createRequestTransactionWrapper } from "../../db.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import { createStacksRouter } from "../stacks.js";
import { withFixtureTenant } from "../fixture-tenant.js";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "../../core/extraction-harness.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";

useDomainPrefix("converge");

/** The prose both documents paraphrase, with the verb spelled two ways. */
const BODY_SPACED = "El runbook deja sin efecto la política anterior.";
const BODY_SNAKED = "El runbook deja_sin_efecto la política anterior.";

/** The triplet the model answers for each spelling. */
function triplet(relation: string): unknown {
  return {
    triplets: [
      {
        subject: { type: "document", name: "runbook" },
        relation: { type: relation },
        object: { type: "policy", name: "política anterior" },
      },
    ],
    entities: [],
  };
}

/** Builds an app with the production transaction shape and no classifier. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));
  const deps: IngestRouterDependencies = { wrap, apiKey, decisions: () => undefined };

  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** Creates a Stack with no `type_catalog`, so the documented default is in force. */
async function createStack(app: Express, label: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: `Converge ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** How many evidence rows this Stack holds. */
async function evidenceCount(stackId: string): Promise<number> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from kg_evidence where stack_id = ${stackId}
    `),
  );
  return rows[0]?.n ?? -1;
}

/** Every classification-log row written for this Stack, newest last. */
async function logRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ candidate_kind: string; candidate_ref: string; new_state: string; reason: string | null }>(sql`
      select candidate_kind, candidate_ref, new_state, reason
      from kg_classification_log where stack_id = ${stackId} order by created_at, id
    `),
  );
}

describe.skipIf(skipReason !== false)("re-ingest keeps one evidence row per span", () => {
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

  it("keeps a second document's evidence for the same entity (S43)", async () => {
    const stackId = await createStack(app, "accumulate");
    const first = await createDocument(stackId, BODY_SPACED, "first.txt");
    const second = await createDocument(stackId, BODY_SNAKED, "second.txt");
    setToolResponse([triplet("deja sin efecto"), triplet("deja_sin_efecto")]);

    await request(app).post(ingestUrl(stackId, first)).expect(200);
    await request(app).post(ingestUrl(stackId, second)).expect(200);

    // Two documents that state the same claim corroborate it: the second one adds its
    // own span and never replaces the first, so provenance keeps every source.
    const documents = await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(distinct document_id)::int as n from kg_evidence
        where stack_id = ${stackId} and candidate_kind = 'entity' and evidence_text = 'runbook'
      `),
    );
    expect(documents[0]?.n).toBe(2);
  });

  it("does not duplicate a candidate's evidence on a second ingest (S45.12)", async () => {
    const stackId = await createStack(app, "evidence");
    const documentId = await createDocument(stackId, BODY_SPACED);
    setToolResponse([triplet("deja sin efecto"), triplet("deja sin efecto")]);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const afterFirst = await evidenceCount(stackId);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const afterSecond = await evidenceCount(stackId);

    // Two entities and one relation, one textual row each. The same span judged
    // again is the same evidence, not corroboration: a retried ingest must not
    // inflate provenance into a count of attempts.
    expect(afterFirst).toBe(3);
    expect(afterSecond).toBe(afterFirst);
  });
});

describe.skipIf(skipReason !== false)("two predicates folding onto one edge", () => {
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

  it("keeps the first predicate and records the collision (S45.11, S43)", async () => {
    const stackId = await createStack(app, "collision");
    const first = await createDocument(stackId, BODY_SPACED, "first.txt");
    const second = await createDocument(stackId, BODY_SNAKED, "second.txt");
    setToolResponse([triplet("deja sin efecto"), triplet("deja_sin_efecto")]);

    await request(app).post(ingestUrl(stackId, first)).expect(200);
    await request(app).post(ingestUrl(stackId, second)).expect(200);

    const edges = await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute<{ type: string; predicate: string | null; identity_key: string }>(sql`
        select type, predicate, identity_key from ontology_relationships where stack_id = ${stackId}
      `),
    );
    // One edge, because `unique_edge_per_stack` folds the two spellings into one
    // `type`. The survivor carries the FIRST document's verb, never the last
    // writer's, and the `predicate` column is never overwritten.
    expect(edges).toHaveLength(1);
    expect(edges[0]?.predicate).toBe("deja sin efecto");

    // The second assertion is not silently gone: the collision is on the record,
    // naming the ref that was absorbed and the predicate that survived.
    const logs = await logRows(stackId);
    const collision = logs.find((row) => row.reason?.startsWith("relation_collision") === true);
    expect(collision).toBeDefined();
    expect(collision?.candidate_kind).toBe("relationship");
    expect(collision?.candidate_ref).toContain("deja_sin_efecto");
    expect(collision?.reason).toContain("deja sin efecto");
  });
});
