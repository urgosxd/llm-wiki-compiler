/**
 * @file packages/api/src/kg-ontology-contract-parity.test.ts
 * @description T3 of `odd/tasks/kg-ontology-contract-persist-mode.md`: `persist` driven
 * through BOTH entry points, against one document, one declaration and one database.
 *
 * ## Why this file lives in `packages/api/src/`
 *
 * It needs the HTTP ingest route (`@repo/kg`) and the wiki `kg` dimension (`@repo/wiki`) in
 * ONE file, and the boundary forbids `wiki ↔ kg` both ways: `eslint.config.mjs:90` puts
 * `test/` on the WIKI side, so a root test naming `@repo/kg` would be a NEW reach, and
 * `eslint.config.mjs:70` puts `packages/llmwiki-kg/` on the KG side. `packages/api/` is the
 * sanctioned joiner — `eslint.config.mjs:310-311` turns `no-restricted-imports` off there, and
 * `local/dimension-boundary` covers only the two dimension zones — so this is the one tree
 * where both entry points are reachable, and the expected counts stay literals instead of
 * being duplicated across two files as `core/accepted-set-differential.test.ts:15-18` warns.
 *
 * ## What it pins
 *
 * 1. The central rule: one document and one declaration produce the SAME class counts
 *    through both entry points, per table.
 * 2. `persist` stores a refused triplet with its own class, reason code and refused type —
 *    never a boolean, never the class word repeated as the reason.
 * 3. NOT BY LUCK: `strict` still refuses without storing and `open` still takes no verdict,
 *    on the same input, so "the class columns changed for everybody" cannot pass (1).
 * 4. A reader cannot tell which entry point wrote a refused row: the two row sets are
 *    compared column by column.
 *
 * The numbers are derived from the classifier's four checks (`core/ontology.ts:577-607`)
 * over the three triplets below, never read back out of a run.
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

import { createClient, createDatabase, createRequireApiKey } from "@repo/kg";
import { parseConfig } from "@repo/kg/config";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "@repo/kg/core/extraction-harness";
import { createRequestTransactionWrapper, createTransactionRunner } from "@repo/kg/db";
import { createApp } from "@repo/kg/server";
import { perRunDatabase } from "@repo/kg/testing/per-run-database";
import { resolveDimensions } from "@repo/wiki/dimensions-activation";
import { listenOn } from "@repo/wiki/http-listen";

/** The server the run's per-process database is provisioned on, resolved as CI resolves it. */
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

// A real socket, the way the sibling `packages/api` suites drive their surface: the route is
// reached over HTTP, so no in-process shortcut can stand in for it.
const server = createServer(app);
await listenOn(server, 0, "127.0.0.1");
const BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/**
 * POST one JSON body to one path on the listening app.
 *
 * @param path - Absolute path, including any query string.
 * @param body - The JSON body to send.
 * @returns The status and the parsed body, which every caller asserts on.
 */
async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await transport(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Scratch space OUTSIDE the worktree: the ingest phase reads a document's bytes from disk. */
const scratch = await mkdtemp(join(tmpdir(), "kg-contract-parity-"));

/** The declaration both entry points enforce: two entity types and exactly one verb. */
const DECLARATION = { entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["EMPLOYS"] };

/** One document body, short enough to chunk once, so extraction makes exactly one call. */
const BODY = "Acme employs Ada. Globex acquired Nobody. Zorp employs Beacon.";

/** The three triplets the stubbed model returns: one admitted, two refused, two reasons. */
const TRIPLETS = [
  {
    subject: { name: "Acme", type: "COMPANY" },
    relation: { type: "EMPLOYS" },
    object: { name: "Ada", type: "PERSON" },
  },
  {
    subject: { name: "Globex", type: "COMPANY" },
    relation: { type: "ACQUIRED" },
    object: { name: "Nobody", type: "PERSON" },
  },
  {
    subject: { name: "Zorp", type: "ALIEN_CONSTRUCT" },
    relation: { type: "EMPLOYS" },
    object: { name: "Beacon", type: "PERSON" },
  },
];

/** One stored graph row, as the class columns describe it. */
interface GraphRow extends Record<string, unknown> {
  /** The row's own name (entities) or verb (relationships), for a readable failure. */
  readonly label: string;
  readonly verdict: string;
  readonly type: string;
  readonly reason: string | null;
  readonly offending: string | null;
}

/** The two counts every assertion in this file speaks in. */
interface ClassCounts {
  readonly accepted: number;
  readonly rejected: number;
}

/** Per-table class counts, which is the shape the central rule compares. */
interface GraphCounts {
  readonly entities: ClassCounts;
  readonly relationships: ClassCounts;
}

/**
 * Count one table's rows by class.
 *
 * @param rows - Rows read from one table, in any order.
 * @returns How many carry each class.
 */
function counts(rows: readonly GraphRow[]): ClassCounts {
  return {
    accepted: rows.filter((row) => row.verdict === "accepted").length,
    rejected: rows.filter((row) => row.verdict === "rejected").length,
  };
}

/**
 * Read one table's class columns for one Stack — a SQL read of the public tables,
 * tenant-bound the way every fixture here binds.
 *
 * @param stackId - The Stack to read.
 * @param table - `ontology_entities` or `ontology_relationships`.
 * @returns Every row's class, type, reason and refused type.
 */
async function readTable(stackId: string, table: "ontology_entities" | "ontology_relationships") {
  const statement =
    table === "ontology_entities"
      ? sql`select name as label, type, ontology_verdict as verdict,
              ontology_rejection_reason as reason, ontology_offending_type as offending
            from ontology_entities where stack_id = ${stackId} order by verdict, type, name`
      : sql`select type as label, type, ontology_verdict as verdict,
              ontology_rejection_reason as reason, ontology_offending_type as offending
            from ontology_relationships where stack_id = ${stackId} order by verdict, type`;
  return await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return await tx.execute<GraphRow>(statement);
  });
}

/** Both tables' rows for one Stack, so a test can count and compare in one read. */
async function graphRows(stackId: string): Promise<GraphCounts> {
  const entities = await readTable(stackId, "ontology_entities");
  const relationships = await readTable(stackId, "ontology_relationships");
  return { entities: counts(entities), relationships: counts(relationships) };
}

/** Creates a Stack carrying {@link DECLARATION}, through the same route a caller would use. */
async function createStack(label: string): Promise<string> {
  const domain = `w2ex-api-parity-${label}-${randomUUID().slice(0, 8)}`;
  const created = await post("/stacks", { name: "Contract Parity", domain, ontology: DECLARATION });
  expect(created.status).toBe(201);
  return String(created.body["id"]);
}

/** Stores one document row whose bytes live in this file's scratch directory. */
async function createDocument(stackId: string): Promise<string> {
  const documentId = randomUUID();
  const absolute = join(scratch, `${documentId}.txt`);
  await writeFile(absolute, BODY, "utf8");
  await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into stack_documents (id, stack_id, filename, storage_path, size_bytes, source_hash)
      values (${documentId}, ${stackId}, ${`${documentId}.txt`}, ${absolute},
              ${Buffer.byteLength(BODY, "utf8")}, ${randomUUID()})
    `);
  });
  return documentId;
}

/**
 * Runs the HTTP entry point: ingest, then compile under the requested contract.
 *
 * @param contract - The `ontology_contract` query value under test.
 * @returns The Stack the run wrote to.
 */
async function viaRoute(contract: string): Promise<string> {
  const stackId = await createStack(`route-${contract}`);
  const documentId = await createDocument(stackId);
  const base = `/stacks/${stackId}/documents/${documentId}`;
  expect((await post(`${base}/ingest`, {})).status).toBe(200);
  setToolResponse([{ triplets: TRIPLETS }]);
  const compiled = await post(
    `${base}/compile?ontology_contract=${contract}&synthesize_descriptions=false`,
    {},
  );
  expect(compiled.status).toBe(200);
  return stackId;
}

/**
 * Runs the wiki `kg` dimension entry point: the production resolution, no contract named.
 *
 * `resolveDimensions` builds `createKgDimension` with no `contract` option — exactly the
 * state the defect is about — and, because no declaration is passed here, the dimension
 * reads the Stack's stored one through the production reader: the same declaration the
 * route enforced, obtained by the same path a compile uses.
 *
 * @returns The Stack the run wrote to.
 */
async function viaDimension(): Promise<string> {
  const stackId = await createStack("dimension");
  const [kg] = resolveDimensions({
    root: process.cwd(),
    db: database,
    stackId,
    only: ["kg"],
    env: {
      ...process.env,
      LLMWIKI_DIMENSIONS: "kg",
      AKS_DATABASE_URL: suite.url,
      AKS_STACK_NAME: "contract-parity",
    },
  });
  if (kg === undefined) throw new Error("the kg dimension did not resolve");
  setToolResponse([{ triplets: TRIPLETS }]);
  const source = `parity/${stackId}.md`;
  await kg.commit(await kg.prepare({ source, title: "Parity", document: BODY, body: BODY }));
  return stackId;
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
 * S1 + S3, the central pin: both entry points, one document, one declaration, one answer.
 *
 * The literals are the classifier's arithmetic over {@link TRIPLETS}: the admitted triplet
 * is one accepted edge with two accepted endpoints; the unknown verb is refused with both
 * endpoints declared, so they stay accepted; the unknown entity type is refused and only
 * that endpoint is stored refused. Hence five and one, one and two.
 */
async function centralPin(): Promise<void> {
  const route = await graphRows(await viaRoute("persist"));
  const dimension = await graphRows(await viaDimension());

  const expected: GraphCounts = {
    entities: { accepted: 5, rejected: 1 },
    relationships: { accepted: 1, rejected: 2 },
  };

  expect(route).toEqual(expected);
  expect(dimension).toEqual(expected);
  // The rule itself, stated as the comparison that used to fail: one document and one
  // declaration, so any difference between these two objects is the divergence.
  expect(route).toEqual(dimension);
}

/** S1: the refused row carries its own class, reason and refused type — not a boolean,
 * and not the class word (`"rejected"`) where a reason belongs. */
async function persistKeepsTheReason(): Promise<void> {
  const stackId = await viaRoute("persist");
  const refused = (await readTable(stackId, "ontology_relationships")).filter(
    (row) => row.type === "ACQUIRED",
  );

  expect(refused).toEqual([
    { label: "ACQUIRED", type: "ACQUIRED", verdict: "rejected", reason: "UNKNOWN_RELATIONSHIP_TYPE", offending: "ACQUIRED" },
  ]);
  // NOT a boolean, and NOT the class word reused as the reason.
  const reason = refused[0]?.reason;
  expect(typeof reason).toBe("string");
  expect(["rejected", "true", "false"]).not.toContain(reason);

  const refusedEntity = (await readTable(stackId, "ontology_entities")).filter(
    (row) => row.verdict === "rejected",
  );
  expect(refusedEntity.map((row) => [row.type, row.reason])).toEqual([
    ["ALIEN_CONSTRUCT", "UNKNOWN_ENTITY_TYPE"],
  ]);
}

/**
 * NOT BY LUCK: `persist` reaches these rows by falling through two guards — the open-only
 * branch at `core/graph-extraction.ts:261` and the `contract !== "strict"` filter at
 * `routes/ingest/compile-chunks.ts:375`. On the SAME document, `strict` must still store no
 * refused row and `open` must still take no verdict, which separates that mechanism from
 * "the class columns changed for everybody".
 */
async function notByLuck(): Promise<void> {
  const strict = await graphRows(await viaRoute("strict"));
  const open = await graphRows(await viaRoute("open"));
  const persist = await graphRows(await viaRoute("persist"));

  expect(strict).toEqual({ entities: { accepted: 5, rejected: 0 }, relationships: { accepted: 1, rejected: 0 } });
  expect(persist).toEqual({ entities: { accepted: 5, rejected: 1 }, relationships: { accepted: 1, rejected: 2 } });
  // No verdict is taken under the open contract, so nothing is refused: all three verbs are
  // rows and every endpoint keeps the type the model proposed.
  expect(open).toEqual({ entities: { accepted: 6, rejected: 0 }, relationships: { accepted: 3, rejected: 0 } });
}

/**
 * S3, the reader's half: the refused rows are indistinguishable between the two writers.
 *
 * Class, type, reason and refused type, per row, per table — compared directly, so a
 * difference fails with both values in the message. A refused ENDPOINT's offending type is
 * its own type, the label the verdict was reached about (`core/graph-extraction.ts:420`).
 */
async function readersCannotTell(): Promise<void> {
  const routeStack = await viaRoute("persist");
  const dimensionStack = await viaDimension();
  const refused = async (stackId: string) => ({
    entities: (await readTable(stackId, "ontology_entities")).filter((row) => row.verdict === "rejected"),
    relationships: (await readTable(stackId, "ontology_relationships")).filter((row) => row.verdict === "rejected"),
  });

  const route = await refused(routeStack);
  const dimension = await refused(dimensionStack);

  expect(route).toEqual(dimension);
  expect(route.relationships).toEqual([
    { label: "ACQUIRED", type: "ACQUIRED", verdict: "rejected", reason: "UNKNOWN_RELATIONSHIP_TYPE", offending: "ACQUIRED" },
    { label: "EMPLOYS", type: "EMPLOYS", verdict: "rejected", reason: "UNKNOWN_ENTITY_TYPE", offending: "ALIEN_CONSTRUCT" },
  ]);
  expect(route.entities).toEqual([
    { label: "Zorp", type: "ALIEN_CONSTRUCT", verdict: "rejected", reason: "UNKNOWN_ENTITY_TYPE", offending: "ALIEN_CONSTRUCT" },
  ]);
}

describe("the persist contract, through both entry points", () => {
  it("yields identical class counts for one document and one declaration (S1, S3)", centralPin, 60_000);
  it("stores the refused triplet with its own reason, not a boolean (S1)", persistKeepsTheReason, 60_000);
  it("is not by luck: strict still drops and open still takes no verdict", notByLuck, 60_000);
  it("leaves no column a reader could use to tell the writers apart (S3)", readersCannotTell, 60_000);
});
