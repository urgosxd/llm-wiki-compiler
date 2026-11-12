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
 * The assertions are on the STORED row, on BOTH decision tables. `applyEntityDecision`
 * writes `support_state` on `ontology_entities` and `applyRelationDecision` writes it
 * on `ontology_relationships`, so an entity-only case would let the relation half of
 * the band stay mis-wired while every test stayed green — the same silent class the
 * whole file exists to close. The relation case therefore seeds the undecided support
 * top for the relation alone and asserts the stored row carries `uncertain` beside a
 * settled classification state. The verbatim uncertain-support reason
 * (`SUPPORT_REASON_UNCERTAIN`, `core/jev/interpret.ts`) is deliberately NOT asserted
 * here: nothing stores it. `support-stage.ts` builds a `SemanticSupport` carrying
 * that reason, and the only support column either decision table has is
 * `support_state` — `kg_evidence` has no rationale column either — so a stored-row
 * assertion of that string could only be written against a production change. The
 * reason string itself is pinned, DB-free, in `core/jev/interpret-support.test.ts`.
 *
 * ## Two holes verification found after the file was green twice
 *
 * `interpretSupport` resolves the LABEL (`SUPPORTED` / `UNSUPPORTED`) before it applies
 * the 0.6 band, so the band — not the label — decides which arm is stored. Nothing
 * pinned that: the DB-free case uses `SUPPORTED` at 0.55 and the only `UNSUPPORTED`
 * case is decided at 0.9, so a shortcut that returned the decided arm early for
 * `UNSUPPORTED` would have shipped silently. The first case below closes it.
 *
 * The support judgement is keyed by candidate ref, so the relation reads its own
 * entry and never a neighbour's. Nothing pinned THAT either: every script here gave
 * the same direction to entities and relation, so a relation reading the first
 * entity's judgement would produce the same stored value and stay green. The second
 * case below gives the two a different direction, so the shared-readout mistake
 * shows up as a stored value.
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

/** The second entity's decided top: above the band, and distinct from the first's. */
const POLICY_SUPPORT_TOP = 0.88;

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
  supportAnswer("SUPPORTED", POLICY_SUPPORT_TOP),
  entityAnswer("Document", CLASSIFIED_TOP, CLASSIFIED_FIT),
  entityAnswer("Policy", 0.85, 0.85),
  entityAnswer("Role", 0.3, 0.02),
  relationAnswer("governs", 0.7, 0.03),
];

/**
 * The same ingest, with ONLY the relation's support answer left undecided.
 *
 * Both entities keep a support top above the 0.6 band, so a stored `uncertain` on the
 * relation row cannot be a value that leaked from an entity judgement. The relation's
 * classification answer clears both classification bands and names a declared
 * relation type, so that row's classification axis is settled while its support one
 * is not — the same independence the entity half asserts, on the other decision table.
 */
const RELATION_SCRIPT: readonly JevScriptStep[] = [
  supportAnswer("SUPPORTED", DECIDED_SUPPORT_TOP),
  supportAnswer("SUPPORTED", POLICY_SUPPORT_TOP),
  supportAnswer("SUPPORTED", UNDECIDED_SUPPORT_TOP),
  entityAnswer("Document", CLASSIFIED_TOP, CLASSIFIED_FIT),
  entityAnswer("Policy", 0.85, 0.85),
  entityAnswer("Role", 0.3, 0.02),
  relationAnswer("governs", CLASSIFIED_TOP, CLASSIFIED_FIT),
];

/**
 * The same ingest as `RELATION_SCRIPT`, with the relation's support answer flipped to
 * the OTHER label, still undecided.
 *
 * `UNSUPPORTED` at 0.55 is the cell the label-first wiring would get wrong: resolving
 * the label early turns `uncertain` into the decided negative the label names. Both
 * entities and the classification answers stay identical to `RELATION_SCRIPT`, so only
 * the relation's support label moves.
 */
const UNSUPPORTED_RELATION_SCRIPT: readonly JevScriptStep[] = [
  supportAnswer("SUPPORTED", DECIDED_SUPPORT_TOP),
  supportAnswer("SUPPORTED", POLICY_SUPPORT_TOP),
  supportAnswer("UNSUPPORTED", UNDECIDED_SUPPORT_TOP),
  entityAnswer("Document", CLASSIFIED_TOP, CLASSIFIED_FIT),
  entityAnswer("Policy", 0.85, 0.85),
  entityAnswer("Role", 0.3, 0.02),
  relationAnswer("governs", CLASSIFIED_TOP, CLASSIFIED_FIT),
];

/**
 * The reverse leak: BOTH entities undecided, the relation decided.
 *
 * Every other script here gives entities and relation the same support direction, so a
 * relation that read a neighbour's judgement instead of its own would store the same
 * value it should and stay green. Here the two directions differ, so a shared readout
 * lands on the relation row as `uncertain` where `supported` belongs.
 */
const ENTITIES_UNDECIDED_SCRIPT: readonly JevScriptStep[] = [
  supportAnswer("SUPPORTED", UNDECIDED_SUPPORT_TOP),
  supportAnswer("SUPPORTED", UNDECIDED_SUPPORT_TOP),
  supportAnswer("SUPPORTED", DECIDED_SUPPORT_TOP),
  entityAnswer("Document", CLASSIFIED_TOP, CLASSIFIED_FIT),
  entityAnswer("Policy", 0.85, 0.85),
  entityAnswer("Role", 0.3, 0.02),
  relationAnswer("governs", CLASSIFIED_TOP, CLASSIFIED_FIT),
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

/** Every relationship row of one Stack, with the support and classification columns. */
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

/** One stored relationship row, as the assertions below read it. */
type StoredRelationship = Awaited<ReturnType<typeof relationshipRows>>[number];

/** One stored entity row, as the assertions below read it. */
type StoredEntity = Awaited<ReturnType<typeof entityRows>>[number];

/** Ingests one scripted run into a fresh Stack and returns that Stack's id. */
async function ingestRun(steps: readonly JevScriptStep[], label: string): Promise<string> {
  const app = buildApp(runtime(steps));
  const stackId = await createStack(app, label);
  await ingestAnswer(app, stackId);
  return stackId;
}

/** The single relation {@link ANSWER} asserts, or `undefined` when none was written. */
async function relationRow(stackId: string): Promise<StoredRelationship | undefined> {
  return (await relationshipRows(stackId)).find((row) => row.predicate === "deja sin efecto");
}

/** One stored entity by name, or `undefined` when the extractor produced no such row. */
async function entityRow(stackId: string, name: string): Promise<StoredEntity | undefined> {
  return (await entityRows(stackId)).find((row) => row.name === name);
}

/** Puts the fixture database and the fetch stub in the state every case starts from. */
async function resetFixture(): Promise<void> {
  await deleteFixtureRows();
  installFetchStub();
}

/** Undoes {@link resetFixture}, so one case cannot leave rows behind for the next. */
async function clearFixture(): Promise<void> {
  uninstallFetchStub();
  await deleteFixtureRows();
}

describe.skipIf(skipReason !== false)("ingest stores the support band's undecided verdict", () => {
  beforeEach(resetFixture);

  afterEach(clearFixture);

  it("stores uncertain support on a row the classifier confidently classified (S3)", async () => {
    const stackId = await ingestRun(SCRIPT, "uncertain");
    const runbook = await entityRow(stackId, "Runbook");
    // A 0.55 top probability is under the 0.6 support band, so the judgement is
    // stored as undecided rather than being rounded into a direction.
    expect(runbook?.support_state).toBe("uncertain");
    // The same row's classification axis is settled: an 0.8 fit and an 0.8 top clear
    // both classification bands. Support and classification are independent (S32).
    expect(runbook?.classification_state).toBe("classified");
    expect(runbook?.canonical_type).toBe("Document");
    // The same run's other candidate is decided, so `uncertain` is not a value the
    // writer puts on every row.
    expect((await entityRow(stackId, "Política anterior"))?.support_state).toBe("supported");
  });

  it("stores uncertain support on a relation the classifier confidently classified (T5)", async () => {
    const stackId = await ingestRun(RELATION_SCRIPT, "relation-uncertain");
    // The relation half of the 0.6 band abstains exactly as the entity half does: a
    // 0.55 support top is stored as undecided, never rounded into a direction. A
    // mis-wire in `applyRelationDecision` only would have kept every entity test
    // green while shipping relations that claim their assertion is supported.
    expect(await relationRow(stackId)).toMatchObject({
      support_state: "uncertain",
      // The same row's classification axis is settled — an 0.8 fit and an 0.8 top
      // clear both classification bands — so the two axes are independent on a
      // relation exactly as they are on an entity (S32).
      classification_state: "classified",
      canonical_type: "governs",
    });
  });

  it("stores uncertain support for an UNSUPPORTED relation choice whose top is undecided (L9)", async () => {
    const stackId = await ingestRun(UNSUPPORTED_RELATION_SCRIPT, "relation-unsupported-undecided");
    // The 0.6 band decides the arm and it is read AFTER the label: an `UNSUPPORTED`
    // answer whose top is undecided is stored undecided, never the decided negative
    // the label names. Resolving the label first would ship that value silently.
    expect(await relationRow(stackId)).toMatchObject({
      support_state: "uncertain",
      classification_state: "classified",
      canonical_type: "governs",
    });
  });

  it("stores supported on a relation while both entities stay uncertain (L9)", async () => {
    const stackId = await ingestRun(ENTITIES_UNDECIDED_SCRIPT, "entities-undecided");
    // Both entity judgements abstain, so the relation cannot have inherited either.
    expect((await entityRow(stackId, "Runbook"))?.support_state).toBe("uncertain");
    expect((await entityRow(stackId, "Política anterior"))?.support_state).toBe("uncertain");
    // Keyed by candidate ref, so a relation reading a neighbour's verdict would store
    // `uncertain` here — which is why the two directions must differ.
    expect((await relationRow(stackId))?.support_state).toBe("supported");
  });
});
