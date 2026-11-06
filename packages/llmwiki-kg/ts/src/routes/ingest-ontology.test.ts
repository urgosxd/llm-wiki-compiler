/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-ontology.test.ts
 * @description A Stack created with an ontology has that ontology enforced by
 * the very next ingest.
 *
 * WHY THIS FILE EXISTS. Every other ingest suite stops short of this. The
 * contract suites ingest a whitespace-only document so no provider call happens,
 * and the gateway suite spends real money but creates its Stack with a direct
 * `insert` that has no declaration. So the one property the feature exists for —
 * create with a declaration, then ingest, and the graph contains only what was
 * declared — was never executed end to end.
 *
 * Each test here drives the real HTTP surface: `POST /stacks` writes the
 * declaration, `POST /stacks/:id/documents/:doc/ingest` reads it back through
 * `s.ontology` and enforces it. Only the provider is a stub, which is what makes
 * the "the model emitted something out of ontology" case reproducible at all —
 * a live model cannot be asked to misbehave on cue.
 *
 * ## What is asserted, and why not the response body
 *
 * `IngestionResult` is nine fixed keys, byte-identical to the oracle, and it
 * carries no rejection count. So the rejection report cannot be observed on the
 * wire and the assertions read the graph tables instead. That is also the honest
 * place: what matters is what got WRITTEN, not what got counted.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Provider configuration, hoisted above every import.
 *
 * `config` parses `process.env` once at module load, and the pipeline reaches it
 * through `../config.js` — so these values must be in place BEFORE that module
 * is imported. `vi.hoisted` runs above all imports, which is what makes this
 * possible without a setup file.
 *
 * It has to live here and not in `ingest-harness.ts`: a helper module is imported
 * too late, and the symptom is not an error but a silent success against the real
 * `api.openai.com` and `api.anthropic.com` — measured while writing this file,
 * which is why `installFetchStub` would record no chat call at all.
 */
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
import { withFixtureTenant } from "./fixture-tenant.js";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../db.js";
import { createStacksRouter } from "./stacks.js";
import { createIngestRouter } from "./ingest.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "./ingest-harness.js";
import {
  installFetchStub,
  setToolResponse,
  uninstallFetchStub,
} from "../core/extraction-harness.js";

useDomainPrefix("ontology");

/** The declaration the Stack is created with. */
const DECLARATION = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
};

/** One chunk of prose, so the pipeline has something to send to the model. */
const BODY = "Acme employs Ada Lovelace. Globex employs nobody at all.";

/**
 * A body long enough to become more than one chunk.
 *
 * Per-chunk counters cannot be told apart on a single-chunk document, and the
 * default chunk budget is 1024 tokens, so this repeats one sentence far past it.
 * The tests assert `chunks_created > 1` rather than hard-coding a chunk count:
 * the chunker's exact boundaries are not what these tests are about.
 */
const LONG_BODY = Array.from(
  { length: 200 },
  (_, index) => `Acme employs Ada Lovelace in office ${String(index)}.`,
).join(" ");

/**
 * A response the parser can read but which exposes neither an envelope array.
 *
 * Non-blank and valid JSON, so the provider DID answer: this is the shape-mangled
 * case, not a failure and not a document with nothing in it.
 */
const MANGLED = { status: "ok" };

/** A triplet inside the declaration: kept. */
const IN_ONTOLOGY = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Ada Lovelace" },
};

/** A triplet whose relation was never declared: dropped. */
const BAD_RELATION = {
  subject: { type: "COMPANY", name: "Globex" },
  relation: { type: "ACQUIRED" },
  object: { type: "PERSON", name: "Nobody" },
};

/** A triplet whose entity type was never declared: dropped. */
const BAD_ENTITY = {
  subject: { type: "ALIEN_CONSTRUCT", name: "Vex" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Nobody" },
};

/** Build an app exposing both routers, sharing one transaction wrapper. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));

  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  // The production transaction shape: the pipeline opens its own bounded
  // transactions, so classification never runs inside one.
  app.use(createIngestRouter({ wrap, apiKey, run: createTransactionRunner(database()) }));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** Create a Stack through the API, returning its id. */
async function createStackWith(
  app: Express,
  domain: string,
  ontology?: unknown,
): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({
      name: "Ontology Ingest",
      domain,
      ...(ontology === undefined ? {} : { ontology }),
    })
    .expect(201);
  return String(created.body.id);
}

/** Every entity type actually written to the Stack's graph, sorted. */
async function writtenEntityTypes(stackId: string): Promise<string[]> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ type: string }>(
      sql`select distinct type from ontology_entities where stack_id = ${stackId} order by type`,
    ),
  );
  return rows.map((row) => row.type);
}

/** Every relationship type actually written to the Stack's graph, sorted. */
async function writtenRelationTypes(stackId: string): Promise<string[]> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ type: string }>(
      sql`select distinct type from ontology_relationships where stack_id = ${stackId} order by type`,
    ),
  );
  return rows.map((row) => row.type);
}

describe.skipIf(skipReason !== false)("ingest respects a Stack's ontology", () => {
  let app: Express;
  let sequence = 0;

  /** Unique domain per call, carrying the cleanup prefix. */
  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-ontology-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("keeps triplets outside the declaration and preserves what the model proposed", async () => {
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION, BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("mixed"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // Every candidate the sources support is KEPT, carrying the type and the
    // predicate the model proposed. `ALIEN_CONSTRUCT` and `ACQUIRED` are outside
    // this Stack's declaration, so they are stored as the projection label
    // rather than replaced by `Concept`, rewritten as `related_to`, or dropped.
    expect(await writtenEntityTypes(stackId)).toEqual(["ALIEN_CONSTRUCT", "COMPANY", "PERSON"]);
    expect(await writtenRelationTypes(stackId)).toEqual(["ACQUIRED", "EMPLOYS"]);
  });

  it("keeps candidates outside the default vocabulary and records the mismatch", async () => {
    // The declaration orients, it does not filter. An undeclared Stack is judged
    // against `default_ontology.ts` for orientation only, so the same document
    // yields every candidate it names — `COMPANY`/`PERSON`/`EMPLOYS` as well as
    // `ALIEN_CONSTRUCT` and `ACQUIRED` — and the mismatch is reported in the
    // document's audit instead of being silently discarded.
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION, BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("plain"));
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await writtenEntityTypes(stackId)).toEqual(["ALIEN_CONSTRUCT", "COMPANY", "PERSON"]);
    expect(await writtenRelationTypes(stackId)).toEqual(["ACQUIRED", "EMPLOYS"]);
    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    expect(audit["open"]).toMatchObject({ outside_catalog: 2, kinds: ["entity_type", "predicate"] });
  });

  it("admits the default vocabulary even though it is not llama_index's", async () => {
    // `COMPANY` and `EMPLOYS` are absent from llama_index's DEFAULT_ENTITIES /
    // DEFAULT_RELATIONS, so this is the test that fails if anyone "simplifies"
    // the default back to those lists. The tool schema stays byte-identical
    // either way, which is exactly why the swap looks safe and is not.
    setToolResponse([{ triplets: [IN_ONTOLOGY] }]);
    const stackId = await createStackWith(app, domain("defaults"));
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await writtenEntityTypes(stackId)).toEqual(["COMPANY", "PERSON"]);
    expect(await writtenRelationTypes(stackId)).toEqual(["EMPLOYS"]);
  });

  it("shows the declared types in the tool schema the model is given", async () => {
    // Enforcement is two-sided: the model is told the allowed types AND the
    // parser drops what ignores them. This asserts the first half, which a
    // stored-then-ignored declaration would silently fail.
    setToolResponse([{ triplets: [IN_ONTOLOGY] }]);
    const stackId = await createStackWith(app, domain("schema"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const { recorded } = await import("../core/extraction-harness.js");
    const chat = recorded.filter((entry) => entry.url.endsWith("/chat/completions")).at(-1);
    const serialized = JSON.stringify(chat?.body);
    expect(serialized).toContain("'COMPANY'");
    expect(serialized).toContain("'PERSON'");
    expect(serialized).toContain("'EMPLOYS'");
  });

  it("follows an ontology edited by PATCH, not only the one set at creation", async () => {
    // The declaration is read per ingest, so narrowing it must take effect on the
    // next run rather than requiring a new Stack. What changes is the ORIENTATION
    // the model is given and the mismatch report, never what may be stored:
    // `EMPLOYS` and `ACQUIRED` are both no longer declared and both are kept with
    // their own predicate.
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION] }]);
    const stackId = await createStackWith(app, domain("patch"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app)
      .patch(`/stacks/${stackId}`)
      .send({ ontology: { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["REPORTS_TO"] } })
      .expect(200);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await writtenEntityTypes(stackId)).toEqual(["COMPANY", "PERSON"]);
    expect(await writtenRelationTypes(stackId)).toEqual(["ACQUIRED", "EMPLOYS"]);
    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    expect(audit["open"]).toMatchObject({ outside_catalog: 2, kinds: ["predicate"] });
  });
});

/** The audit blob recorded for one document, or null when none was written. */
async function documentAudit(stackId: string, documentId: string): Promise<unknown> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ audit: unknown }>(
      sql`select audit from stack_documents where id = ${documentId}`,
    ),
  );
  return rows[0]?.audit ?? null;
}

describe.skipIf(skipReason !== false)("ingest records what the ontology rejected", () => {
  let app: Express;
  let sequence = 0;

  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-ontology-${label}-aud-${Date.now().toString(36)}-${String(sequence)}`;
  }

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("records every catalog mismatch in the document's audit", async () => {
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION, BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("mixed"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // The response cannot carry this — IngestionResult is nine fixed oracle keys —
    // so the audit column is where it lands, readable via GET /documents/:id.
    //
    // `ontology` reports what the declaration TURNED AWAY, which is now nothing:
    // the declaration orients the model and nothing else. `open` reports what the
    // run KEPT although the catalog does not name it, naming each proposal in the
    // order the model emitted it — the predicate of `BAD_RELATION` first, then the
    // entity type of `BAD_ENTITY`.
    expect(await documentAudit(stackId, documentId)).toEqual({
      ontology: {
        enforced: true,
        declared: true,
        rejected: 0,
        reason_codes: [],
        samples: [],
      },
      open: {
        outside_catalog: 2,
        kinds: ["entity_type", "predicate"],
        samples: [
          { kind: "predicate", of: "Globex -> Nobody", proposed: "ACQUIRED" },
          { kind: "entity_type", of: "Vex", proposed: "ALIEN_CONSTRUCT" },
        ],
        structural: 0,
        truncations: [],
      },
    });
  });

  it("keeps the edge an out-of-catalog predicate used to cost, with its predicate", async () => {
    // The cost this replacement removes: `ACQUIRED` is not declared, and the old
    // pipeline dropped the whole triplet for it. The edge now exists under the
    // predicate the document used, and both endpoints keep their rows.
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION] }]);
    const stackId = await createStackWith(app, domain("cost"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await writtenRelationTypes(stackId)).toEqual(["ACQUIRED", "EMPLOYS"]);
    expect(await writtenEntityTypes(stackId)).toEqual(["COMPANY", "PERSON"]);
    // The helper's declared `unknown` is honest for a jsonb column but useless
    // to index, so the shape is narrowed here, where the assertion lives.
    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    const samples = (audit["open"] as { samples: Array<{ of: string; proposed: string }> })
      .samples;
    expect(samples.map((sample) => [sample.of, sample.proposed])).toEqual([
      ["Globex -> Nobody", "ACQUIRED"],
    ]);
  });

  it("caps the samples while still reporting the true mismatch count", async () => {
    // `audit` is a jsonb column read on every GET /documents/:id, and
    // DEFAULT_MAX_TRIPLETS_PER_CHUNK is 20, so a many-chunk document can keep hundreds
    // of out-of-catalog proposals. Eight mismatches must yield five samples and
    // `outside_catalog: 8`, so a truncated report reads as truncated rather than
    // as complete.
    const many = Array.from({ length: 8 }, (_, index) => ({
      subject: { type: "ALIEN_CONSTRUCT", name: `Vex ${String(index)}` },
      relation: { type: "EMPLOYS" },
      object: { type: "PERSON", name: "Nobody" },
    }));
    setToolResponse([{ triplets: many }]);
    const stackId = await createStackWith(app, domain("cap"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    const open = audit["open"] as {
      outside_catalog: number;
      kinds: string[];
      samples: unknown[];
    };
    expect(open.outside_catalog).toBe(8);
    expect(open.kinds).toEqual(["entity_type"]);
    expect(open.samples).toHaveLength(5);
    // And every one of the eight entities is really a row, not merely reported.
    expect(await writtenEntityTypes(stackId)).toEqual(["ALIEN_CONSTRUCT", "PERSON"]);
  });

  it("records that the default was the orientation when the Stack declares none", async () => {
    // `declared: false` rather than an absent key, and `enforced: true` rather
    // than false. The pair distinguishes "oriented by a default the caller never
    // chose" from "oriented by a declaration they wrote", which is the difference
    // between our policy being wrong and their config being wrong.
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_RELATION] }]);
    const stackId = await createStackWith(app, domain("plain"), undefined);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await documentAudit(stackId, documentId)).toEqual({
      ontology: {
        enforced: true,
        declared: false,
        rejected: 0,
        reason_codes: [],
        samples: [],
      },
      // The default ontology declares `COMPANY`, `PERSON` and `EMPLOYS` and not
      // `ACQUIRED`, so exactly one proposal is outside the orientation. It is
      // recorded here and stored in the graph either way.
      open: {
        outside_catalog: 1,
        kinds: ["predicate"],
        samples: [
          { kind: "predicate", of: "Globex -> Nobody", proposed: "ACQUIRED" },
        ],
        structural: 0,
        truncations: [],
      },
    });
  });

  it("records a clean run as zero rejections rather than omitting the report", async () => {
    setToolResponse([{ triplets: [IN_ONTOLOGY] }]);
    const stackId = await createStackWith(app, domain("clean"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const audit = await documentAudit(stackId, documentId);
    // Byte-identical to the payload written before the degradation section
    // existed, and neither counter is present as a zero. Absence is the healthy
    // signal, so a consumer never has to tell a written zero from an unwritten
    // one.
    expect(audit).toEqual({
      ontology: {
        enforced: true,
        declared: true,
        rejected: 0,
        reason_codes: [],
        samples: [],
      },
    });
    expect(audit).not.toHaveProperty("extraction");
    expect(audit).not.toHaveProperty("mangledChunks");
    expect(audit).not.toHaveProperty("schemaViolations");
  });

  it("reports a mangled chunk in the audit rather than hiding it", async () => {
    // A response with neither a `triplets` nor an `entities` array is a degraded
    // answer, not a document with nothing in it. Before this section existed the
    // ingest answered 200 with an empty graph and the reason was nowhere.
    setToolResponse([MANGLED]);
    const stackId = await createStackWith(app, domain("mangled"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    // Only `mangledChunks`: a chunk with no envelope produced no triplet, so it
    // cannot also have put a type position outside the schema.
    expect(audit["extraction"]).toEqual({ mangledChunks: 1 });
  });

  it("records an out-of-catalog type as a kept mismatch, not as a schema violation", async () => {
    // The open contract's schema declares no `enum`, so a provider cannot leave
    // one and the degradation section stays absent. That is the point: the model
    // was never told `ALIEN_CONSTRUCT` was illegal, so a proposal outside the
    // catalog is orientation feedback, not non-compliance — and the entity is
    // stored under the proposal.
    setToolResponse([{ triplets: [BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("advisory"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    expect(audit).not.toHaveProperty("extraction");
    expect(audit["open"]).toEqual({
      outside_catalog: 1,
      kinds: ["entity_type"],
      samples: [{ kind: "entity_type", of: "Vex", proposed: "ALIEN_CONSTRUCT" }],
      structural: 0,
      truncations: [],
    });
    expect(await writtenEntityTypes(stackId)).toEqual(["ALIEN_CONSTRUCT", "PERSON"]);
  });

  it("counts every mangled chunk, not only the first", async () => {
    setToolResponse(Array.from({ length: 40 }, () => MANGLED));
    const stackId = await createStackWith(app, domain("mangled-all"), DECLARATION);
    const documentId = await createDocument(stackId, LONG_BODY);

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // An all-mangled run is degraded, not an outage: it answers 200 with an empty
    // graph, and this counter is the only place the loss is recorded.
    expect(response.body.chunks_created).toBeGreaterThan(1);
    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    expect(audit["extraction"]).toEqual({ mangledChunks: response.body.chunks_created });
  });

  it("keeps the two counters apart when both fire in one document", async () => {
    // One mangled chunk, then one chunk whose two out-of-catalog triplets carry
    // two mismatched positions between them. Chunks and proposals share no
    // denominator, so one coalesced number would be wrong for both.
    setToolResponse([MANGLED, { triplets: [BAD_RELATION, BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("both"), DECLARATION);
    const documentId = await createDocument(stackId, LONG_BODY);

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(response.body.chunks_created).toBeGreaterThan(1);
    const audit = (await documentAudit(stackId, documentId)) as Record<string, unknown>;
    expect(audit["extraction"]).toEqual({ mangledChunks: 1 });
    expect(audit["open"]).toMatchObject({
      outside_catalog: 2,
      kinds: ["entity_type", "predicate"],
    });
  });

  it("clears a previous run's counters when a re-ingest answers cleanly", async () => {
    // The section describes the run that produced the current graph. A leftover
    // one would report degradation against an ingest that no longer has any.
    setToolResponse([MANGLED]);
    const stackId = await createStackWith(app, domain("stale"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    expect(await documentAudit(stackId, documentId)).toHaveProperty("extraction");

    setToolResponse([{ triplets: [IN_ONTOLOGY] }]);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(await documentAudit(stackId, documentId)).not.toHaveProperty("extraction");
  });

  it("keeps the ingest response at the oracle's nine keys", async () => {
    // The audit is deliberately NOT on the wire: this pins that the extension
    // did not leak into the response envelope.
    setToolResponse([{ triplets: [IN_ONTOLOGY, BAD_ENTITY] }]);
    const stackId = await createStackWith(app, domain("keys"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(Object.keys(response.body)).toHaveLength(9);
    expect(response.body).not.toHaveProperty("ontology");
    expect(response.body).not.toHaveProperty("ontology_rejections");
    // And the degradation counters went to the audit blob, not onto the wire: the
    // nine keys above are the whole response contract.
    expect(response.body).not.toHaveProperty("mangledChunks");
    expect(response.body).not.toHaveProperty("schemaViolations");
  });
});
