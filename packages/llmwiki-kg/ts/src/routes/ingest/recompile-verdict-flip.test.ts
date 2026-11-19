/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/recompile-verdict-flip.test.ts
 * @description T9 of `odd/tasks/kg-ontology-contract-persist-mode.md` (S8): when the
 * DECLARATION changes between two compiles, the class of an edge already on disk
 * follows the new verdict — as ONE row, not two and not the old class.
 *
 * ## What the human asked for
 *
 * "en el caso de re-compilacion podrian cambiar pero siempre habra rechazados" — a
 * recompile may change which class an edge is in. The narrow pin, and nothing more:
 * a triplet refused under the first declaration, accepted under the second, compiled
 * again, must leave exactly one row for its edge identity, carrying `accepted`.
 *
 * ## Where the declaration actually changes
 *
 * Not on the ingest request and not on a query string: it lives in `stacks.ontology`,
 * is written by `PATCH /stacks/:stackId` (`routes/stacks.ts:709` → `updateStack` at
 * `routes/stacks.ts:579`, whose `ontology` assignment is the jsonb one at
 * `routes/stacks.ts:124-131`), and is read back per compile by the document query
 * (`routes/ingest/request.ts:228`, `s.ontology as stack_ontology`) and handed to the
 * extractor as its argument (`routes/ingest/compile-chunks.ts:310`). So the flip below
 * is a GENUINE declaration change against the same document bytes and the same model
 * answer: only the vocabulary the triplet is measured against moves.
 *
 * ## Why one row is even possible
 *
 * `unique_edge_per_stack (stack_id, from_entity_id, to_entity_id, type)` admits one row
 * per edge identity, so the second compile's write COLLIDES with the first's row rather
 * than adding a sibling. The collision clause decides the class in SQL
 * (`ACCEPTED_WINS_SET`, `core/document-consolidation.ts:542-558`) and clears the two
 * rejection columns with it, because `ontology_rejection_reason_requires_rejected`
 * refuses a reason on an accepted row. That clause is what the assertions below measure;
 * no test here recomputes a verdict from its own input.
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
const scratch = await mkdtemp(join(tmpdir(), "kg-verdict-flip-"));

/** The endpoint types both declarations share, so only the verb's admission can flip. */
const ENTITY_TYPES = ["COMPANY", "PERSON"];

/** BEFORE: one verb, and it is not the one the triplet uses. */
const DECLARATION_BEFORE = { entityTypes: ENTITY_TYPES, relationshipTypes: ["WORKS_AT"] };

/** AFTER: the same declaration plus the triplet's verb — the only thing that changes. */
const DECLARATION_AFTER = { entityTypes: ENTITY_TYPES, relationshipTypes: ["WORKS_AT", "EMPLOYS"] };

/** The document text, unchanged across both compiles. */
const BODY = "Acme employs Ada.";

/** The one triplet the stubbed model answers with, every time it is asked. */
const TRIPLETS = [
  {
    subject: { name: "Acme", type: "COMPANY" },
    relation: { type: "EMPLOYS" },
    object: { name: "Ada", type: "PERSON" },
  },
];

/**
 * The edge identity the flip is pinned on, in both of the shapes it is recorded.
 *
 * `type` plus the two endpoint names is `unique_edge_per_stack`'s identity — the one the
 * second compile's write collides on — and `identityKey` is the predicate-derived key the
 * `fill_identity_key` trigger stores (`db/schema.sql:561-578`).
 */
const EDGE = {
  from: "Acme",
  to: "Ada",
  type: "EMPLOYS",
  identityKey: "employs",
} as const;

/** One stored edge row of {@link EDGE}, as the class columns describe it. */
interface EdgeRow extends Record<string, unknown> {
  readonly id: string;
  readonly identity_key: string;
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
  const domain = `w2ex-verdict-flip-${label}-${randomUUID().slice(0, 8)}`;
  const created = await send("POST", "/stacks", { name: "Flip", domain, ontology });
  expect(created.status).toBe(201);
  return String(created.body["id"]);
}

/**
 * Replaces the Stack's declaration — the ontology change under test.
 *
 * @param stackId - The Stack to update.
 * @param ontology - The new declaration.
 * @returns The status, so the caller asserts the write was accepted.
 */
async function patchOntology(stackId: string, ontology: unknown): Promise<number> {
  return (await send("PATCH", `/stacks/${stackId}`, { ontology })).status;
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
 * Runs the form phase and then one compile, under `persist`.
 *
 * Both phases are required: `POST /ingest` writes no graph row, and the rows this file
 * counts come from `POST /compile`, which reads the Stack's CURRENT declaration.
 *
 * @param run - The Stack and document to compile.
 * @param fresh - True to create the document row, false to recompile the existing one.
 */
async function compile(run: { stackId: string; documentId: string }, fresh: boolean): Promise<void> {
  const base = `/stacks/${run.stackId}/documents/${run.documentId}`;
  if (fresh) expect((await send("POST", `${base}/ingest`, {})).status).toBe(200);
  setToolResponse([{ triplets: TRIPLETS }]);
  const compiled = await send("POST", `${base}/compile?ontology_contract=persist&synthesize_descriptions=false`, {});
  expect(compiled.status).toBe(200);
}

/**
 * Reads every stored edge row of {@link EDGE} for one Stack, through the public tables.
 *
 * @param stackId - The Stack to read.
 * @returns Its rows, in a deterministic order. One row is the expected count, so the
 *   length is itself the "not two rows" assertion.
 */
async function edgeRows(stackId: string): Promise<readonly EdgeRow[]> {
  return await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<EdgeRow>(sql`
      select r.id, r.identity_key,
             r.ontology_verdict as verdict,
             r.ontology_rejection_reason as reason,
             r.ontology_offending_type as offending
      from ontology_relationships r
      join ontology_entities f on f.id = r.from_entity_id
      join ontology_entities t on t.id = r.to_entity_id
      where r.stack_id = ${stackId}
        and r.type = ${EDGE.type}
        and lower(f.name) = lower(${EDGE.from})
        and lower(t.name) = lower(${EDGE.to})
      order by r.id
    `);
    return [...rows];
  });
}

/**
 * Counts the rows of {@link EDGE} whose stored class is `rejected`, in SQL.
 *
 * A query of its own rather than a filter over {@link edgeRows}, so the "the old verdict
 * is gone" assertion is answered by storage and not by this file's mapping.
 *
 * @param stackId - The Stack to read.
 * @returns How many rows of that identity are stored refused.
 */
async function rejectedEdgeCount(stackId: string): Promise<number> {
  return await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n
      from ontology_relationships r
      join ontology_entities f on f.id = r.from_entity_id
      join ontology_entities t on t.id = r.to_entity_id
      where r.stack_id = ${stackId}
        and r.type = ${EDGE.type}
        and lower(f.name) = lower(${EDGE.from})
        and lower(t.name) = lower(${EDGE.to})
        and r.ontology_verdict = 'rejected'
    `);
    return rows[0]?.n ?? 0;
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
 * S8 itself: a refused triplet whose declaration later admits it ends as ONE row
 * carrying the NEW class.
 *
 * The first compile is a precondition, not a warm-up: if the refused row is missing the
 * flip has nothing to follow, and the first assertion says so instead of letting the
 * later ones pass over an empty set.
 */
async function pinOneRowWithTheNewVerdict(): Promise<void> {
  const run = { stackId: await createStack(DECLARATION_BEFORE, "flip"), documentId: "" };
  run.documentId = await createDocument(run.stackId, BODY);
  await compile(run, true);

  // BEFORE: the row exists, refused, with the specific reason the classifier produces.
  const before = await edgeRows(run.stackId);
  expect(before.length).toBe(1);
  expect(before[0]?.verdict).toBe("rejected");
  expect(before[0]?.reason).toBe("UNKNOWN_RELATIONSHIP_TYPE");
  expect(before[0]?.offending).toBe(EDGE.type);

  // THE CHANGE: the same Stack, the same document bytes, one more declared verb.
  expect(await patchOntology(run.stackId, DECLARATION_AFTER)).toBe(200);
  await compile(run, false);

  // AFTER: exactly one row, the SAME row, carrying the new class and no prose of the old one.
  const after = await edgeRows(run.stackId);
  expect(after.length).toBe(1);
  expect(after[0]?.id).toBe(before[0]?.id);
  expect(after[0]?.identity_key).toBe(EDGE.identityKey);
  expect(after[0]?.verdict).toBe("accepted");
  expect(after[0]?.reason).toBeNull();
  expect(after[0]?.offending).toBeNull();
  expect(await rejectedEdgeCount(run.stackId)).toBe(0);
}

/**
 * The control that makes the test above non-vacuous: WITHOUT the declaration change, the
 * same recompile leaves the old class in place.
 *
 * So the flip measured above is the declaration's doing and not recompilation's — a
 * second compile on its own is idempotent for this row.
 */
async function pinRecompileAloneKeepsTheVerdict(): Promise<void> {
  const run = { stackId: await createStack(DECLARATION_BEFORE, "control"), documentId: "" };
  run.documentId = await createDocument(run.stackId, BODY);
  await compile(run, true);
  const before = await edgeRows(run.stackId);
  expect(before.length).toBe(1);

  await compile(run, false);

  const after = await edgeRows(run.stackId);
  expect(after.length).toBe(1);
  expect(after[0]?.id).toBe(before[0]?.id);
  expect(after[0]?.verdict).toBe("rejected");
  expect(after[0]?.reason).toBe("UNKNOWN_RELATIONSHIP_TYPE");
  expect(after[0]?.offending).toBe(EDGE.type);
  expect(await rejectedEdgeCount(run.stackId)).toBe(1);
}

describe("a recompiled verdict flip lands on one row (S8)", () => {
  it("keeps ONE row holding the new verdict after the declaration admits it (S8.1)", pinOneRowWithTheNewVerdict, 60_000);
  it("keeps the old verdict when only the recompile happens (S8.2)", pinRecompileAloneKeepsTheVerdict, 60_000);
});
