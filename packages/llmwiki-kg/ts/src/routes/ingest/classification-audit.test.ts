/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/classification-audit.test.ts
 * @description The classifier's CONFIGURATION STATE is observable at runtime, and an
 * unconfigured run that leaves knowledge unclassified says so where a consumer reads.
 *
 * WHY THIS FILE EXISTS. Two consequences of running without a JEV credential were
 * only true in prose:
 *
 * 1. every candidate stays `pending`, and a canonical `?type=` filter returns only
 *    CLASSIFIED rows — so a deployment with no credential answers type filters with
 *    nothing for everything it ingests; and
 * 2. nothing in the running system said so. The audit section used to be ABSENT when
 *    no classifier ran, which is indistinguishable from a build that never wrote one.
 *
 * So the section is now always written, with `configured` as an explicit boolean in
 * both directions, plus the `?type=` consequence when it is false and a structured
 * warning when candidates were actually left unclassified. Both are read back through
 * the document endpoint, because that is where a consumer looks.
 *
 * The nine-key ingest response is untouched: it is oracle-parity pinned.
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

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import { createDocumentsRouter } from "../documents.js";
import { createStacksRouter } from "../stacks.js";
import { createIngestRouter } from "../ingest.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "../../core/extraction-harness.js";
import { choiceAnswer, noulAnswer, scriptedJevClient, vendorResponse } from "../../core/jev/doubles.js";
import type { JevScriptStep } from "../../core/jev/doubles.js";
import { parseJevConfig } from "../../core/jev/config.js";
import { SUPPORT_QUESTION_ID } from "../../core/jev/questions.js";
import {
  ENTITY_CLASSIFICATION_QUESTIONS,
  RELATION_CLASSIFICATION_QUESTIONS,
} from "../../core/jev/questions.js";
import { classificationRuntime } from "./classify-stage.js";
import type { ClassificationRuntime } from "./classify-stage.js";
import {
  CLASSIFICATION_DISABLED_CONSEQUENCE,
  UNCLASSIFIED_WARNING_CODE,
  unclassifiedWarningMessage,
} from "./audit.js";

useDomainPrefix("classifaudit");

const BODY = "Acme employs Ada Lovelace, and nobody employs Vex the construct.";

/** A triplet entirely inside the default catalog, so a configured run classifies it. */
const IN_CATALOG = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "employs" },
  object: { type: "PERSON", name: "Ada Lovelace" },
};

/** A triplet the catalog names nothing of: the case that must never be silent. */
const OUTSIDE_CATALOG = {
  subject: { type: "ALIEN_CONSTRUCT", name: "Vex the construct" },
  relation: { type: "deja sin efecto" },
  object: { type: "PERSON", name: "Nobody" },
};

/** Builds an app with the production transaction shape and an injected classifier. */
function buildApp(decisions: () => ClassificationRuntime | undefined): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));

  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  app.use(createIngestRouter({ wrap, apiKey, run: createTransactionRunner(database()), decisions }));
  // The document read is where a consumer looks for the audit, so it is mounted.
  app.use(createDocumentsRouter({ wrap, apiKey }));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** One support answer, as the vendor documents a `choice` response. */
function supported(): JevScriptStep {
  return vendorResponse({ [SUPPORT_QUESTION_ID]: choiceAnswer("SUPPORTED", { SUPPORTED: 0.95 }, 0.8) });
}

/** One entity decision inside the catalog. */
function classified(label: string): JevScriptStep {
  return vendorResponse({
    [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.9 }, 0.8),
    [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.95),
  });
}

/** One relation decision inside the catalog. */
function relationClassified(label: string): JevScriptStep {
  return vendorResponse({
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.9 }, 0.8),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.95),
  });
}

/** The classifier double a configured run injects: the shipped thresholds, no network. */
function configuredRuntime(steps: readonly JevScriptStep[]): ClassificationRuntime {
  return {
    client: scriptedJevClient(steps),
    config: parseJevConfig({}),
    redactedBaseUrl: "https://api.typesafe.ai",
  };
}

/**
 * The audit blob as the document endpoint returns it.
 *
 * Read through HTTP on purpose: a consequence nobody can fetch is not observable.
 *
 * @param app - The running app.
 * @param stackId - The Stack that owns the document.
 * @param documentId - The ingested document.
 * @returns The stored `audit` object.
 */
async function auditOf(app: Express, stackId: string, documentId: string): Promise<Record<string, unknown>> {
  const stored = await request(app).get(`/stacks/${stackId}/documents/${documentId}`).expect(200);
  return (stored.body.audit ?? {}) as Record<string, unknown>;
}

describe.skipIf(skipReason !== false)("the audit reports whether a classifier is configured", () => {
  let sequence = 0;

  /** Unique domain per call, carrying this file's cleanup prefix. */
  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-classifaudit-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  /** Creates a Stack with no catalog of its own, so the documented default applies. */
  async function createStack(app: Express, label: string): Promise<string> {
    const created = await request(app)
      .post("/stacks")
      .send({ name: `Classif Audit ${label}`, domain: domain(label) })
      .expect(201);
    return String(created.body.id);
  }

  beforeEach(async () => {
    await deleteFixtureRows();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("publishes configured:false and the type-filter consequence when no credential exists", async () => {
    const app = buildApp(() => undefined);
    setToolResponse([{ triplets: [OUTSIDE_CATALOG] }]);
    const stackId = await createStack(app, "unconfigured");
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const classification = (await auditOf(app, stackId, documentId))["classification"];
    expect(classification).toMatchObject({
      configured: false,
      consequence: CLASSIFICATION_DISABLED_CONSEQUENCE,
    });
    // The consequence names the filter it costs, in the query syntax a consumer writes.
    expect(CLASSIFICATION_DISABLED_CONSEQUENCE).toContain("?type=");
    // And nothing is invented about a model that never ran.
    expect(classification).not.toHaveProperty("model");
    expect(classification).not.toHaveProperty("base_url");
  });

  it("warns, with a code and the consequence, when candidates were left unclassified", async () => {
    const app = buildApp(() => undefined);
    setToolResponse([{ triplets: [OUTSIDE_CATALOG] }]);
    const stackId = await createStack(app, "warning");
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const classification = (await auditOf(app, stackId, documentId))["classification"] as {
      warnings: Array<{ code: string; message: string }>;
    };
    // Two entity endpoints and one edge: every candidate the run kept is `pending`,
    // because an unconfigured classifier cannot answer anything.
    expect(classification.warnings).toEqual([
      { code: UNCLASSIFIED_WARNING_CODE, message: unclassifiedWarningMessage(3) },
    ]);
    expect(classification.warnings[0]?.message).toContain("?type=");
  });

  it("still publishes the section for an in-vocabulary run, because the consequence is the same", async () => {
    // A clean document does not escape the consequence: without a classifier, even a
    // candidate whose proposal the catalog names stays unclassified.
    const app = buildApp(() => undefined);
    setToolResponse([{ triplets: [IN_CATALOG] }]);
    const stackId = await createStack(app, "clean");
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const classification = (await auditOf(app, stackId, documentId))["classification"];
    expect(classification).toMatchObject({ configured: false });
    expect(JSON.stringify(classification)).toContain("?type=");
  });

  it("publishes configured:true with the model and base URL, and no warning, when it ran", async () => {
    const app = buildApp(() =>
      configuredRuntime([
        supported(),
        supported(),
        supported(),
        classified("Role"),
        classified("Process"),
        relationClassified("executes"),
      ]),
    );
    setToolResponse([{ triplets: [IN_CATALOG] }]);
    const stackId = await createStack(app, "configured");
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const classification = (await auditOf(app, stackId, documentId))["classification"];
    expect(classification).toMatchObject({
      configured: true,
      model: "jev-latest",
      base_url: "https://api.typesafe.ai",
    });
    // A classifier that answered says nothing about an unclassified consequence.
    expect(classification).not.toHaveProperty("warnings");
    expect(classification).not.toHaveProperty("consequence");
    expect(JSON.stringify(classification)).not.toContain("?type=");
  });
});

describe("the classification runtime never publishes a credential", () => {
  it("redacts a key pasted into the configured base URL", () => {
    // The base URL is stored in the audit and returned by the document endpoint, so a
    // credential in it would be published on every read.
    const runtime = classificationRuntime({
      TYPESAFE_API_KEY: "sk-THE-SECRET-SENTINEL",
      LLMWIKI_JEV_BASE_URL: "https://sk-THE-SECRET-SENTINEL.example/v1",
    });

    expect(runtime).toBeDefined();
    expect(runtime?.redactedBaseUrl).not.toContain("sk-THE-SECRET-SENTINEL");
    expect(runtime?.redactedBaseUrl).toContain("example");
  });

  it("reports no runtime at all when the credential is blank", () => {
    expect(classificationRuntime({ TYPESAFE_API_KEY: "   " })).toBeUndefined();
  });
});
