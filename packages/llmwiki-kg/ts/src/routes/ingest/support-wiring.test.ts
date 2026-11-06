/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/support-wiring.test.ts
 * @description Stage 2b of the ingest pipeline: the SEMANTIC support question, and
 * the three outcomes it is allowed to produce (S12, S20, S23).
 *
 * WHY THIS FILE EXISTS. Locating a quote proves the source contains the words; it
 * says nothing about whether those words back the claim the extractor made of them
 * (S12). Those are two different questions asked of two different things, and the
 * pipeline used to answer only the first: every positive verdict of presence was
 * stored while `support_state` stayed NULL forever.
 *
 * The four facts pinned here are exactly the ones that can silently rot:
 *
 * 1. a located quote the classifier marks as NOT supporting the claim stores
 *    `support_state = 'unsupported'` while the classification verdict stays
 *    whatever the classification question decided — the two are independent;
 * 2. a located quote marked as supporting stores `supported`;
 * 3. a quote the source does not contain is NEVER asked about, so its row keeps a
 *    NULL `support_state` and gains no semantic evidence row — the absence of a
 *    judgement is representable, and is not the same value as `uncertain`;
 * 4. a provider failure leaves the question UNANSWERED (NULL), never `unsupported`:
 *    an outage must not be laundered into a judgement about the source.
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
import { JevProviderError } from "../../core/jev/types.js";
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

useDomainPrefix("support");

/** The prose. Every quote below is looked for in exactly this text. */
const BODY = "El runbook deja sin efecto la política anterior.";

/** One triplet whose verb no catalog names, plus one entity nothing mentions. */
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

/** One scripted semantic-support answer. */
function supportAnswer(label: "SUPPORTED" | "UNSUPPORTED", top: number): JevScriptStep {
  return vendorResponse({ [SUPPORT_QUESTION_ID]: choiceAnswer(label, { [label]: top }, 0.7) });
}

/** One scripted entity-classification answer. */
function entityAnswer(label: string, fits: number): JevScriptStep {
  return vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.9 }, 0.8),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/** One scripted relation-classification answer. */
function relationAnswer(label: string, fits: number): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.4 }, 0.8),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/**
 * The whole script for one ingest of {@link ANSWER}, in call order.
 *
 * Three support questions first — `Runbook`, `Política anterior` and the relation,
 * which are the three candidates whose quote the source contains — then the four
 * classification questions. `Vex` appears in neither pass's support question.
 */
const SCRIPT: readonly JevScriptStep[] = [
  supportAnswer("UNSUPPORTED", 0.9),
  supportAnswer("SUPPORTED", 0.92),
  supportAnswer("SUPPORTED", 0.88),
  entityAnswer("Document", 0.95),
  entityAnswer("Policy", 0.94),
  entityAnswer("Role", 0.02),
  relationAnswer("governs", 0.03),
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
    .send({ name: `Support ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** Ingests {@link ANSWER} and returns the response. */
async function ingestAnswer(app: Express, stackId: string) {
  const documentId = await createDocument(stackId, BODY);
  setToolResponse([ANSWER]);
  return request(app).post(ingestUrl(stackId, documentId)).expect(200);
}

/** Every entity row of one Stack, with the two decision columns. */
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

/** Every relationship row of one Stack, with the two decision columns. */
async function relationshipRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      predicate: string | null;
      classification_state: string | null;
      canonical_type: string | null;
      support_state: string | null;
    }>(sql`
      select predicate, classification_state, canonical_type, support_state
      from ontology_relationships where stack_id = ${stackId} order by predicate
    `),
  );
}

/** Every evidence row of one Stack, with the kind and the candidate ref. */
async function evidenceRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ candidate_kind: string; candidate_ref: string; evidence_text: string; evidence_kind: string }>(
      sql`
        select candidate_kind, candidate_ref, evidence_text, evidence_kind
        from kg_evidence where stack_id = ${stackId} order by evidence_text, evidence_kind
      `,
    ),
  );
}

describe.skipIf(skipReason !== false)("ingest asks the semantic-support question", () => {
  beforeEach(async () => {
    await deleteFixtureRows();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("records an unsupporting quote as unsupported, beside the classification verdict (S12)", async () => {
    const app = buildApp(runtime());
    const stackId = await createStack(app, "unsupported");
    await ingestAnswer(app, stackId);

    const runbook = (await entityRows(stackId)).find((row) => row.name === "Runbook");
    // The classifier said the quote does NOT support "Runbook is a Document", and
    // the classification question independently said it IS a Document. Both truths
    // are stored, each in its own column (S23).
    expect(runbook).toMatchObject({
      classification_state: "classified",
      canonical_type: "Document",
      support_state: "unsupported",
    });

    const policy = (await entityRows(stackId)).find((row) => row.name === "Política anterior");
    expect(policy).toMatchObject({
      classification_state: "classified",
      canonical_type: "Policy",
      support_state: "supported",
    });
  });

  it("keeps support and classification independent on a free relation (S20, S32)", async () => {
    const app = buildApp(runtime());
    const stackId = await createStack(app, "free-relation");
    await ingestAnswer(app, stackId);

    const free = (await relationshipRows(stackId)).find((row) => row.predicate === "deja sin efecto");
    // The source supports the assertion, and no catalog type fits it: a supported
    // fact that stays free is the combination S3 defines as normal.
    expect(free).toEqual({
      predicate: "deja sin efecto",
      classification_state: "free_no_match",
      canonical_type: null,
      support_state: "supported",
    });
  });

  it("never asks about a quote the source does not contain, and records no verdict (S12)", async () => {
    const client = scriptedJevClient(SCRIPT);
    const app = buildApp({ client, config: parseJevConfig({}) });
    const stackId = await createStack(app, "absent");
    await ingestAnswer(app, stackId);

    const vex = (await entityRows(stackId)).find((row) => row.name === "Vex");
    // NULL is "nobody judged this", which is not `uncertain` (a judgement that
    // could not decide) and not `unsupported` (a judgement against the claim).
    expect(vex?.support_state).toBeNull();

    // Three support questions were asked, and none of them named the absent quote.
    const supportRequests = client.requests.filter((asked) =>
      Object.keys(asked.questions).includes(SUPPORT_QUESTION_ID),
    );
    expect(supportRequests).toHaveLength(3);
    expect(supportRequests.some((asked) => asked.state.includes("Vex"))).toBe(false);
    // One evidence row, textual only: presence is the fact that was established.
    const vexEvidence = (await evidenceRows(stackId)).filter((row) =>
      row.evidence_text.includes("Vex"),
    );
    expect(vexEvidence.map((row) => row.evidence_kind)).toEqual(["textual"]);
  });

  it("stores the semantic judgement as its own evidence row (S12, S10)", async () => {
    const app = buildApp(runtime());
    const stackId = await createStack(app, "evidence-kind");
    await ingestAnswer(app, stackId);

    const rows = await evidenceRows(stackId);
    const runbook = rows.filter((row) => row.evidence_text === "Runbook");
    // Two rows for one quote: `textual` for "the source contains these words",
    // `semantic` for "and here is what was decided about their meaning". The
    // candidate ref is shared so the pair is recoverable.
    expect(runbook.map((row) => row.evidence_kind)).toEqual(["semantic", "textual"]);
    expect(new Set(runbook.map((row) => row.candidate_ref)).size).toBe(1);
    expect(rows.filter((row) => row.evidence_kind === "textual")).toHaveLength(4);
    expect(rows.filter((row) => row.evidence_kind === "semantic")).toHaveLength(3);
  });

  it("leaves the support question unanswered when the provider fails (S25, S12)", async () => {
    // The FIRST support question fails; the rest of the run must continue.
    const failure = new JevProviderError("provider_failed", "gateway unavailable", "https://jev.invalid");
    const app = buildApp(runtime([failure, ...SCRIPT.slice(1)]));
    const stackId = await createStack(app, "support-failure");
    await ingestAnswer(app, stackId);

    const runbook = (await entityRows(stackId)).find((row) => row.name === "Runbook");
    // An outage is not a judgement: the column stays NULL rather than claiming the
    // source does not support the claim.
    expect(runbook?.support_state).toBeNull();
    // And the classification half is unaffected, which is what proves the two
    // questions fail independently.
    expect(runbook?.classification_state).toBe("classified");
    const runbookEvidence = (await evidenceRows(stackId)).filter(
      (row) => row.evidence_text === "Runbook",
    );
    expect(runbookEvidence.map((row) => row.evidence_kind)).toEqual(["textual"]);
  });
});
