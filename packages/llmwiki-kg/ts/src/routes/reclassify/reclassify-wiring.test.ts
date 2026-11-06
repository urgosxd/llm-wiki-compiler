/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/reclassify-wiring.test.ts
 * @description The two things a reclassification run can get catastrophically
 * wrong without failing loudly: an outage that erases a decision, and an open
 * transaction spanning the classifier.
 *
 * WHY THIS FILE EXISTS.
 *
 * - A provider failure is the ordinary condition of a flaky decision service. If
 *   reclassification turned it into `free_no_match`, a fact would be reported as
 *   "nothing in the catalog fits" because a socket closed, and if it overwrote a
 *   `classified` row the graph would lose a type it had already established
 *   (S25, S45.13).
 * - S44 is a claim about WHERE the transaction is, and the only way to prove it is
 *   to look at the database at the moment the provider is called. The scripted
 *   double reads `pg_stat_activity` there, exactly as the ingest wiring proof does.
 *
 * No network: the extraction provider is the shared fetch stub and the decision
 * client is a scripted double.
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
import { JevProviderError } from "../../core/jev/types.js";
import type { JevDecisionRequest, JevDecisionResponse } from "../../core/jev/types.js";
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
import type { ClassificationRuntime } from "../ingest/classify-stage.js";

useDomainPrefix("reclassify-wiring");

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
function relationAnswer(label: string): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.9 }, 0.8),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.9),
  });
}

/** One scripted semantic-support answer. */
function supportAnswer(): JevScriptStep {
  return vendorResponse({
    [SUPPORT_QUESTION_ID]: choiceAnswer("SUPPORTED", { SUPPORTED: 0.9 }, 0.8),
  });
}

/** The whole ingest script for {@link ANSWER}: three support questions, three decisions. */
const INGEST_SCRIPT: readonly JevScriptStep[] = [
  supportAnswer(),
  supportAnswer(),
  supportAnswer(),
  entityAnswer("Role", 0.95),
  entityAnswer("Process", 0.95),
  relationAnswer("executes"),
];

/** The three decisions a reclassification run asks for, all succeeding. */
const SAME_ANSWERS: readonly JevScriptStep[] = [
  entityAnswer("Role", 0.95),
  entityAnswer("Process", 0.95),
  relationAnswer("executes"),
];

/** A provider condition that cannot be retried away, as the adapter classifies it. */
function providerRefusal(): Error {
  return new JevProviderError(
    "provider_answered",
    "the decision service answered 400 for POST /v1/systemone",
    "https://api.typesafe.ai/v1/systemone",
    400,
  );
}

/** A catalog the Stack can be moved to, so every stored decision is stale. */
const SECOND_CATALOG = {
  version: "2.0.0",
  entityTypes: [
    { name: "Role", definition: "A part played by an actor in a process." },
    { name: "Process", definition: "A sequence of steps that produces an outcome." },
  ],
  relationTypes: [{ name: "executes", definition: "An actor carries out a process." }],
};

/** Holds the runtime each request should see. */
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

/** Builds a runtime over a scripted client, so the test can read its requests. */
function runtime(steps: readonly JevScriptStep[]): ClassificationRuntime {
  return { client: new ScriptedJevClient(steps), config: parseJevConfig({}) };
}

/** Creates a Stack with no `type_catalog`, so the documented default is in force. */
async function createStack(app: Express, label: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: `Wiring ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** Ingests {@link ANSWER} into a fresh document. */
async function ingestAnswer(app: Express, stackId: string): Promise<void> {
  const documentId = await createDocument(stackId, BODY);
  setToolResponse([ANSWER]);
  await request(app).post(ingestUrl(stackId, documentId)).expect(200);
}

/** Moves the Stack's catalog to {@link SECOND_CATALOG}, so every stored decision is stale. */
async function bumpCatalog(stackId: string): Promise<void> {
  await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute(sql`
      update stacks set type_catalog = ${JSON.stringify(SECOND_CATALOG)}::jsonb where id = ${stackId}
    `),
  );
}

/** Every classification state this Stack holds, entities and relations together. */
async function states(stackId: string): Promise<string[]> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ classification_state: string | null; canonical_type: string | null }>(sql`
      select classification_state, canonical_type from ontology_entities where stack_id = ${stackId}
      union all
      select classification_state, canonical_type from ontology_relationships where stack_id = ${stackId}
    `),
  );
  return rows.map((row) => `${String(row.classification_state)}:${String(row.canonical_type)}`);
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

/** Reads how many connections of this database sit idle inside a transaction. */
async function idleInTransaction(): Promise<number> {
  const rows = await database().execute<{ idle: number }>(sql`
    select count(*)::int as idle from pg_stat_activity
    where datname = current_database() and state = 'idle in transaction'
  `);
  return rows[0]?.idle ?? -1;
}

/** A scripted double that observes the database before replaying its step. */
class ProbeJevClient extends ScriptedJevClient {
  readonly moments: number[] = [];

  override async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    this.moments.push(await idleInTransaction());
    return super.decide(request);
  }
}

describe.skipIf(skipReason !== false)("a provider failure during reclassification", () => {
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

  it("leaves the row operational, never free, and never drops it (S45.13)", async () => {
    const stackId = await createStack(app, "failed");
    await ingestAnswer(app, stackId);
    const evidenceBefore = await evidenceCount(stackId);

    // The first candidate's question hits a refusal; the run carries on with the rest.
    holder.current = runtime([
      providerRefusal(),
      entityAnswer("Process", 0.95),
      relationAnswer("executes"),
    ]);
    const response = await request(app).post(`/stacks/${stackId}/reclassify`).expect(200);

    expect(response.body).toMatchObject({ applied: 3, changed: 3 });
    const after = await states(stackId);
    // The refused candidate is `failed` with no canonical type — an operational
    // problem, which is exactly what it is, and explicitly NOT `free_no_match`.
    // The other two were decided normally.
    expect(after.sort()).toEqual(["classified:Process", "classified:executes", "failed:null"]);
    expect(after.filter((entry) => entry.startsWith("free_no_match"))).toEqual([]);
    // Nothing was lost: the row and its provenance are still there.
    expect(await states(stackId)).toHaveLength(3);
    expect(await evidenceCount(stackId)).toBe(evidenceBefore);
  });

  it("never overwrites a stored decision with an outage (S45.13, S43)", async () => {
    const stackId = await createStack(app, "preserved");
    holder.current = runtime(INGEST_SCRIPT);
    await ingestAnswer(app, stackId);
    await bumpCatalog(stackId);

    holder.current = runtime([providerRefusal(), providerRefusal(), providerRefusal()]);
    const response = await request(app).post(`/stacks/${stackId}/reclassify`).expect(200);

    // A transient outage must not erase a type the graph already established: the
    // row keeps its decision, and the run reports that it preserved rather than
    // decided.
    expect(response.body).toMatchObject({ preserved_after_failure: 3, changed: 0 });
    expect((await states(stackId)).sort()).toEqual([
      "classified:Process",
      "classified:Role",
      "classified:executes",
    ]);
  });
});

describe.skipIf(skipReason !== false)("reclassification keeps transactions bounded", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("asks the classifier with no transaction open (S44)", async () => {
    const holder: Holder = { current: undefined };
    const app = buildApp(holder);
    const stackId = await createStack(app, "probe");
    await ingestAnswer(app, stackId);
    await bumpCatalog(stackId);

    const probe = new ProbeJevClient(SAME_ANSWERS);
    holder.current = { client: probe, config: parseJevConfig({}) };
    await request(app).post(`/stacks/${stackId}/reclassify`).expect(200);

    // One observation per question, and at every one of them no connection of this
    // database was sitting `idle in transaction`: the read transaction committed
    // before the first call and the write one opened after the last.
    expect(probe.moments).toHaveLength(3);
    expect(probe.moments).toEqual(probe.moments.map(() => 0));
  });
});
