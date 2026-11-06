/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/stack-catalog.test.ts
 * @description Which vocabulary an ingest actually classifies against (S14, S16).
 *
 * WHY THIS FILE EXISTS. `core/catalog/stack-catalog.test.ts` proves the derivation is
 * right. This file proves the PIPELINE uses it, which is a different claim and the
 * one that was false: a Stack that declared its types only in the legacy `ontology`
 * column was classified against the shipped default catalog, so `COMPANY` — a type
 * the Stack itself declares — matched nothing while `Role` — a type the Stack never
 * declared — would have matched if the model had proposed it.
 *
 * Four facts, all observable only through a request and the rows it writes:
 *
 * 1. a Stack declaring `entityTypes: ["COMPANY","PERSON"]` classifies `COMPANY`
 *    against ITS OWN catalog, not the default's `Role`/`Process`/... set;
 * 2. a type the declaration does not name stays FREE, even though the default
 *    catalog would have accepted it — that is the mislabelling this fixes;
 * 3. the persisted `catalog_version` identifies the catalog that was used;
 * 4. ingestion never writes a catalog: both Stack columns are exactly as they were.
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

useDomainPrefix("stack-catalog");

/** The prose every quote below is looked for in. */
const BODY = "Acme employs Ana. El coordinador revisa el runbook.";

/** One triplet whose types the Stack's own declaration names, plus one it does not. */
const ANSWER = {
  triplets: [
    {
      subject: { type: "company", name: "Acme" },
      relation: { type: "employs" },
      object: { type: "person", name: "Ana" },
    },
  ],
  entities: [{ type: "role", name: "Coordinador" }],
};

/** The legacy declaration a Stack can still carry; note it names no `ROLE`. */
const ONTOLOGY = { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["EMPLOYS"] };

/** One scripted semantic-support answer. */
function supportAnswer(): JevScriptStep {
  return vendorResponse({ [SUPPORT_QUESTION_ID]: choiceAnswer("SUPPORTED", { SUPPORTED: 0.92 }, 0.8) });
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
    [RELATION_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer(label, { [label]: 0.9 }, 0.8),
    [RELATION_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(fits),
  });
}

/**
 * The whole script for one ingest: four support questions (every quote is in the
 * prose), then three entity decisions and one relation decision.
 */
const SCRIPT: readonly JevScriptStep[] = [
  supportAnswer(),
  supportAnswer(),
  supportAnswer(),
  supportAnswer(),
  entityAnswer("COMPANY", 0.95),
  entityAnswer("PERSON", 0.94),
  // `ROLE` is a canonical type of the SHIPPED catalog and of no catalog this Stack
  // declares, so a low "fits" answer is exactly what the derived catalog should
  // produce for it.
  entityAnswer("COMPANY", 0.02),
  relationAnswer("EMPLOYS", 0.9),
];

/** The decision runtime a test injects. */
function runtime(): ClassificationRuntime {
  return { client: scriptedJevClient(SCRIPT), config: parseJevConfig({}) };
}

/** Builds an app with the production transaction shape over the fixture pool. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));
  const classification = runtime();
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

/** Creates a Stack declaring {@link ONTOLOGY} in the LEGACY column only. */
async function createStack(app: Express, label: string): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({ name: `Catalog ${label}`, domain: `${label}-${Date.now().toString(36)}`, ontology: ONTOLOGY })
    .expect(201);
  return String(created.body.id);
}

/** Every entity row of one Stack, with the decision columns and the catalog version. */
async function entityRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      name: string;
      classification_state: string | null;
      canonical_type: string | null;
      catalog_version: string | null;
    }>(sql`
      select name, classification_state, canonical_type, catalog_version
      from ontology_entities where stack_id = ${stackId} order by name
    `),
  );
}

/** Every relationship row of one Stack, with the decision columns. */
async function relationshipRows(stackId: string) {
  return withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{
      predicate: string | null;
      classification_state: string | null;
      canonical_type: string | null;
      catalog_version: string | null;
    }>(sql`
      select predicate, classification_state, canonical_type, catalog_version
      from ontology_relationships where stack_id = ${stackId} order by predicate
    `),
  );
}

/** The two vocabulary columns of one Stack, exactly as stored. */
async function stackColumns(stackId: string) {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ type_catalog: unknown; ontology: unknown }>(sql`
      select type_catalog, ontology from stacks where id = ${stackId}
    `),
  );
  return rows[0];
}

/** Ingests {@link ANSWER} into a fresh document. */
async function ingestAnswer(app: Express, stackId: string) {
  const documentId = await createDocument(stackId, BODY);
  setToolResponse([ANSWER]);
  return request(app).post(ingestUrl(stackId, documentId)).expect(200);
}

describe.skipIf(skipReason !== false)("ingest classifies against the Stack's own catalog", () => {
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

  it("uses the catalog derived from the Stack's ontology (S14)", async () => {
    const stackId = await createStack(app, "derived");
    await ingestAnswer(app, stackId);

    const rows = await entityRows(stackId);
    const acme = rows.find((row) => row.name === "Acme");
    // `COMPANY` is declared by THIS Stack. The shipped default catalog has no such
    // type, so this verdict is only reachable through the derived catalog.
    expect(acme).toMatchObject({
      classification_state: "classified",
      canonical_type: "COMPANY",
    });
    expect(rows.find((row) => row.name === "Ana")).toMatchObject({
      classification_state: "classified",
      canonical_type: "PERSON",
    });
  });

  it("leaves a type the declaration does not name free, even though the default names it (S3)", async () => {
    const stackId = await createStack(app, "free");
    await ingestAnswer(app, stackId);

    const coordinator = (await entityRows(stackId)).find((row) => row.name === "Coordinador");
    // `ROLE` is in the SHIPPED catalog. Against this Stack's own vocabulary it is
    // absent, so it stays free rather than being borrowed from a catalog nobody
    // configured for this Stack.
    expect(coordinator?.classification_state).toBe("free_no_match");
    expect(coordinator?.canonical_type).toBeNull();
  });

  it("records which catalog classified each row (S14, S43)", async () => {
    const stackId = await createStack(app, "version");
    await ingestAnswer(app, stackId);

    const versions = [
      ...(await entityRows(stackId)).map((row) => row.catalog_version),
      ...(await relationshipRows(stackId)).map((row) => row.catalog_version),
    ];
    // One version for the whole run, derived from the declaration, and never the
    // default catalog's `1.0.0`.
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toMatch(/^ontology-derived:[0-9a-f]{12}$/);
    const relations = await relationshipRows(stackId);
    expect(relations.find((row) => row.predicate === "employs")).toMatchObject({
      classification_state: "classified",
      canonical_type: "EMPLOYS",
    });
  });

  it("never writes a catalog or an ontology during ingestion (S16)", async () => {
    const stackId = await createStack(app, "immutable");
    await ingestAnswer(app, stackId);

    const columns = await stackColumns(stackId);
    // The derived catalog existed in memory only: no type was added to anything the
    // Stack stores (S16).
    expect(columns?.type_catalog).toBeNull();
    // The column round-trips the declared lists untouched; the API echoes the two
    // optional lists the parser defaults, which the declaration never carried.
    expect(columns?.ontology).toMatchObject(ONTOLOGY);
  });

  it("prefers a declared type_catalog over the legacy ontology", async () => {
    const stackId = await createStack(app, "precedence");
    await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute(sql`
        update stacks
        set type_catalog = ${JSON.stringify({
          version: "9.9.9",
          entityTypes: [
            { name: "COMPANY", definition: "A registered legal entity." },
            { name: "PERSON", definition: "A human being with a role." },
          ],
          relationTypes: [{ name: "EMPLOYS", definition: "Pays a person for work." }],
        })}::jsonb
        where id = ${stackId}
      `),
    );
    await ingestAnswer(app, stackId);

    const rows = await entityRows(stackId);
    // The declared catalog is the answer in full: its own version, and its own
    // definitions rather than the generated ones the derivation would have written.
    expect(rows.every((row) => row.catalog_version === "9.9.9")).toBe(true);
    expect(rows.find((row) => row.name === "Acme")?.canonical_type).toBe("COMPANY");
  });

  it("refuses an invalid stored catalog instead of substituting another one", async () => {
    const stackId = await createStack(app, "invalid");
    await withFixtureTenant(database(), { stackId }, (tx) =>
      tx.execute(sql`
        update stacks
        set type_catalog = ${JSON.stringify({ version: "1.0.0", entityTypes: "COMPANY" })}::jsonb
        where id = ${stackId}
      `),
    );
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);

    const response = await request(app).post(ingestUrl(stackId, documentId));

    // A broken catalog raises with the offending field named. Silently classifying
    // against the default would attribute this Stack's decisions to a vocabulary
    // nobody configured for it.
    expect(response.status).toBe(500);
    expect(String(response.body.detail)).toContain('type catalog "entityTypes"');
  });
});
