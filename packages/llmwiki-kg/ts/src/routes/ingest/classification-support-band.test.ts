/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/classification-support-band.test.ts
 * @description The support band's SILENT half: one ingest through the real
 * pipeline that ends with a STORED `support_state = 'uncertain'`.
 *
 * WHY THIS FILE EXISTS. `supported` and `unsupported` are produced end to end by
 * `support-wiring.test.ts`. `uncertain` — the only value the 0.6 support band
 * exists to produce — was produced by no pipeline test at all: its appearances were
 * hand-seeded read-path fixtures. Mis-wire that band to always-`supported` and every
 * classified row silently claims the claim is supported, with nothing red anywhere
 * and no way to notice from the stored graph.
 *
 * ## The numbers are chosen so no other band can shadow the support arm
 *
 * The support answer's top probability is 0.55, under the 0.6 support band, so
 * `interpretSupport` abstains. The classification answer for the same candidate
 * carries a 0.8 catalog fit — above the 0.65 uncertain-fit band, so neither the
 * no-match nor the uncertain-fit arm fires — and a 0.8 top probability, above the
 * 0.45 minimum. The classification question therefore reaches `classified`, which
 * makes the stored row the proof that the two axes are independent: a confidently
 * classified candidate whose support is still undecided.
 *
 * The two judgements are also scripted differently within one run — `Runbook` is
 * undecided, `Política anterior` is supported — so a stored `uncertain` cannot be a
 * value the writer puts on every row.
 *
 * ## What is asserted, and the one thing this file cannot assert
 *
 * The assertions are on the STORED row. The verbatim uncertain-support reason
 * (`SUPPORT_REASON_UNCERTAIN`, `core/jev/interpret.ts`) is deliberately NOT asserted
 * here: nothing stores it. `support-stage.ts` builds a `SemanticSupport` carrying
 * that reason, and the only support column either decision table has is
 * `support_state` — `kg_evidence` has no rationale column either — so a stored-row
 * assertion of that string could only be written against a production change. The
 * reason string itself is pinned, DB-free, in `core/jev/interpret-support.test.ts`.
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
import { choiceAnswer, noulAnswer, scriptedJevClient, vendorResponse } from "../../core/jev/doubles.js";
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
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import type { ClassificationRuntime } from "./classify-stage.js";

useDomainPrefix("support-band");

/** The prose. Every quote below is looked for in exactly this text. */
const BODY = "El runbook deja sin efecto la política anterior.";

/** One triplet whose quotes the source contains, plus one entity it does not. */
const ANSWER = {
  triplets: [
    {
      subject: { type: "document", name: "Runbook" },
      relation: { type: "deja sin efecto" },
      object: { type: "policy", name: "Política anterior" },
    },
  ],
  entities: [{ type: "unicornio", name: "Vex" }],
};

/** The support answer's top probability: under the 0.6 band, so the arm abstains. */
const UNDECIDED_SUPPORT_TOP = 0.55;

/** A top probability comfortably above the 0.6 band, for the candidate that decides. */
const DECIDED_SUPPORT_TOP = 0.92;

/** A catalog fit above the 0.65 uncertain-fit band, and a top above the 0.45 minimum. */
const CLASSIFIED_FIT = 0.8;
const CLASSIFIED_TOP = 0.8;

/** One scripted semantic-support answer, spread over the two documented options. */
function supportAnswer(label: "SUPPORTED" | "UNSUPPORTED", top: number): JevScriptStep {
  const other = label === "SUPPORTED" ? "UNSUPPORTED" : "SUPPORTED";
  return vendorResponse({
    [SUPPORT_QUESTION_ID]: choiceAnswer(label, { [label]: top, [other]: 1 - top }, 0.8),
  });
}

/** One scripted entity-classification answer. */
function entityAnswer(label: string, top: number, fits: number): JevScriptStep {
  return vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: top }, 0.8),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** One scripted relation-classification answer. */
function relationAnswer(label: string, top: number, fits: number): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: top }, 0.8),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/**
 * The whole script for one ingest of {@link ANSWER}, in call order.
 *
 * Three support questions first — `Runbook` (the one that lands undecided),
 * `Política anterior` and the relation — then the four classification questions.
 * `Vex` appears in no support question: the source does not contain its quote.
 */
const SCRIPT: readonly JevScriptStep[] = [
  supportAnswer("SUPPORTED", UNDECIDED_SUPPORT_TOP),
  supportAnswer("SUPPORTED", DECIDED_SUPPORT_TOP),
  supportAnswer("SUPPORTED", 0.88),
  entityAnswer("Document", CLASSIFIED_TOP, CLASSIFIED_FIT),
  entityAnswer("Policy", 0.85, 0.85),
  entityAnswer("Role", 0.3, 0.02),
  relationAnswer("governs", 0.7, 0.03),
];

/** The decision runtime a test injects: the double plus the shipped thresholds. */
function runtime(steps: readonly JevScriptStep[] = SCRIPT): ClassificationRuntime {
  return { client: scriptedJevClient(steps), config: parseJevConfig({}) };
}

/** Builds an app with the production transaction shape over the fixture pool. */
function buildApp(classification: ClassificationRuntime): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));
  const deps: IngestRouterDependencies = {
    wrap,
    apiKey,
    run: createTransactionRunner(database()),
    decisions: () => classification,
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

/** Creates a Stack with no `type_catalog`, so the default catalog is in force. */
async function createStack(app: Express, label: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: `Support band ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** Ingests {@link ANSWER} into a fresh document and returns the response. */
async function ingestAnswer(app: Express, stackId: string) {
  const documentId = await createDocument(stackId, BODY);
  setToolResponse([ANSWER]);
  return request(app).post(ingestUrl(stackId, documentId)).expect(200);
}

/** Every entity row of one Stack, with the support and classification columns. */
async function entityRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      name: string;
      classification_state: string | null;
      canonical_type: string | null;
      support_state: string | null;
    }>(sql`
      select name, classification_state, canonical_type, support_state
      from ontology_entities where stack_id = ${stackId} order by name
    `),
  );
}

describe.skipIf(skipReason !== false)("ingest stores the support band's undecided verdict", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("stores uncertain support on a row the classifier confidently classified (S3)", async () => {
    const app = buildApp(runtime());
    const stackId = await createStack(app, "uncertain");
    await ingestAnswer(app, stackId);

    const rows = await entityRows(stackId);
    const runbook = rows.find((row) => row.name === "Runbook");
    // A 0.55 top probability is under the 0.6 support band, so the judgement is
    // stored as undecided rather than being rounded into a direction.
    expect(runbook?.support_state).toBe("uncertain");
    // The same row's classification axis is settled: an 0.8 fit and an 0.8 top clear
    // both classification bands. Support and classification are independent (S32).
    expect(runbook?.classification_state).toBe("classified");
    expect(runbook?.canonical_type).toBe("Document");

    const policy = rows.find((row) => row.name === "Política anterior");
    // The same run's other candidate is decided, so `uncertain` is not a value the
    // writer puts on every row.
    expect(policy?.support_state).toBe("supported");
  });
});
