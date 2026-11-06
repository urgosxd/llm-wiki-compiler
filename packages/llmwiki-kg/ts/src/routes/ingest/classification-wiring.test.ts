/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/classification-wiring.test.ts
 * @description The three wiring facts the pipeline promises about classification:
 * an unconfigured classifier still ingests, a classifier with no bounded
 * transaction runner is refused loudly, and the classifier is never called with a
 * transaction open.
 *
 * WHY THIS FILE EXISTS. Each of these can fail silently.
 *
 * - "No credential" could turn into a dropped candidate, a 500, or an invented
 *   `free_no_match`; the test pins that every candidate is stored as `pending` and
 *   the request answers 200 (S25).
 * - A caller that injects only a request-scoped wrapper would run the classifier
 *   inside an open transaction while the response told nobody. That combination is
 *   REFUSED with a named error instead of degraded, and this test pins the refusal
 *   so it cannot become a silent fallback.
 * - The bounded-transaction claim itself (S44) is proven rather than described: the
 *   scripted double inspects `pg_stat_activity` at the moment it is asked, and
 *   checks that the candidate rows stage 1 wrote are already COMMITTED — visible
 *   from a connection that is not the request's.
 *
 * No network: the extraction provider is the shared fetch stub and the decision
 * client is `ScriptedJevClient`.
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
  // The unconfigured case is a property of the environment, so it is cleared here
  // rather than left to whatever the developer's shell happens to export.
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
import {
  ScriptedJevClient,
  choiceAnswer,
  noulAnswer,
  vendorResponse,
} from "../../core/jev/doubles.js";
import {
  ENTITY_CLASSIFICATION_QUESTIONS,
  RELATION_CLASSIFICATION_QUESTIONS,
  SUPPORT_QUESTION_ID,
} from "../../core/jev/questions.js";
import type { JevDecisionRequest, JevDecisionResponse } from "../../core/jev/types.js";
import { createIngestRouter } from "../ingest.js";
import { MISSING_RUNNER_MESSAGE } from "./router.js";
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
import type { ClassificationRuntime } from "./classify-stage.js";

useDomainPrefix("classify-wiring");

/** One chunk of prose with two entities and one relation in it. */
const BODY = "El Comité de Cambios ejecuta la gestión de cambios.";

/** The model's answer: one in-catalog triplet and one free entity. */
const ANSWER = {
  triplets: [
    {
      subject: { type: "role", name: "Comité de Cambios" },
      relation: { type: "ejecuta" },
      object: { type: "process", name: "Gestión de cambios" },
    },
  ],
  entities: [{ type: "unicornio", name: "Vex" }],
};

/** One scripted semantic-support answer, as the vendor documents a `choice` answer. */
function supportAnswer(label: "SUPPORTED" | "UNSUPPORTED"): JevScriptStep {
  return vendorResponse({ [SUPPORT_QUESTION_ID]: choiceAnswer(label, { [label]: 0.9 }, 0.8) });
}

/**
 * The seven answers this document needs, in call order.
 *
 * The support pass comes first — `Comité de Cambios`, `Gestión de cambios` and the
 * relation are the three candidates whose quote the source contains — then the four
 * classification questions.
 */
const SCRIPT: readonly JevScriptStep[] = [
  supportAnswer("SUPPORTED"),
  supportAnswer("SUPPORTED"),
  supportAnswer("SUPPORTED"),
  vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer("Role", { Role: 0.9 }, 0.9),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.95),
  }),
  vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer("Process", { Process: 0.9 }, 0.9),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.95),
  }),
  vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer("Role", { Role: 0.3 }, 0.3),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.02),
  }),
  vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer("executes", { executes: 0.9 }, 0.9),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.9),
  }),
];

/** What the database looked like while the classifier was being asked. */
interface Probe {
  readonly idleInTransaction: number;
  readonly pendingEntities: number;
  readonly pendingRelationships: number;
}

/**
 * A scripted double that observes the database before replaying its step.
 *
 * Extending the shipped double keeps the decision path real — the same
 * interpretation, the same thresholds — while giving the test a hook exactly where
 * the claim has to hold: the moment `decide` is called.
 */
class ProbeJevClient extends ScriptedJevClient {
  readonly probes: Probe[] = [];

  constructor(
    steps: readonly JevScriptStep[],
    private readonly stackId: string,
  ) {
    super(steps);
  }

  override async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    this.probes.push(await observe(this.stackId));
    return super.decide(request);
  }
}

/**
 * Reads the two facts the bounded-transaction claim needs.
 *
 * `idle in transaction` is the state a request-scoped transaction would sit in
 * while awaiting an external call, so a non-zero count at this instant is the
 * violation. The pending counts prove the opposite direction: stage 1's rows are
 * already visible from a connection that is not the request's, i.e. committed.
 */
async function observe(stackId: string): Promise<Probe> {
  const rows = await database().execute<{
    idle: number;
    pending_entities: number;
    pending_relationships: number;
  }>(sql`
    select
      (select count(*)::int from pg_stat_activity
        where datname = current_database() and state = 'idle in transaction') as idle,
      (select count(*)::int from ontology_entities
        where stack_id = ${stackId} and classification_state = 'pending') as pending_entities,
      (select count(*)::int from ontology_relationships
        where stack_id = ${stackId} and classification_state = 'pending') as pending_relationships
  `);
  const row = rows[0];
  return {
    idleInTransaction: row?.idle ?? -1,
    pendingEntities: row?.pending_entities ?? -1,
    pendingRelationships: row?.pending_relationships ?? -1,
  };
}

/** Builds an app from explicit dependencies, so each wiring can be exercised. */
function buildApp(overrides: Partial<IngestRouterDependencies>): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));
  const deps: IngestRouterDependencies = { wrap, apiKey, ...overrides };

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

/** Creates a Stack with no `type_catalog`, so the default catalog is in force. */
async function createStack(app: Express, label: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: `Wiring ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** Every candidate row of one Stack, by state. */
async function states(stackId: string): Promise<string[]> {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ classification_state: string | null }>(sql`
      select classification_state from ontology_entities where stack_id = ${stackId}
      union all
      select classification_state from ontology_relationships where stack_id = ${stackId}
    `),
  ).then((rows) => rows.map((row) => String(row.classification_state)));
}

describe.skipIf(skipReason !== false)("ingest without a configured classifier", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp({ run: createTransactionRunner(database()) });
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("persists every candidate as pending and answers 200 (S25)", async () => {
    const stackId = await createStack(app, "disabled");
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // Nothing is dropped and nothing is invented: the extraction still produced
    // four candidates and the graph holds four rows.
    expect(response.body).toMatchObject({ entities_extracted: 3, relationships_extracted: 1 });
    const rowStates = await states(stackId);
    expect(rowStates).toHaveLength(4);
    expect(new Set(rowStates)).toEqual(new Set(["pending"]));
    const logged = await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from kg_classification_log where stack_id = ${stackId}
      `),
    );
    expect(logged[0]?.n).toBe(0);
    // The evidence rows are written anyway: provenance is a stage-2 fact and does
    // not depend on anybody's decision.
    const evidence = await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from kg_evidence where stack_id = ${stackId}
      `),
    );
    expect(evidence[0]?.n).toBe(4);
  });

  it("never marks a row human-verified (S39)", async () => {
    const stackId = await createStack(app, "verified");
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute<{ verified: boolean; source_kind: string; pipeline: string }>(sql`
        select verified, source_kind, pipeline
        from ontology_entities where stack_id = ${stackId}
      `),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // `verified` keeps its AKS meaning: a human reviewed this fact. Ingestion is
      // not a human, and backfeed remains the only writer that sets it.
      expect(row).toEqual({
        verified: false,
        source_kind: "document",
        pipeline: "llamaindex-schema-extraction",
      });
    }
  });
});

describe.skipIf(skipReason !== false)("ingest classification wiring", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("refuses to classify without a bounded transaction runner (S44)", async () => {
    // Classification enabled, no runner: the request-scoped wrapper would hold a
    // transaction open across every classifier call. Refused, never degraded.
    const runtime: ClassificationRuntime = {
      client: new ScriptedJevClient(SCRIPT),
      config: parseJevConfig({}),
    };
    const app = buildApp({ decisions: () => runtime });
    const stackId = await createStack(app, "no-runner");
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);

    const response = await request(app).post(ingestUrl(stackId, documentId));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ detail: MISSING_RUNNER_MESSAGE });
    // And nothing was written: the refusal happens before any stage runs.
    expect(await states(stackId)).toEqual([]);
  });

  it("asks the classifier with no transaction open and the rows committed (S44)", async () => {
    // The Stack is created first, because the probe has to watch ITS rows.
    const stackId = await createStack(buildApp({}), "probe");
    const probe = new ProbeJevClient(SCRIPT, stackId);
    const app = buildApp({
      run: createTransactionRunner(database()),
      decisions: () => ({ client: probe, config: parseJevConfig({}) }),
    });
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // One probe per question: three support questions, then three entities and the
    // relation. Every one of them is an external call, so every one of them is a
    // moment at which no transaction may be open.
    expect(probe.probes).toHaveLength(7);
    // At EVERY one of those moments no connection of this database was sitting
    // `idle in transaction` — the state a request-scoped transaction would be in
    // while awaiting the classifier.
    expect(probe.probes.map((moment) => moment.idleInTransaction)).toEqual([
      0, 0, 0, 0, 0, 0, 0,
    ]);
    // And stage 1's rows were already committed and visible from a connection
    // that is not the request's, which is the positive half of the same claim.
    expect(probe.probes[0]).toMatchObject({ pendingEntities: 3, pendingRelationships: 1 });
    // The decisions then landed, which proves the second bounded transaction ran.
    expect((await states(stackId)).sort()).toEqual([
      "classified",
      "classified",
      "classified",
      "free_no_match",
    ]);
  });
});
