/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/verdict-disagreement.test.ts
 * @description T15 of `odd/tasks/kg-ontology-contract-persist-mode.md` (S9): when a
 * recompile REFUSES an identity the graph already stores `accepted`, the refusal is
 * RECORDED — because the row itself cannot show it.
 *
 * ## The two halves, and why the silent version passes one of them alone
 *
 * `ACCEPTED_WINS_SET` (`core/document-consolidation.ts`) keeps `accepted` whenever
 * either side of a collision is accepted, and clears the reason and the offending type
 * with it. That is the rule and this file does NOT change it: the flip is one-directional
 * by design, and making it bidirectional is the reconciliation branch's job.
 *
 * The consequence an operator experiences: they tighten their ontology, recompile, and
 * the edge is STILL accepted with a null reason. Nothing says the tightening did nothing.
 * A graph that keeps the old class is half the truth; the other half is that the run's
 * verdict disagreed. So every case below asserts BOTH:
 *
 * 1. the stored row still reads `accepted`, with no reason — the unchanged rule, which
 *    passes from the first run of this file; and
 * 2. the run recorded the disagreement durably, in `stack_documents.audit`, keyed by
 *    table — the half that is missing until the record exists.
 *
 * The control is what stops a constant field from passing: a run where every verdict
 * AGREES must leave the record absent, including after a run that disagreed. A section
 * that is always present, or that accumulates, would satisfy half 2 everywhere and mean
 * nothing.
 *
 * ## What is observed, and what is never observed
 *
 * The production HTTP route (`createApp`) over a real socket, this file's own database,
 * `PATCH /stacks/:id` for the declaration change, and SQL reads of the two graph tables
 * and of `stack_documents.audit`. The audit key is spelled as a LITERAL here on purpose:
 * it is a storage contract, and a test that read it through the production constant
 * could not notice the constant's value drifting away from what a consumer reads.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// First, and it must stay first: the vendored `config` reads `process.env` once, at import
// time, so this has to run before any import below reaches the provider layer.
vi.hoisted(() => {
  const FAKE_GATEWAY: Record<string, string> = {
    EXTRACTION_PROVIDER: "gateway",
    EMBEDDING_PROVIDER: "gateway",
    GATEWAY_URL: "https://gateway.invalid/v1",
    GATEWAY_API_KEY: "test-key-not-a-credential",
    EMBEDDING_MODEL: "hf:nomic-ai/nomic-embed-text-v1.5",
    EMBEDDING_DIM: "768",
    EXTRACTION_MODEL: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
  };
  for (const [name, value] of Object.entries(FAKE_GATEWAY)) process.env[name] = value;
  delete process.env["TYPESAFE_API_KEY"];
});

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import {
  installFetchStub,
  setToolResponse,
  uninstallFetchStub,
} from "../../core/extraction-harness.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
  createTransactionRunner,
} from "../../db.js";
import { createApp } from "../../server.js";
import { perRunDatabase } from "../../testing/per-run-database.js";

/** The server this run's per-process database is provisioned on, resolved as CI resolves it. */
const SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** This file's own database, created and dropped by this file. Nothing shared is touched. */
const suite = await perRunDatabase(SERVER_URL);
const client = createClient(suite.url, 3);
const database = createDatabase(client);

/** The HTTP entry point: the production app, bound to this file's own database. */
const app = createApp({
  wrap: createRequestTransactionWrapper(database),
  apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
  run: createTransactionRunner(database),
});

/**
 * The transport this file talks to its own app over, captured BEFORE any test body runs:
 * `installFetchStub` replaces the global `fetch` with the provider's fake, so a request
 * issued through the stub never reaches the app and reads as a 404 from a mounted route.
 */
const transport = globalThis.fetch;

// A real socket, the way the sibling `persist-audit-rows` suite drives its surface.
const server = createServer(app);
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const BASE_URL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

/**
 * Sends one JSON request to one path on the listening app.
 *
 * @param method - The HTTP method.
 * @param path - Absolute path, including any query string.
 * @param body - The JSON body to send.
 * @returns The status and the parsed body.
 */
async function send(
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await transport(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Scratch space OUTSIDE the worktree: the ingest phase reads a document's bytes from disk. */
const scratch = await mkdtemp(join(tmpdir(), "kg-verdict-disagreement-"));

/** The declaration the first compile runs under: it admits the whole document. */
const DECLARATION_BEFORE = { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["EMPLOYS"] };

/** The same declaration with the verb REMOVED, so only the edge's verdict can flip. */
const DECLARATION_WITHOUT_THE_VERB = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["WORKS_AT"],
};

/** The same declaration with the subject's TYPE removed, so only an entity verdict can flip. */
const DECLARATION_WITHOUT_COMPANY = { entityTypes: ["PERSON"], relationshipTypes: ["EMPLOYS"] };

/** The document text, unchanged across every compile this file runs. */
const BODY = "Acme employs Ada.";

/** The one triplet the stubbed model answers with, every time it is asked. */
const TRIPLETS = [
  {
    subject: { name: "Acme", type: "COMPANY" },
    relation: { type: "EMPLOYS" },
    object: { name: "Ada", type: "PERSON" },
  },
];

/** The stored `audit` key this file pins: the run's refused-but-kept verdicts, per table. */
const DISAGREEMENT_KEY = "verdict_disagreements";

/** One run's identifiers, so its rows and its audit can be read afterwards. */
interface Run {
  readonly stackId: string;
  readonly documentId: string;
}

/** The class columns of one stored row, as both tables spell them. */
interface ClassRow extends Record<string, unknown> {
  readonly id: string;
  readonly verdict: string;
  readonly reason: string | null;
  readonly offending: string | null;
}

/**
 * Creates a Stack carrying one declaration, through the same route a caller would use.
 *
 * @param ontology - The declaration to store.
 * @param label - A readable fragment in the unique domain, so a failure names its case.
 * @returns The Stack's id.
 */
async function createStack(ontology: unknown, label: string): Promise<string> {
  const domain = `w2ex-verdict-disagreement-${label}-${randomUUID().slice(0, 8)}`;
  const created = await send("POST", "/stacks", { name: "Disagreement", domain, ontology });
  expect(created.status).toBe(201);
  return String(created.body["id"]);
}

/**
 * Replaces the Stack's declaration — the ontology change that makes a verdict disagree.
 *
 * @param stackId - The Stack to update.
 * @param ontology - The new declaration.
 */
async function patchOntology(stackId: string, ontology: unknown): Promise<void> {
  expect((await send("PATCH", `/stacks/${stackId}`, { ontology })).status).toBe(200);
}

/**
 * Stores one document row whose bytes live in this file's scratch directory.
 *
 * @param stackId - The Stack that owns it.
 * @param body - The document text.
 * @returns The document's id.
 */
async function createDocument(stackId: string, body: string): Promise<string> {
  const documentId = randomUUID();
  const absolute = join(scratch, `${documentId}.txt`);
  await writeFile(absolute, body, "utf8");
  await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into stack_documents (id, stack_id, filename, storage_path, size_bytes, source_hash)
      values (${documentId}, ${stackId}, ${`${documentId}.txt`}, ${absolute},
              ${Buffer.byteLength(body, "utf8")}, ${randomUUID()})
    `);
  });
  return documentId;
}

/**
 * Runs one compile of the document under `persist`, the contract that keeps refused rows.
 *
 * `POST /ingest` writes no graph row, so the rows every case reads come from
 * `POST /compile`, which reads the Stack's CURRENT declaration on every run.
 *
 * @param run - The Stack and document to compile.
 * @param fresh - True to run the form phase first, false to recompile what is stored.
 */
async function compile(run: Run, fresh: boolean): Promise<void> {
  const base = `/stacks/${run.stackId}/documents/${run.documentId}`;
  if (fresh) expect((await send("POST", `${base}/ingest`, {})).status).toBe(200);
  setToolResponse([{ triplets: TRIPLETS }]);
  const compiled = await send(
    "POST",
    `${base}/compile?ontology_contract=persist&synthesize_descriptions=false`,
    {},
  );
  expect(compiled.status).toBe(200);
}

/**
 * Reads the one stored `Acme —EMPLOYS→ Ada` edge row of a Stack, through the public tables.
 *
 * @param stackId - The Stack to read.
 * @returns The single edge's class columns; the length is itself an assertion.
 */
async function theEdgeRow(stackId: string): Promise<ClassRow> {
  const rows = await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return await tx.execute<ClassRow>(sql`
      select r.id, r.ontology_verdict as verdict,
             r.ontology_rejection_reason as reason,
             r.ontology_offending_type as offending
      from ontology_relationships r
      join ontology_entities f on f.id = r.from_entity_id
      join ontology_entities t on t.id = r.to_entity_id
      where r.stack_id = ${stackId}
        and r.type = 'EMPLOYS'
        and lower(f.name) = 'acme' and lower(t.name) = 'ada'
    `);
  });
  expect(rows.length).toBe(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`expected one EMPLOYS row in ${stackId}, found none`);
  return row;
}

/**
 * Reads the stored row of one named entity, through the public table.
 *
 * @param stackId - The Stack to read.
 * @param name - The entity's name, matched case-insensitively.
 * @returns That entity's class columns.
 */
async function theEntityRow(stackId: string, name: string): Promise<ClassRow> {
  const rows = await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return await tx.execute<ClassRow>(sql`
      select id, ontology_verdict as verdict,
             ontology_rejection_reason as reason,
             ontology_offending_type as offending
      from ontology_entities
      where stack_id = ${stackId} and lower(name) = lower(${name})
    `);
  });
  expect(rows.length).toBe(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`expected one ${name} row in ${stackId}, found none`);
  return row;
}

/**
 * Reads the disagreement section out of `stack_documents.audit`, as it is stored.
 *
 * A raw `jsonb` read rather than a parse through a production helper: what this file
 * pins is that the record is DURABLE and readable by anyone with the column, and a blob
 * that only a private helper could interpret would not be.
 *
 * @param run - The run whose document to read.
 * @returns The stored section, or `undefined` when the run recorded no disagreement.
 */
async function storedDisagreements(run: Run): Promise<unknown> {
  return await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${run.stackId}, true)`);
    const rows = await tx.execute<{ section: unknown }>(sql`
      select audit -> ${DISAGREEMENT_KEY} as section
      from stack_documents where id = ${run.documentId}
    `);
    return rows[0]?.section ?? undefined;
  });
}

/**
 * Creates a Stack and a document and compiles it once under {@link DECLARATION_BEFORE}.
 *
 * The first compile is the precondition, not a warm-up: without an accepted row on disk
 * there is no stored verdict for a later refusal to disagree with.
 *
 * @param label - A readable fragment for the Stack's domain, so a failure names its case.
 * @returns The Stack and document that own the accepted triplet.
 */
async function acceptedTripletOnDisk(label: string): Promise<Run> {
  const stackId = await createStack(DECLARATION_BEFORE, label);
  const documentId = await createDocument(stackId, BODY);
  const run = { stackId, documentId };
  await compile(run, true);
  return run;
}

/** S9 itself: the row still reads accepted, AND the disagreement that would have changed it is on record. */
async function pinBothHalvesOfTheDisagreement(): Promise<void> {
  const run = await acceptedTripletOnDisk("both-halves");
  const before = await theEdgeRow(run.stackId);
  expect([before.verdict, before.reason, before.offending]).toEqual(["accepted", null, null]);
  // Nothing was refused yet, so the first run recorded no disagreement at all.
  expect(await storedDisagreements(run)).toBeUndefined();

  // THE CHANGE: the same document bytes, the same model answer, one verb less in the declaration.
  await patchOntology(run.stackId, DECLARATION_WITHOUT_THE_VERB);
  await compile(run, false);

  // HALF ONE — the documented one-directional rule, unchanged: accepted wins, no reason.
  const after = await theEdgeRow(run.stackId);
  expect(after.id).toBe(before.id);
  expect([after.verdict, after.reason, after.offending]).toEqual(["accepted", null, null]);
  // HALF TWO — and the run that refused it says so, per table, in the document's own audit.
  expect(await storedDisagreements(run)).toEqual({ entity: 0, relationship: 1 });
}

/** The control: a run where every verdict AGREES records nothing, even after one that did not. */
async function pinAnAgreeingRunRecordsNothing(): Promise<void> {
  const run = await acceptedTripletOnDisk("control");
  // A recompile with no declaration change agrees with what is stored, so no record.
  await compile(run, false);
  expect(await storedDisagreements(run)).toBeUndefined();

  await patchOntology(run.stackId, DECLARATION_WITHOUT_THE_VERB);
  await compile(run, false);
  expect(await storedDisagreements(run)).toEqual({ entity: 0, relationship: 1 });

  // The declaration admits the verb again, so the next run agrees — and the record of the
  // PREVIOUS run must not survive as a stale claim about this one.
  await patchOntology(run.stackId, DECLARATION_BEFORE);
  await compile(run, false);
  expect(await storedDisagreements(run)).toBeUndefined();
  expect((await theEdgeRow(run.stackId)).verdict).toBe("accepted");
}

/** The same rule on the entity side: a refused entity type cannot downgrade a stored acceptance. */
async function pinTheEntityTableIsCounted(): Promise<void> {
  const run = await acceptedTripletOnDisk("entity");
  const before = await theEntityRow(run.stackId, "Acme");
  expect([before.verdict, before.reason]).toEqual(["accepted", null]);

  // `COMPANY` leaves the allowlist, so the subject is refused while `Ada` (PERSON) is not.
  await patchOntology(run.stackId, DECLARATION_WITHOUT_COMPANY);
  await compile(run, false);

  // HALF ONE: the stored acceptance stands, still with no reason and no offending type.
  const after = await theEntityRow(run.stackId, "Acme");
  expect(after.id).toBe(before.id);
  expect([after.verdict, after.reason, after.offending]).toEqual(["accepted", null, null]);
  // HALF TWO: one refused identity in EACH table — the subject, and the triplet's edge.
  expect(await storedDisagreements(run)).toEqual({ entity: 1, relationship: 1 });
}

beforeEach(() => {
  installFetchStub();
});

afterEach(() => {
  uninstallFetchStub();
});

afterAll(async () => {
  server.close();
  await client.end({ timeout: 3 });
  await suite.drop();
  await rm(scratch, { recursive: true, force: true });
});

describe("a recompile's refused verdict against a stored acceptance is recorded (S9)", () => {
  it("keeps the row accepted AND records the disagreement (S9.1)", pinBothHalvesOfTheDisagreement, 60_000);
  it("records nothing when every verdict agrees, stale records included (S9.2)", pinAnAgreeingRunRecordsNothing, 60_000);
  it("counts the entity table on the same rule (S9.3)", pinTheEntityTableIsCounted, 60_000);
});
