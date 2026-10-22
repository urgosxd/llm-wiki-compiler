import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import express from "express";
import type { Express } from "express";
import type { Sql } from "postgres";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "../db.js";
import type { Database } from "../db.js";
import { createIngestRouter } from "./ingest.js";
import type { IngestRouterDependencies } from "./ingest.js";

/**
 * Integration tests for the ingest endpoint, against the live compose database
 * on port 5434.
 *
 * ## Cost discipline — how many live LLM calls this suite makes
 *
 * **Two.** Both are in the single `describe("ingest (live gateway)")` block, and
 * both belong to one document's two ingests (first ingest + re-ingest), which is
 * the only way to observe the consolidation contract the task asked to verify:
 * `relationships_written` stays at 1 while `relationships_in_stack` grows.
 *
 * Every other test in this file makes **zero** provider calls: the validation,
 * 404, missing-file, binary and truncation paths all answer before the pipeline
 * reaches the gateway, which is itself part of the contract being pinned.
 *
 * ## Fixture isolation
 *
 * Every Stack this suite creates has a `domain` starting with {@link DOMAIN_PREFIX},
 * and every other row hangs off it by foreign key with `on delete cascade`, so
 * deleting the prefixed Stacks is a complete cleanup. Storage files are written
 * under `uploads/{stack}/` inside the repository's ignored uploads directory and
 * removed by deleting their Stack rows plus explicit `unlink` attempts in
 * `afterAll`.
 *
 * This suite skips — never fails — when the database or the gateway is
 * unreachable, matching the other integration suites.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/** Unique domain prefix; the only key cleanup ever deletes on. */
const DOMAIN_PREFIX = "w2ex-ingest-";

/** An unknown-but-valid UUID used where a 404 is expected. */
const UNKNOWN_UUID = "11111111-1111-1111-1111-111111111111";

/** Oracle field set and order for `IngestionResult`. */
const RESPONSE_KEYS = [
  "document_id",
  "chunks_created",
  "entities_extracted",
  "entities_in_stack",
  "relationships_extracted",
  "relationships_written",
  "relationships_in_stack",
  "truncated",
  "descriptions_synthesized",
] as const;

/**
 * Provider configuration, hoisted above the imports that read it.
 *
 * `config` parses `process.env` once at module load, so the environment must be
 * set before `../config.js` is imported. The values come from `.env` when
 * `AKS_TEST_GATEWAY=1` (the live-gateway block needs real credentials); every
 * other test only needs the providers selected, because it never reaches the
 * gateway.
 */
vi.hoisted(() => {
  if (process.env["AKS_TEST_GATEWAY"] !== "1") {
    process.env["EXTRACTION_PROVIDER"] ??= "gateway";
    process.env["EMBEDDING_PROVIDER"] ??= "gateway";
    process.env["GATEWAY_URL"] ??= "https://gateway.invalid/v1";
    process.env["GATEWAY_API_KEY"] ??= "test-key-not-a-credential";
    process.env["EMBEDDING_MODEL"] ??= "hf:nomic-ai/nomic-embed-text-v1.5";
    process.env["EMBEDDING_DIM"] ??= "768";
    process.env["EXTRACTION_MODEL"] ??= "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  }
});

const state: {
  client?: Sql;
  database?: Database;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  const candidate = createClient(TEST_DATABASE_URL, CONNECT_TIMEOUT_SECONDS);
  try {
    await candidate`select 1`;
    state.client = candidate;
    state.database = createDatabase(candidate);
    state.skipReason = false;
  } catch (error) {
    state.skipReason = `database unreachable at ${TEST_DATABASE_URL}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await candidate.end({ timeout: 1 }).catch(() => undefined);
  }
}

if (state.skipReason !== false) {
  console.warn(`[ingest.test] skipping integration tests — ${state.skipReason}`);
}

/** Narrows the setup state for the compiler without an unchecked cast. */
function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

/** Storage paths written by this suite, removed in `afterAll`. */
const writtenFiles = new Set<string>();

/** Deletes every row this suite created, children first. */
async function deleteFixtureRows(): Promise<void> {
  const prefixed = sql`select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}`;

  await database().execute(
    sql`delete from entity_source_documents where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_relationships where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_entities where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from document_chunks where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from stack_documents where stack_id in (${prefixed})`,
  );
  await database().execute(sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`);
}

/** Counts this suite's remaining chunks; proves cleanup actually happened. */
async function countFixtureRows(): Promise<number> {
  const rows = await database().execute<{ total: number }>(sql`
    select
      (select count(*) from document_chunks
        where stack_id in (select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}))
      + (select count(*) from ontology_entities
        where stack_id in (select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}))
      as total
  `);
  // The sum of two `count(*)` values is `numeric`, which postgres-js delivers as
  // a string; `Number` is the narrowing, and a missing row is treated as "cleanup
  // did not run" rather than "clean".
  const total = rows[0]?.total;
  return total === undefined ? -1 : Number(total);
}

afterAll(async () => {
  await deleteFixtureRows();
  expect(await countFixtureRows()).toBe(0);

  const { unlink } = await import("node:fs/promises");
  for (const path of writtenFiles) {
    await unlink(resolve(process.cwd(), path)).catch(() => undefined);
  }

  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

/** Builds the app the way `createApp` does, but bound to this suite's pool. */
function createTestApp(): Express {
  const deps: IngestRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    // Open mode: auth is a separate, already-verified surface.
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
  };

  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error && err.message !== "" ? err.message : "Internal Server Error";
    res.status(500).type("text/plain").send(message);
  });
  return app;
}

/** Creates a Stack with the fixture domain prefix and returns its id. */
async function createStack(overrides: { synthesize?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await database().execute(sql`
    insert into stacks (id, name, domain, synthesize_descriptions)
    values (
      ${id}, ${`w2ex ${suffix}`}, ${`${DOMAIN_PREFIX}${suffix}`},
      ${overrides.synthesize ?? false}
    )
  `);
  return id;
}

/**
 * Creates a document row plus its file on disk, returning the document id.
 *
 * The file is written through the suite's own storage path rather than through
 * the upload endpoint, so this test stays focused on ingest.
 */
async function createDocument(
  stackId: string,
  content: string | Uint8Array,
  filename = "fixture.txt",
): Promise<string> {
  const documentId = randomUUID();
  const relative = `uploads/${stackId}/${documentId}.txt`;
  const absolute = resolve(process.cwd(), relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  writtenFiles.add(relative);

  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
  await database().execute(sql`
    insert into stack_documents (
      id, stack_id, filename, storage_path, size_bytes, source_hash
    )
    values (${documentId}, ${stackId}, ${filename}, ${relative}, ${bytes}, ${randomUUID()})
  `);
  return documentId;
}

/** Renders an ingest URL. */
function ingestUrl(stackId: string, documentId: string, query = ""): string {
  return `/stacks/${stackId}/documents/${documentId}/ingest${query}`;
}

describe.skipIf(state.skipReason !== false)("ingest request handling (no gateway)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterEach(async () => {
    await deleteFixtureRows();
  });

  it("answers 200 with the oracle's exact field set and order", async () => {
    const stackId = await createStack();
    // A whitespace-only document yields no chunks, so no provider call happens —
    // this pins the response envelope without spending money.
    const documentId = await createDocument(stackId, "   \n\n   ");

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(Object.keys(response.body)).toEqual([...RESPONSE_KEYS]);
    expect(response.body).toEqual({
      document_id: documentId,
      chunks_created: 0,
      entities_extracted: 0,
      entities_in_stack: 0,
      relationships_extracted: 0,
      relationships_written: 0,
      relationships_in_stack: 0,
      truncated: false,
      descriptions_synthesized: false,
    });
  });

  it("answers 422 for both malformed uuids, in declaration order", async () => {
    // Measured on the oracle: `stack_id` entry first, then `doc_id`, each with
    // Pydantic's `uuid_parsing` details.
    const response = await request(app)
      .post("/stacks/not-a-uuid/documents/also-bad/ingest")
      .expect(422);

    const detail = response.body.detail as Array<{ type: string; loc: string[]; input: string }>;
    expect(detail).toHaveLength(2);
    expect(detail[0]?.loc).toEqual(["path", "stack_id"]);
    expect(detail[0]?.input).toBe("not-a-uuid");
    expect(detail[0]?.type).toBe("uuid_parsing");
    expect(detail[1]?.loc).toEqual(["path", "doc_id"]);
    expect(detail[1]?.input).toBe("also-bad");
  });

  it("reports path and query failures together, path entries first", async () => {
    // Measured: three entries in the order stack_id, doc_id, query.
    const response = await request(app)
      .post("/stacks/nope/documents/nope2/ingest?synthesize_descriptions=maybe")
      .expect(422);

    const detail = response.body.detail as Array<{ type: string; loc: string[] }>;
    expect(detail.map((entry) => entry.loc)).toEqual([
      ["path", "stack_id"],
      ["path", "doc_id"],
      ["query", "synthesize_descriptions"],
    ]);
    expect(detail[2]?.type).toBe("bool_parsing");
  });

  it("rejects an unparseable query flag even with valid uuids", async () => {
    // Measured: `""` and `"maybe"` both answer bool_parsing.
    const response = await request(app)
      .post(ingestUrl(UNKNOWN_UUID, UNKNOWN_UUID, "?synthesize_descriptions="))
      .expect(422);

    const detail = response.body.detail as Array<{ loc: string[]; input: unknown }>;
    expect(detail).toHaveLength(1);
    expect(detail[0]?.loc).toEqual(["query", "synthesize_descriptions"]);
    expect(detail[0]?.input).toBe("");
  });

  it("answers 404 naming both the document and the stack", async () => {
    // Measured wording, including the stack id — an unknown stack and an unknown
    // document produce the same message because the lookup joins both tables.
    const response = await request(app)
      .post(ingestUrl(UNKNOWN_UUID, UNKNOWN_UUID))
      .expect(404);

    expect(response.body).toEqual({
      detail: `Document ${UNKNOWN_UUID} not found in Stack ${UNKNOWN_UUID}`,
    });
  });

  it("answers 404 when the document belongs to a different stack", async () => {
    // The lookup is scoped by `stack_id`, so a real document under the wrong
    // stack is a 404 carrying both ids, not a 500 or a cross-stack ingest.
    const stackA = await createStack();
    const stackB = await createStack();
    const documentId = await createDocument(stackA, "Some text.");

    const response = await request(app).post(ingestUrl(stackB, documentId)).expect(404);

    expect(response.body).toEqual({
      detail: `Document ${documentId} not found in Stack ${stackB}`,
    });
  });

  it("answers 500 text when the row exists but the file is gone", async () => {
    // Measured: `Document file is missing on disk`, status 500.
    const stackId = await createStack();
    const missing = randomUUID();
    await database().execute(sql`
      insert into stack_documents (
        id, stack_id, filename, storage_path, size_bytes, source_hash
      )
      values (
        ${missing}, ${stackId}, ${"gone.txt"},
        ${`uploads/${stackId}/definitely-not-there.txt`}, ${5}, ${randomUUID()}
      )
    `);

    const response = await request(app).post(ingestUrl(stackId, missing)).expect(500);

    expect(response.body).toEqual({ detail: "Document file is missing on disk" });
  });

  it("answers 415 when the bytes are not UTF-8", async () => {
    // Python's `raw.decode("utf-8")` raises; Node's `Buffer.toString` would
    // silently substitute U+FFFD, so the route decodes with `fatal: true`.
    const stackId = await createStack();
    const documentId = await createDocument(stackId, Uint8Array.from([0xff, 0xfe, 0x00, 0x01]));

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(415);

    expect(response.body).toEqual({
      detail:
        "Document is not UTF-8 text. Binary format support " +
        "(PDF, DOCX) is planned for a later release.",
    });
  });

  it("flags truncation past MAX_EXTRACTION_CHARS without calling the gateway", async () => {
    // Measured on the oracle: a 500_001-character whitespace document answers
    // `truncated: true` with every count at zero. Whitespace produces no chunks,
    // so this pins the truncation flag at zero provider cost.
    const stackId = await createStack();
    const documentId = await createDocument(stackId, " ".repeat(500_001));

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(response.body).toEqual({
      document_id: documentId,
      chunks_created: 0,
      entities_extracted: 0,
      entities_in_stack: 0,
      relationships_extracted: 0,
      relationships_written: 0,
      relationships_in_stack: 0,
      truncated: true,
      descriptions_synthesized: false,
    });
  });

  it("does not flag truncation at exactly the limit", async () => {
    // The comparison is `len(text) > MAX_EXTRACTION_CHARS`, so exactly 500_000 is
    // not truncated. Asserted via the flag only, because no chunks are produced.
    const stackId = await createStack();
    const documentId = await createDocument(stackId, " ".repeat(500_000));

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    expect(response.body.truncated).toBe(false);
  });
});

/**
 * The one block that spends money.
 *
 * Enabled only with `AKS_TEST_GATEWAY=1`, so an ordinary `npm test` (including
 * the 420 pre-existing tests) never calls a provider. When enabled it ingests one
 * small document twice, which is the minimum needed to observe the consolidation
 * contract: `relationships_written` counts attempts and stays flat, while
 * `relationships_in_stack` reflects real row growth.
 */
describe.skipIf(state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1")(
  "ingest (live gateway)",
  () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      app = createTestApp();
    });

    afterEach(async () => {
      await deleteFixtureRows();
    });

    it("ingests a document and re-ingests it without duplicating rows", async () => {
      const stackId = await createStack();
      const documentId = await createDocument(
        stackId,
        "The gateway routes embedding traffic for the extraction pipeline. " +
          "Nomic Embed produces vectors for every chunk.\n\n" +
          "The gateway also enforces rate limits for the extraction pipeline.",
      );

      const first = await request(app).post(ingestUrl(stackId, documentId)).expect(200);
      expect(Object.keys(first.body)).toEqual([...RESPONSE_KEYS]);
      expect(first.body.document_id).toBe(documentId);
      expect(first.body.truncated).toBe(false);
      expect(first.body.descriptions_synthesized).toBe(false);
      // At least one chunk was embedded and stored.
      expect(first.body.chunks_created).toBeGreaterThanOrEqual(1);

      const second = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

      // The consolidation contract: the chunk count is stable (the upsert
      // rewrites in place), and the entity total does not grow, while the
      // relationship total may grow because a second run can extract an edge the
      // first did not. `relationships_written` counts attempts, so it is
      // whatever the second run extracted.
      expect(second.body.chunks_created).toBe(first.body.chunks_created);
      expect(second.body.entities_in_stack).toBe(first.body.entities_in_stack);

      // Stored rows prove no duplication: one chunk per index, one entity per
      // name, no duplicate edges.
      const chunkRows = await database().execute<{ chunk_index: number }>(sql`
        select chunk_index from document_chunks
        where document_id = ${documentId} order by chunk_index
      `);
      expect(chunkRows.map((row) => row.chunk_index)).toEqual(
        chunkRows.map((_, index) => index),
      );

      const duplicates = await database().execute<{ n: number }>(sql`
        select count(*)::int as n from (
          select lower(name) from ontology_entities
          where stack_id = ${stackId}
          group by lower(name) having count(*) > 1
        ) as dupes
      `);
      expect(duplicates[0]?.n).toBe(0);

      const edgeDuplicates = await database().execute<{ n: number }>(sql`
        select count(*)::int as n from (
          select from_entity_id, to_entity_id, type from ontology_relationships
          where stack_id = ${stackId}
          group by from_entity_id, to_entity_id, type having count(*) > 1
        ) as dupes
      `);
      expect(edgeDuplicates[0]?.n).toBe(0);

      // Every chunk carries a 768-dimension vector and a real token count.
      const chunks = await database().execute<{ dims: number; token_count: number }>(sql`
        select vector_dims(embedding) as dims, token_count
        from document_chunks where document_id = ${documentId}
      `);
      for (const row of chunks) {
        expect(row.dims).toBe(768);
        expect(row.token_count).toBeGreaterThan(0);
      }
    }, 180_000);
  },
);
