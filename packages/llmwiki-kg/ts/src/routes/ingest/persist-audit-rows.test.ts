/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/persist-audit-rows.test.ts
 * @description T4 of `odd/tasks/kg-ontology-contract-persist-mode.md` (S4): the numbers in
 * `stack_documents.audit` and the refused rows on disk are RELATED — and this file is the
 * relation, written down one divergence at a time.
 *
 * ## R4 was too strong, and this file is what measured that
 *
 * The requirement first said the audit's count and the number of refused rows must be the
 * same number. Measured, that is true for exactly one of the shapes below and false for the
 * rest, so the Manager amended it to DERIVABLE: from the audit's numbers PLUS the two
 * per-table row counts, a reader must be able to reach the row count. Nothing here asserts
 * equality unconditionally, because an unconditional equality is the claim that was wrong.
 *
 * ## The derivation
 *
 * Four numbers, all read from storage after ONE run:
 *
 * - `R` = `audit.ontology.rejected` — refused TRIPLETS, the classifier's own count.
 * - `C` = `audit.ontology.reason_codes` — the DISTINCT reasons, sorted: a set, so lossy.
 * - `E` = refused rows in `ontology_entities`.
 * - `L` = refused rows in `ontology_relationships`.
 *
 * The formula is `refused rows = L + E`, where:
 *
 * - `L` is one row per refused triplet that kept its own edge identity under `persist`
 *   (`core/graph-extraction.ts:665-677` pushes one edge per refused triplet), so `L = R`
 *   for a run whose refused edges neither collide with each other (`mergeRelationships`)
 *   nor were already admitted under the same identity, where the admitted row wins.
 *   Under `strict` `L = 0` while `R > 0` — the audit counts a refusal and the row set
 *   does not hold it, which is the shape that made the original `83` unreadable.
 * - `E` is the number of refused ENDPOINTS, which is `0` unless `C` contains
 *   `UNKNOWN_ENTITY_TYPE` (`core/ontology.ts:589-596`), and is ONE when exactly one
 *   endpoint carries an undeclared type and TWO when both do — that function consults the
 *   allowlist for both endpoints instead of copying the verdict, so one refused triplet can
 *   store two refused entity rows and one refused edge: three rows for `R = 1`.
 *
 * - `C.length <= R`, and `C` cannot be inverted to a count: three refusals sharing one
 *   reason store one code.
 * - `samples.length = min(R, 5)` (`MAX_AUDIT_SAMPLES`, `audit.ts:101`), never `R`.
 * - The audit carries NO per-table split, so `R` and `C` alone never reach `E + L`, and a
 *   reader who wants the split must read both tables. That absence is why "derivable" is
 *   the right invariant and "equal" was not.
 *
 * So the readable statement, with the shapes measured below, is
 * `refused rows = R + E` whenever `L = R` holds — and `R` is a TRIPLET count, which the
 * reference document proves: it has THREE refused rows and `rejected: 2`, because one of
 * its two refusals refused an endpoint as well as an edge.
 *
 * ## What is observed
 *
 * The production HTTP route (`createApp`) over a real socket, this file's own database, and
 * then SQL reads of the two graph tables and of `stack_documents.audit`. No internal
 * classifier state is asserted; the refused rows are counted through the same columns a
 * consumer reads.
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
import { readOntologyAudit } from "./audit.js";

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

// A real socket, the way the sibling `packages/api` suite drives its surface: the route is
// reached over HTTP, so no in-process shortcut can stand in for it.
const server = createServer(app);
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const BASE_URL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

/**
 * POST one JSON body to one path on the listening app.
 *
 * @param path - Absolute path, including any query string.
 * @param body - The JSON body to send.
 * @returns The status and the parsed body.
 */
async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await transport(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Scratch space OUTSIDE the worktree: the ingest phase reads a document's bytes from disk. */
const scratch = await mkdtemp(join(tmpdir(), "kg-audit-rows-"));

/** The declaration every case is measured against: two entity types and exactly one verb. */
const DECLARATION = { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["EMPLOYS"] };

/** One triplet, in the shape the stubbed model answers with. */
interface Triplet {
  readonly subject: { readonly name: string; readonly type: string };
  readonly relation: { readonly type: string };
  readonly object: { readonly name: string; readonly type: string };
}

/**
 * Builds one triplet.
 *
 * @param subject - The subject's name.
 * @param subjectType - The subject's proposed type.
 * @param relation - The proposed verb.
 * @param object - The object's name.
 * @param objectType - The object's proposed type.
 * @returns The triplet the model would have returned.
 */
function triplet(
  subject: string,
  subjectType: string,
  relation: string,
  object: string,
  objectType: string,
): Triplet {
  return {
    subject: { name: subject, type: subjectType },
    relation: { type: relation },
    object: { name: object, type: objectType },
  };
}

/** The reference document, kept byte-identical to the one the parity suite measured. */
const REFERENCE_BODY = "Acme employs Ada. Globex acquired Nobody. Zorp employs Beacon.";

/**
 * One admitted triplet and TWO refused ones, which together store THREE refused rows.
 *
 * Derived from the classifier's checks, not read back from a run: `ACQUIRED` is not in
 * `relationshipTypes` (`UNKNOWN_RELATIONSHIP_TYPE`, both endpoints declared), and `Zorp`'s
 * `ALIEN_CONSTRUCT` is not in `entityTypes` (`UNKNOWN_ENTITY_TYPE`, and only that endpoint
 * carries the refused type). So `rejected` is 2 while the refused rows number 3 — the
 * divergence between a TRIPLET count and a ROW count, on the one document both this file
 * and the parity suite measure.
 */
const REFERENCE_TRIPLETS: readonly Triplet[] = [
  triplet("Acme", "COMPANY", "EMPLOYS", "Ada", "PERSON"),
  triplet("Globex", "COMPANY", "ACQUIRED", "Nobody", "PERSON"),
  triplet("Zorp", "ALIEN_CONSTRUCT", "EMPLOYS", "Beacon", "PERSON"),
];

/** Three refusals of ONE reason: the shape where each refusal stores exactly one row. */
const VERBS_ONLY_BODY = "Acme acquires Nobody. Globex acquires Ipsum. Initech acquires Beacon.";

/** The three refused verbs of {@link VERBS_ONLY_BODY}, every endpoint declared. */
const VERBS_ONLY_TRIPLETS: readonly Triplet[] = [
  triplet("Acme", "COMPANY", "ACQUIRED", "Nobody", "PERSON"),
  triplet("Globex", "COMPANY", "ACQUIRED", "Ipsum", "PERSON"),
  triplet("Initech", "COMPANY", "ACQUIRED", "Beacon", "PERSON"),
];

/** One triplet whose TWO endpoints carry the undeclared type. */
const BOTH_ENDPOINTS_BODY = "Zorp employs Beacon.";

/** The single triplet of {@link BOTH_ENDPOINTS_BODY}, refused at both ends. */
const BOTH_ENDPOINTS_TRIPLETS: readonly Triplet[] = [
  triplet("Zorp", "ALIEN_CONSTRUCT", "EMPLOYS", "Beacon", "ALIEN_CONSTRUCT"),
];

/** Five refusals: exactly {@link MAX_AUDIT_SAMPLES} of them, the cap's own boundary. */
const FIVE_BODY = "A acquires B. C acquires D. E acquires F. G acquires H. I acquires J.";

/** The five refused verbs of {@link FIVE_BODY}. */
const FIVE_TRIPLETS: readonly Triplet[] = [
  triplet("A", "COMPANY", "ACQUIRED", "B", "PERSON"),
  triplet("C", "COMPANY", "ACQUIRED", "D", "PERSON"),
  triplet("E", "COMPANY", "ACQUIRED", "F", "PERSON"),
  triplet("G", "COMPANY", "ACQUIRED", "H", "PERSON"),
  triplet("I", "COMPANY", "ACQUIRED", "J", "PERSON"),
];

/** Six refusals: one past the cap, so `samples` must stop while `rejected` keeps counting. */
const SIX_BODY = "A acquires B. C acquires D. E acquires F. G acquires H. I acquires J. K acquires L.";

/** The six refused verbs of {@link SIX_BODY}. */
const SIX_TRIPLETS: readonly Triplet[] = [
  ...FIVE_TRIPLETS,
  triplet("K", "COMPANY", "ACQUIRED", "L", "PERSON"),
];

/** One run's identifiers, so its audit and its rows can be read afterwards. */
interface Run {
  readonly stackId: string;
  readonly documentId: string;
}

/**
 * Creates a Stack carrying {@link DECLARATION}, through the same route a caller would use.
 *
 * @param label - A readable fragment in the unique domain, so a failure names its case.
 * @returns The Stack's id.
 */
async function createStack(label: string): Promise<string> {
  const domain = `w2ex-audit-rows-${label}-${randomUUID().slice(0, 8)}`;
  const created = await post("/stacks", { name: "Audit Rows", domain, ontology: DECLARATION });
  expect(created.status).toBe(201);
  return String(created.body["id"]);
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
 * Runs one ingest and one compile through the route under the requested contract.
 *
 * @param contract - The `ontology_contract` query value under test.
 * @param triplets - What the stubbed model answers the first chunk with.
 * @param body - The document text those triplets claim to come from.
 * @returns The Stack and document the run wrote to.
 */
async function run(contract: string, triplets: readonly Triplet[], body: string): Promise<Run> {
  const stackId = await createStack(contract);
  const documentId = await createDocument(stackId, body);
  const base = `/stacks/${stackId}/documents/${documentId}`;
  expect((await post(`${base}/ingest`, {})).status).toBe(200);
  setToolResponse([{ triplets }]);
  const compiled = await post(
    `${base}/compile?ontology_contract=${contract}&synthesize_descriptions=false`,
    {},
  );
  expect(compiled.status).toBe(200);
  return { stackId, documentId };
}

/** One refused row, as the class columns describe it. */
interface RefusedRow extends Record<string, unknown> {
  readonly label: string;
  readonly reason: string | null;
  readonly offending: string | null;
}

/** The refused rows of both tables, which is the row set the audit has to be derivable from. */
interface RefusedRows {
  readonly entities: readonly RefusedRow[];
  readonly relationships: readonly RefusedRow[];
}

/**
 * Reads both tables' refused rows for one Stack — a SQL read of the public tables,
 * tenant-bound the way this file's fixtures bind.
 *
 * @param stackId - The Stack to read.
 * @returns Every refused row, per table, in a deterministic order.
 */
async function refusedRows(stackId: string): Promise<RefusedRows> {
  return await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const entities = await tx.execute<RefusedRow>(sql`
      select name as label, ontology_rejection_reason as reason,
             ontology_offending_type as offending
      from ontology_entities
      where stack_id = ${stackId} and ontology_verdict = 'rejected'
      order by name
    `);
    const relationships = await tx.execute<RefusedRow>(sql`
      select type as label, ontology_rejection_reason as reason,
             ontology_offending_type as offending
      from ontology_relationships
      where stack_id = ${stackId} and ontology_verdict = 'rejected'
      order by type
    `);
    return { entities: [...entities], relationships: [...relationships] };
  });
}

/** The stored ontology section, plus the key set it actually has on disk. */
interface StoredAudit {
  readonly rejected: number;
  readonly reason_codes: readonly string[];
  readonly samples: readonly unknown[];
  /** The RAW jsonb keys, because the parsing schema would drop a stray key and hide it. */
  readonly keys: readonly string[];
}

/**
 * Reads the ontology section out of `stack_documents.audit` for one document.
 *
 * Both forms are read on purpose: the raw jsonb answers "which fields exist", and the
 * production reader (`readOntologyAudit`) answers "what the numbers are", so a blob that
 * parses cannot hide a field from the key assertion.
 *
 * @param run - The run whose document to read.
 * @returns The four numbers and the raw key set.
 */
async function storedAudit(run: Run): Promise<StoredAudit> {
  return await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${run.stackId}, true)`);
    const rows = await tx.execute<{ blob: unknown; section: unknown }>(sql`
      select audit as blob, audit -> 'ontology' as section
      from stack_documents where id = ${run.documentId}
    `);
    const parsed = readOntologyAudit(rows[0]?.blob);
    if (parsed === undefined) throw new Error("the run wrote no ontology section");
    const section = rows[0]?.section;
    const keys =
      typeof section === "object" && section !== null ? Object.keys(section).sort() : [];
    return {
      rejected: parsed.rejected,
      reason_codes: parsed.reason_codes,
      samples: parsed.samples,
      keys,
    };
  });
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

/**
 * Divergence 1, and the ONLY shape where R4's original wording holds: one refused row per
 * refused triplet, so `R` equals `E + L`.
 *
 * Every refusal here is an undeclared VERB, and a verb refusal keeps both endpoints, so the
 * three rows are three edges and no entity row. The equality is a property of this shape,
 * not of the audit: the next four tests each break it in a different way.
 */
async function pinOneRowPerRefusedTriplet(): Promise<void> {
  const run1 = await run("persist", VERBS_ONLY_TRIPLETS, VERBS_ONLY_BODY);
  const audit = await storedAudit(run1);
  const rows = await refusedRows(run1.stackId);

  expect(audit.rejected).toBe(3);
  expect(rows.entities).toEqual([]);
  expect(rows.relationships.map((row) => row.label)).toEqual(["ACQUIRED", "ACQUIRED", "ACQUIRED"]);
  // The equality R4 asked for, and it holds here for a reason this test names.
  expect(audit.rejected).toBe(rows.entities.length + rows.relationships.length);
}

/**
 * Divergence 2, the one that made the original `83` unreadable: under `strict` the audit
 * keeps counting refusals while the rows were DROPPED, so `R` is 2 and the row set is empty.
 */
async function pinStrictCountsWhatItDropped(): Promise<void> {
  const strict = await run("strict", REFERENCE_TRIPLETS, REFERENCE_BODY);
  const audit = await storedAudit(strict);
  const rows = await refusedRows(strict.stackId);

  expect(audit.rejected).toBe(2);
  expect(audit.reason_codes).toEqual(["UNKNOWN_ENTITY_TYPE", "UNKNOWN_RELATIONSHIP_TYPE"]);
  expect(rows.entities).toEqual([]);
  expect(rows.relationships).toEqual([]);
  // Two true statements about different things: three refusals were taken, no row holds one.
  expect(audit.rejected).toBeGreaterThan(rows.entities.length + rows.relationships.length);
}

/**
 * Divergence 3: `reason_codes` is a SET, so its length floors at the distinct reasons.
 *
 * Three refusals sharing one reason, which is the case the reference document does NOT
 * exhibit: that one has two refusals and two reasons, so its set is as long as its count
 * and proves nothing about deduplication.
 */
async function pinReasonCodesIsASet(): Promise<void> {
  const verbs = await run("persist", VERBS_ONLY_TRIPLETS, VERBS_ONLY_BODY);
  const audit = await storedAudit(verbs);
  const rows = await refusedRows(verbs.stackId);

  const distinctInRows = new Set(
    [...rows.entities, ...rows.relationships].map((row) => row.reason),
  );
  expect(audit.rejected).toBe(3);
  expect(audit.reason_codes).toEqual(["UNKNOWN_RELATIONSHIP_TYPE"]);
  // Faithful to the row set's distinct reasons, and therefore silent about the count.
  expect(audit.reason_codes.length).toBe(distinctInRows.size);
  expect(audit.reason_codes.length).toBeLessThan(audit.rejected);
}

/** Divergence 4: `samples` stops at five, at the boundary and one past it. */
async function pinSamplesStopAtFive(): Promise<void> {
  const five = await storedAudit(await run("persist", FIVE_TRIPLETS, FIVE_BODY));
  const sixRun = await run("persist", SIX_TRIPLETS, SIX_BODY);
  const six = await storedAudit(sixRun);
  const sixRows = await refusedRows(sixRun.stackId);

  // AT the cap: the count and the sample list agree, which is why five is not evidence.
  expect(five.rejected).toBe(5);
  expect(five.samples).toHaveLength(5);
  // ONE PAST it: the count keeps growing and the list does not.
  expect(six.rejected).toBe(6);
  expect(six.samples).toHaveLength(5);
  expect(six.samples.length).toBeLessThan(six.rejected);
  // The rows did keep counting, so the cap is the BLOB's budget and not the graph's.
  expect(sixRows.relationships).toHaveLength(6);
}

/** Divergence 5: ONE refused triplet, THREE refused rows, when both endpoints are refused. */
async function pinBothEndpointsRefused(): Promise<void> {
  const both = await run("persist", BOTH_ENDPOINTS_TRIPLETS, BOTH_ENDPOINTS_BODY);
  const audit = await storedAudit(both);
  const rows = await refusedRows(both.stackId);

  expect(audit.rejected).toBe(1);
  expect(audit.reason_codes).toEqual(["UNKNOWN_ENTITY_TYPE"]);
  // Both endpoints carry the undeclared type, and both are stored refused with it.
  expect(rows.entities.map((row) => [row.label, row.offending])).toEqual([
    ["Beacon", "ALIEN_CONSTRUCT"],
    ["Zorp", "ALIEN_CONSTRUCT"],
  ]);
  expect(rows.relationships.map((row) => [row.label, row.reason])).toEqual([
    ["EMPLOYS", "UNKNOWN_ENTITY_TYPE"],
  ]);
  // The factor, named: ONE refused edge per refused triplet, PLUS one refused entity row
  // per refused ENDPOINT — 2 here, because both endpoints carry the undeclared type.
  expect(rows.relationships.length).toBe(audit.rejected);
  expect(rows.entities.length).toBe(2);
  expect(rows.entities.length + rows.relationships.length).toBe(audit.rejected + 2);
}

/** Divergence 6: the audit cannot say which TABLE a refusal landed in, so both are needed. */
async function pinNoPerTableSplit(): Promise<void> {
  const ref = await run("persist", REFERENCE_TRIPLETS, REFERENCE_BODY);
  const audit = await storedAudit(ref);
  const rows = await refusedRows(ref.stackId);

  // The stored section, key for key: no field separates an entity refusal from an edge one.
  expect(audit.keys).toEqual(["declared", "enforced", "reason_codes", "rejected", "samples"]);
  expect(rows.entities).toHaveLength(1);
  expect(rows.relationships).toHaveLength(2);
  // Two refusals, three refused rows: `rejected` is a TRIPLET count, so it is not the total
  // either, and the refused-entity rows are reachable only by reading their own table.
  expect(audit.rejected).toBe(2);
  expect(audit.rejected).not.toBe(rows.entities.length + rows.relationships.length);
}

describe("the audit's numbers against the refused rows, under persist and strict", () => {
  it("equals the row count only when each refusal stores one row (S4.1)", pinOneRowPerRefusedTriplet, 60_000);
  it("counts what strict dropped, with zero rows to show for it (S4.2)", pinStrictCountsWhatItDropped, 60_000);
  it("stores reason_codes as a set: fewer codes than refusals (S4.3)", pinReasonCodesIsASet, 60_000);
  it("stops samples at five while rejected keeps counting (S4.4)", pinSamplesStopAtFive, 60_000);
  it("stores three rows for one refused triplet when both endpoints are refused (S4.5)", pinBothEndpointsRefused, 60_000);
  it("publishes no per-table split, so both row counts are needed (S4.6)", pinNoPerTableSplit, 60_000);
});
