/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/classification.test.ts
 * @description What one ingest writes when a classifier ran: the states, the
 * predicates, the evidence and the classification history.
 *
 * WHY THIS FILE EXISTS. T7-T9 proved the classification STAGE is right in
 * isolation, over pure functions and a scripted client. Nothing proved the
 * pipeline WIRES it: that the decision reaches the row, that the row keeps what
 * the extractor proposed, that the evidence is stored with offsets a reader can
 * verify, and that the transition is traceable afterwards. Those are four
 * different stores (the entity row, the relationship row, `kg_evidence`,
 * `kg_classification_log`) and only an HTTP request can produce all four.
 *
 * ## Every answer the model gives is scripted, and every Jev call is a double
 *
 * The extraction provider comes from `core/extraction-harness.js` and the decision
 * client is `ScriptedJevClient`, so nothing here touches a network. The catalog is
 * the documented default (Role, Process, Document, Policy, System and the five
 * example relations), which is what a Stack with no `type_catalog` of its own is
 * classified against.
 *
 * ## Assertions read STORAGE, not the response
 *
 * `IngestionResult` is nine fixed keys, so it cannot carry a classification state.
 * What matters is what the graph holds, and that is what is asserted — through the
 * tables the read paths use, scoped to the fixture's tenant.
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
import { ENTITY_CLASSIFICATION_QUESTIONS, RELATION_CLASSIFICATION_QUESTIONS } from "../../core/jev/questions.js";
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

useDomainPrefix("classify");

/** The document's prose. Candidate quotes are looked for in exactly this text. */
const BODY =
  "El Comité de Cambios ejecuta la gestión de cambios. El runbook deja sin efecto la política anterior.";

/** One triplet whose proposal IS in the default catalog's vocabulary. */
const ROLE_TRIPLET = {
  subject: { type: "role", name: "Comité de Cambios" },
  relation: { type: "ejecuta" },
  object: { type: "process", name: "Gestión de cambios" },
};

/** One triplet whose predicate no catalog names. */
const FREE_TRIPLET = {
  subject: { type: "policy", name: "Política anterior" },
  relation: { type: "deja sin efecto" },
  object: { type: "document", name: "runbook" },
};

/** One entity whose proposed type is in no vocabulary at all. */
const FREE_ENTITY = { type: "unicornio", name: "Vex" };

/** The model's whole answer for the document above. */
const ANSWER = { triplets: [ROLE_TRIPLET, FREE_TRIPLET], entities: [FREE_ENTITY] };

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

/**
 * The seven answers this document needs, in candidate order.
 *
 * Entities first (the four endpoints, then the standalone entity), then relations:
 * `ejecuta` and `deja sin efecto`. The two free decisions use a low "fits"
 * probability, which is the abstention S21 defines as `NO_MATCH`.
 */
const SCRIPT: readonly JevScriptStep[] = [
  entityAnswer("Role", { Role: 0.9, Process: 0.05 }, 0.95),
  entityAnswer("Process", { Process: 0.88, Role: 0.1 }, 0.9),
  entityAnswer("Policy", { Policy: 0.4, Document: 0.3 }, 0.05),
  entityAnswer("Document", { Document: 0.92 }, 0.93),
  entityAnswer("Role", { Role: 0.3, System: 0.2 }, 0.02),
  relationAnswer("executes", { executes: 0.9 }, 0.9),
  relationAnswer("governs", { governs: 0.4, supports: 0.3 }, 0.03),
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
    .send({ name: `Classify ${label}`, domain: `${label}-${Date.now().toString(36)}` })
    .expect(201);
  return String(created.body.id);
}

/** Ingests {@link ANSWER} into a fresh document and returns the response. */
async function ingestAnswer(app: Express, stackId: string) {
  const documentId = await createDocument(stackId, BODY);
  setToolResponse([ANSWER]);
  const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);
  return { documentId, response };
}

/** Every entity row of one Stack, with the classification columns. */
async function entityRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      name: string;
      type: string;
      proposed_type: string | null;
      classification_state: string | null;
      canonical_type: string | null;
      identity_key: string;
    }>(sql`
      select name, type, proposed_type, classification_state, canonical_type, identity_key
      from ontology_entities where stack_id = ${stackId} order by name
    `),
  );
}

/** Every relationship row of one Stack, with the classification columns. */
async function relationshipRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      type: string;
      predicate: string | null;
      classification_state: string | null;
      canonical_type: string | null;
      compatibility: string | null;
    }>(sql`
      select type, predicate, classification_state, canonical_type, compatibility
      from ontology_relationships where stack_id = ${stackId} order by type
    `),
  );
}

describe.skipIf(skipReason !== false)("ingest classifies what it extracted", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp(runtime());
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("classifies an in-catalog entity and keeps the proposed label beside it (S45.1)", async () => {
    const stackId = await createStack(app, "in-catalog");
    await ingestAnswer(app, stackId);

    const committee = (await entityRows(stackId)).find((row) => row.name === "Comité de Cambios");
    // The row's projection label stays what the extractor proposed; the catalog
    // decision lives in `canonical_type`, which is set only when classified.
    expect(committee).toEqual({
      name: "Comité de Cambios",
      // The projection label is the extraction stage's own spelling, which folds
      // labels to one comparable form (`normalizeType`); the catalog decision is
      // the canonical type beside it.
      type: "ROLE",
      proposed_type: "ROLE",
      classification_state: "classified",
      canonical_type: "Role",
      identity_key: committee?.identity_key,
    });
  });

  it("keeps an out-of-catalog entity free, with no invented canonical type (S45.2)", async () => {
    const stackId = await createStack(app, "free");
    await ingestAnswer(app, stackId);

    const vex = (await entityRows(stackId)).find((row) => row.name === "Vex");
    // Kept, not dropped; the proposal survives verbatim; no `Concept`, no
    // `Unclassified`, and no canonical type at all — "free" is a state.
    expect(vex?.type).toBe("UNICORNIO");
    expect(vex?.classification_state).toBe("free_no_match");
    expect(vex?.canonical_type).toBeNull();
  });

  it("keeps a free relation's original predicate instead of a generic verb (S45.5)", async () => {
    const stackId = await createStack(app, "predicate");
    await ingestAnswer(app, stackId);

    const rows = await relationshipRows(stackId);
    const free = rows.find((row) => row.predicate === "DEJA_SIN_EFECTO");
    const classified = rows.find((row) => row.predicate === "EJECUTA");

    expect(free).toEqual({
      type: "DEJA_SIN_EFECTO",
      predicate: "DEJA_SIN_EFECTO",
      classification_state: "free_no_match",
      canonical_type: null,
      compatibility: "indeterminate",
    });
    expect(classified?.canonical_type).toBe("executes");
    // The compatibility verdict is recorded beside the classification, not
    // instead of it: a free relation between typed endpoints can still be
    // compatible, and both facts are kept (S34, S35).
    expect(classified?.compatibility).toBe("compatible");
  });
});

describe.skipIf(skipReason !== false)("ingest records evidence and classification history", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp(runtime());
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("stores one evidence row per candidate span with a verifiable offset (S10)", async () => {
    const stackId = await createStack(app, "evidence");
    const { documentId } = await ingestAnswer(app, stackId);

    const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute<{
        candidate_kind: string;
        candidate_ref: string;
        evidence_text: string;
        char_start: number | null;
        char_end: number | null;
        normalized_match: boolean;
        evidence_kind: string;
        model: string | null;
        pipeline_version: string | null;
      }>(sql`
        select candidate_kind, candidate_ref, evidence_text, char_start, char_end,
               normalized_match, evidence_kind, model, pipeline_version
        from kg_evidence where stack_id = ${stackId} order by evidence_text
      `),
    );

    // Five entities and two relations, one span each: every candidate keeps its
    // provenance instead of the run keeping only the ones that matched verbatim.
    expect(rows).toHaveLength(7);
    const committee = rows.find((row) => row.evidence_text === "Comité de Cambios");
    // The offsets are into the stored chunk, so slicing it back proves the quote.
    expect(BODY.slice(committee?.char_start ?? 0, committee?.char_end ?? 0)).toBe(
      "Comité de Cambios",
    );
    // The ref is the run-scoped candidate id, passed through verbatim: it names
    // the document and the identity the row was written under.
    expect(committee?.candidate_ref).toMatch(new RegExp(`^entity:${documentId}:`));
    expect(committee).toMatchObject({
      candidate_kind: "entity",
      normalized_match: false,
      evidence_kind: "textual",
      model: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
      pipeline_version: "llamaindex-schema-extraction",
    });
    // A quote the source does not contain is recorded with null offsets rather
    // than dropped: the absence is the signal (S11).
    const absent = rows.find((row) => row.evidence_text === "Vex");
    expect(absent).toMatchObject({ char_start: null, char_end: null });
  });

  it("logs the state transition with the vendor readout and both versions (S43)", async () => {
    const stackId = await createStack(app, "log");
    await ingestAnswer(app, stackId);

    const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute<{
        candidate_kind: string;
        previous_state: string | null;
        new_state: string;
        previous_canonical_type: string | null;
        new_canonical_type: string | null;
        jev_choice: string | null;
        jev_confidence: number | null;
        jev_top_probability: number | null;
        catalog_version: string | null;
        classifier_version: string | null;
        reason: string | null;
      }>(sql`
        select candidate_kind, previous_state, new_state, previous_canonical_type,
               new_canonical_type, jev_choice, jev_confidence, jev_top_probability,
               catalog_version, classifier_version, reason
        from kg_classification_log where stack_id = ${stackId} order by created_at, id
      `),
    );

    expect(rows).toHaveLength(7);
    const classified = rows.find((row) => row.new_canonical_type === "Role");
    // The row existed as `pending` before it was classified, which is what makes
    // an interrupted run recoverable and the change traceable.
    expect(classified).toMatchObject({
      candidate_kind: "entity",
      previous_state: "pending",
      new_state: "classified",
      previous_canonical_type: null,
      jev_choice: "Role",
      catalog_version: "1.0.0",
      classifier_version: "jev-classification/1",
      reason: null,
    });
    // The vendor's own numbers are kept, with the meaning they have: the top
    // probability is read out of the distribution, and `confidence` is the
    // vendor's dispersion measure — neither is a probability of correctness.
    expect(classified?.jev_top_probability).toBeCloseTo(0.9);
    expect(classified?.jev_confidence).toBeCloseTo(0.8);
    const free = rows.find((row) => row.new_state === "free_no_match");
    expect(free?.new_canonical_type).toBeNull();
    expect(free?.reason).toBeTruthy();
  });

  it("updates the same row on a re-ingest instead of classifying a second one (S45.12)", async () => {
    const stackId = await createStack(app, "reingest");
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const before = await entityRows(stackId);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const after = await entityRows(stackId);

    // The identity key carries the mention's identity, so re-ingesting the same
    // document updates these rows rather than opening siblings.
    expect(after).toEqual(before);
    expect(after).toHaveLength(5);
  });
});
