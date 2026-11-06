/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/reclassify.test.ts
 * @description What a reclassification run does to the graph it already holds:
 * it re-decides the SAME rows, keeps their identities, provenance and edges, and
 * leaves a trace of every change it made.
 *
 * WHY THIS FILE EXISTS. A reclassification pass is the one operation that rewrites
 * decisions another run already stored, so every promise it makes is about what it
 * must NOT destroy:
 *
 * - the same row, not a sibling (S28, S43) — a new UUID would orphan the evidence
 *   and every edge pointing at it;
 * - the same evidence, never re-extracted and never duplicated (S43, S45.12);
 * - an append-only trace of the previous and the new answer, with both versions
 *   (S43);
 * - no spurious row when the answer did not change, and no selection at all once a
 *   row is converged on the current catalog and classifier;
 * - human-verified rows untouched (S39);
 * - two assertions converging on one canonical type both surviving (S45.11).
 *
 * ## Doubles only, and no extraction at all
 *
 * The decision client is `ScriptedJevClient`; classification is turned OFF for the
 * ingests that produce pending rows, so the only thing a reclassification run can
 * ask is a classification question. `toolCalls()` and `embeddingCalls()` are read
 * before and after to prove the run touched no provider that is not the classifier.
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
import { choiceAnswer, noulAnswer, vendorResponse } from "../../core/jev/doubles.js";
import { ScriptedJevClient } from "../../core/jev/doubles.js";
import {
  ENTITY_CLASSIFICATION_QUESTIONS,
  RELATION_CLASSIFICATION_QUESTIONS,
  SUPPORT_QUESTION_ID,
} from "../../core/jev/questions.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import { createStacksRouter } from "../stacks.js";
import { withFixtureTenant } from "../fixture-tenant.js";
import {
  embeddingCalls,
  installFetchStub,
  setToolResponse,
  toolCalls,
  uninstallFetchStub,
} from "../../core/extraction-harness.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import type { ClassificationRuntime } from "../ingest/classify-stage.js";

useDomainPrefix("reclassify");

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

/** Two documents whose verbs the model spelled differently between the same nodes. */
const FREE_EDGE_BODY = "El runbook deja sin efecto la política anterior.";

/** A second spelling of the same assertion, folded to a different `type` label. */
const SECOND_EDGE_BODY = "El runbook reemplaza a la política anterior.";

/** One scripted entity decision, with the paired "does any option fit" answer. */
function entityAnswer(label: string, probabilities: Record<string, number>, fits: number): JevScriptStep {
  return vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, probabilities, 0.8),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** One scripted relation decision. */
function relationAnswer(label: string, probabilities: Record<string, number>, fits: number): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, probabilities, 0.8),
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
  entityAnswer("Role", { Role: 0.9 }, 0.95),
  entityAnswer("Process", { Process: 0.9 }, 0.95),
  relationAnswer("executes", { executes: 0.9 }, 0.9),
];

/** The same three decisions, in the same order, for a reclassification run. */
const SAME_ANSWERS: readonly JevScriptStep[] = [
  entityAnswer("Role", { Role: 0.9 }, 0.95),
  entityAnswer("Process", { Process: 0.9 }, 0.95),
  relationAnswer("executes", { executes: 0.9 }, 0.9),
];

/** A catalog the Stack can be moved to, so every row's version is stale. */
const SECOND_CATALOG = {
  version: "2.0.0",
  entityTypes: [
    { name: "Role", definition: "A part played by an actor in a process." },
    { name: "Process", definition: "A sequence of steps that produces an outcome." },
    { name: "Policy", definition: "A rule that governs how a process runs." },
    { name: "Document", definition: "A written artifact a process consumes." },
  ],
  relationTypes: [
    { name: "executes", definition: "An actor carries out a process." },
    { name: "governs", definition: "A policy constrains a process." },
  ],
};

/** Holds the runtime each request should see, so one app covers both shapes. */
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
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ detail: message });
    },
  );
  return app;
}

/** The reclassification endpoint of one Stack. */
function reclassifyUrl(stackId: string): string {
  return `/stacks/${stackId}/reclassify`;
}

/** Builds a runtime over a scripted client, so the test can read its requests. */
function runtime(steps: readonly JevScriptStep[]): { client: ScriptedJevClient; config: ReturnType<typeof parseJevConfig> } {
  return { client: new ScriptedJevClient(steps), config: parseJevConfig({}) };
}

/** Creates a Stack with no `type_catalog`, so the documented default is in force. */
async function createStack(app: Express, label: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: `Reclassify ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** Moves the Stack's catalog to {@link SECOND_CATALOG}, so every stored decision is stale. */
async function bumpCatalog(stackId: string): Promise<void> {
  await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute(sql`
      update stacks set type_catalog = ${JSON.stringify(SECOND_CATALOG)}::jsonb where id = ${stackId}
    `),
  );
}

/** Ingests one document, with the model answering `payload`. */
async function ingest(app: Express, stackId: string, body: string, payload: unknown): Promise<string> {
  const documentId = await createDocument(stackId, body);
  setToolResponse([payload]);
  await request(app).post(ingestUrl(stackId, documentId)).expect(200);
  return documentId;
}

/** Every entity row of one Stack, with the columns a reclassification may move. */
async function entityRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      id: string;
      name: string;
      classification_state: string | null;
      canonical_type: string | null;
      catalog_version: string | null;
      verified: boolean;
    }>(sql`
      select id, name, classification_state, canonical_type, catalog_version, verified
      from ontology_entities where stack_id = ${stackId} order by name, id
    `),
  );
}

/** Every relationship row of one Stack. */
async function relationshipRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ id: string; type: string; predicate: string | null; canonical_type: string | null }>(sql`
      select id, type, predicate, canonical_type
      from ontology_relationships where stack_id = ${stackId} order by type
    `),
  );
}

/** Every classification-log row of one Stack, newest last. */
async function logRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      candidate_kind: string;
      previous_state: string | null;
      new_state: string;
      previous_canonical_type: string | null;
      new_canonical_type: string | null;
      jev_choice: string | null;
      catalog_version: string | null;
      classifier_version: string | null;
      reason: string | null;
    }>(sql`
      select candidate_kind, previous_state, new_state, previous_canonical_type,
             new_canonical_type, jev_choice, catalog_version, classifier_version, reason
      from kg_classification_log where stack_id = ${stackId} order by created_at, id
    `),
  );
}

/** How many contributing-document rows one Stack holds. */
async function contributionCount(stackId: string): Promise<number> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from entity_source_documents where stack_id = ${stackId}
    `),
  );
  return rows[0]?.n ?? -1;
}

/** How many evidence rows one Stack holds. */
async function evidenceCount(stackId: string): Promise<number> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from kg_evidence where stack_id = ${stackId}
    `),
  );
  return rows[0]?.n ?? -1;
}

describe.skipIf(skipReason !== false)("reclassifying a Stack in place", () => {
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

  it("classifies pending rows in place, with no extraction and no embedding (S45.10)", async () => {
    const stackId = await createStack(app, "inplace");
    // No classifier yet: the ingest stores the candidates as `pending` and records
    // their evidence, which is exactly the state a later pass has to finish.
    await ingest(app, stackId, BODY, ANSWER);
    const before = await entityRows(stackId);
    const edgesBefore = await relationshipRows(stackId);
    const evidenceBefore = await evidenceCount(stackId);
    const contributionsBefore = await contributionCount(stackId);
    const providerCallsBefore = toolCalls() + embeddingCalls();

    const scripted = runtime(SAME_ANSWERS);
    holder.current = scripted;
    const response = await request(app).post(reclassifyUrl(stackId)).expect(200);

    expect(response.body).toMatchObject({
      selected: { entities: 2, relationships: 1 },
      applied: 3,
      changed: 3,
      truncated: false,
    });
    // The classifier was asked once per candidate and nothing else was asked of
    // anybody: no re-chunk, no re-embed, no second extraction (S43).
    expect(scripted.client.requests).toHaveLength(3);
    expect(toolCalls() + embeddingCalls()).toBe(providerCallsBefore);
    // The SAME rows, by UUID, and the edges still point at them (S28).
    const after = await entityRows(stackId);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.every((row) => row.classification_state === "classified")).toBe(true);
    // The edges still point at the same node UUIDs; only the decision column moved.
    expect((await relationshipRows(stackId)).map((edge) => edge.id)).toEqual(edgesBefore.map((edge) => edge.id));
    // Provenance and provenance-of-provenance are kept, not rewritten, not duplicated:
    // the row is the same row, so its contributing documents are still the same rows.
    expect(await evidenceCount(stackId)).toBe(evidenceBefore);
    expect(contributionsBefore).toBe(2);
    expect(await contributionCount(stackId)).toBe(contributionsBefore);
  });

  it("re-decides when the catalog moves and writes nothing when the answer is identical (S43)", async () => {
    const stackId = await createStack(app, "skew");
    holder.current = runtime(INGEST_SCRIPT);
    await ingest(app, stackId, BODY, ANSWER);
    const logsBefore = await logRows(stackId);
    expect(logsBefore).toHaveLength(3);

    await bumpCatalog(stackId);
    holder.current = runtime(SAME_ANSWERS);
    const refreshed = await request(app).post(reclassifyUrl(stackId)).expect(200);

    // The vocabulary moved, the decision did not: the rows are re-decided under the
    // new version, and a classification that did not change writes no log row.
    expect(refreshed.body).toMatchObject({ applied: 3, versions_refreshed: 3, changed: 0 });
    expect(await logRows(stackId)).toHaveLength(logsBefore.length);
    expect((await entityRows(stackId)).every((row) => row.catalog_version === "2.0.0")).toBe(true);

    // Converged: a second run has nothing stale to select and asks nobody anything.
    const idle = runtime([]);
    holder.current = idle;
    const second = await request(app).post(reclassifyUrl(stackId)).expect(200);
    expect(second.body).toMatchObject({
      selected: { entities: 0, relationships: 0 },
      applied: 0,
      unchanged: 0,
    });
    expect(idle.client.requests).toHaveLength(0);
  });

  it("logs a contradictory answer with its previous and new decision (S43)", async () => {
    const stackId = await createStack(app, "contradiction");
    holder.current = runtime(INGEST_SCRIPT);
    await ingest(app, stackId, BODY, ANSWER);
    await bumpCatalog(stackId);

    holder.current = runtime([
      entityAnswer("Process", { Process: 0.9 }, 0.95),
      entityAnswer("Process", { Process: 0.9 }, 0.95),
      relationAnswer("executes", { executes: 0.9 }, 0.9),
    ]);
    await request(app).post(reclassifyUrl(stackId)).expect(200);

    const committee = (await entityRows(stackId)).find((row) => row.name === "Comité de Cambios");
    expect(committee?.canonical_type).toBe("Process");
    const change = (await logRows(stackId)).find(
      (row) => row.previous_canonical_type === "Role" && row.new_canonical_type === "Process",
    );
    // What changed, what it was, what it became, which vocabulary decided it, and
    // which stage produced the decision: all in the append-only log.
    expect(change).toMatchObject({
      candidate_kind: "entity",
      previous_state: "classified",
      new_state: "classified",
      jev_choice: "Process",
      catalog_version: "2.0.0",
      classifier_version: "jev-classification/1",
    });
  });

  it("leaves a human-verified row alone and records the refusal (S39, S43)", async () => {
    const stackId = await createStack(app, "verified");
    holder.current = runtime(INGEST_SCRIPT);
    await ingest(app, stackId, BODY, ANSWER);
    await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute(sql`
        update ontology_entities set verified = true where stack_id = ${stackId} and name = 'Comité de Cambios'
      `),
    );
    await bumpCatalog(stackId);

    const scripted = runtime(SAME_ANSWERS);
    holder.current = scripted;
    const response = await request(app).post(reclassifyUrl(stackId)).expect(200);

    // A verified row is a human-reviewed fact: the automatic pass neither reads a
    // new answer into it nor asks about it at all. It says so instead.
    expect(response.body).toMatchObject({ refused_verified: 1 });
    expect(scripted.client.requests).toHaveLength(2);
    const committee = (await entityRows(stackId)).find((row) => row.name === "Comité de Cambios");
    expect(committee).toMatchObject({ canonical_type: "Role", verified: true, catalog_version: "1.0.0" });
    const refusal = (await logRows(stackId)).find(
      (row) => row.reason === "refused:verified_row_preserved",
    );
    expect(refusal).toMatchObject({ previous_state: "classified", new_state: "classified", new_canonical_type: "Role" });
  });

  it("keeps two predicates that converge on one canonical type as two rows (S45.11)", async () => {
    const stackId = await createStack(app, "converge");
    await ingest(app, stackId, FREE_EDGE_BODY, {
      triplets: [
        {
          subject: { type: "document", name: "runbook" },
          relation: { type: "deja sin efecto" },
          object: { type: "policy", name: "política anterior" },
        },
      ],
      entities: [],
    });
    await ingest(app, stackId, SECOND_EDGE_BODY, {
      triplets: [
        {
          subject: { type: "document", name: "runbook" },
          relation: { type: "reemplaza a" },
          object: { type: "policy", name: "política anterior" },
        },
      ],
      entities: [],
    });
    expect(await relationshipRows(stackId)).toHaveLength(2);

    holder.current = runtime([
      entityAnswer("Policy", { Policy: 0.9 }, 0.95),
      entityAnswer("Document", { Document: 0.9 }, 0.95),
      relationAnswer("governs", { governs: 0.9 }, 0.9),
      relationAnswer("governs", { governs: 0.9 }, 0.9),
    ]);
    await request(app).post(reclassifyUrl(stackId)).expect(200);

    const edges = await relationshipRows(stackId);
    // Both assertions survive as distinct rows carrying their own original verb, and
    // both now name the same canonical type. `canonical_type` is where a
    // classification lives, so convergence there cannot collide with the
    // `(stack, from, to, type)` uniqueness the stored projection label carries.
    expect(edges.map((row) => row.predicate)).toEqual(["deja sin efecto", "reemplaza a"]);
    expect(edges.map((row) => row.canonical_type)).toEqual(["governs", "governs"]);
    expect(new Set(edges.map((row) => row.id)).size).toBe(2);
  });
});

describe.skipIf(skipReason !== false)("the reclassification endpoint's own contract", () => {
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

  it("refuses to report a reclassification when no classifier is configured (S43)", async () => {
    const stackId = await createStack(app, "unconfigured");
    await ingest(app, stackId, BODY, ANSWER);

    const response = await request(app).post(reclassifyUrl(stackId));

    // Doing nothing and answering 200 is how a reclassification silently "succeeds"
    // without deciding anything; the refusal names what is missing instead.
    expect(response.status).toBe(503);
    expect(String(response.body.detail)).toContain("TYPESAFE_API_KEY");
    expect((await entityRows(stackId)).every((row) => row.classification_state === "pending")).toBe(true);
  });

  it("answers 404 for an unknown Stack and 422 for a malformed id", async () => {
    // A configured deployment, so the two answers are about the request and not about
    // this process's configuration.
    holder.current = runtime([]);
    const unknown = await request(app).post(reclassifyUrl("11111111-1111-1111-1111-111111111111"));
    expect(unknown.status).toBe(404);

    const malformed = await request(app).post(reclassifyUrl("not-a-uuid"));
    expect(malformed.status).toBe(422);
    const known = await createStack(app, "bound");
    const overBound = await request(app).post(`${reclassifyUrl(known)}?limit=0`);
    expect(overBound.status).toBe(422);
  });

  it("bounds one run and says so when there is more to do", async () => {
    const stackId = await createStack(app, "bounded");
    await ingest(app, stackId, BODY, ANSWER);
    holder.current = runtime(SAME_ANSWERS);

    const response = await request(app).post(`${reclassifyUrl(stackId)}?limit=1`).expect(200);

    // A bounded sweep must be legible as bounded (S9): one row per kind per run, and
    // `truncated` says the rest is still waiting.
    expect(response.body).toMatchObject({
      selected: { entities: 1, relationships: 1 },
      truncated: true,
    });
  });
});
