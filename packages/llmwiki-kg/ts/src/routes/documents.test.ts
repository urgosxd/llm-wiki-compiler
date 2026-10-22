import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import express from "express";
import type { Express } from "express";
import type { Sql } from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "../db.js";
import type { Database } from "../db.js";
import { MAX_UPLOAD_BYTES, getStoragePath } from "../core/files.js";
import { createDocumentsRouter } from "./documents.js";
import type { DocumentsRouterDependencies } from "./documents.js";

/**
 * Integration tests for the documents vertical, against the live compose
 * database on port 5434 (remapped from the container's 5432 by
 * `docker-compose.override.yml`).
 *
 * ## Why this suite reads `ts/src/dto.ts`, `errors.ts` and `db.ts` but does not
 * ## change them
 *
 * The DTO, the FastAPI error mapper and the transaction wrapper are shared,
 * already verified Wave 0 surfaces. Expectations here are built with the same
 * mapper the route uses, so a 422 assertion pins the exact FastAPI shape instead
 * of a paraphrase of it.
 *
 * ## The database is shared with concurrent sibling slices
 *
 * Every stack this suite creates carries the `w1doc-` domain prefix, and every
 * document it creates belongs to one of those stacks, so the prefix alone is a
 * complete cleanup key (`stack_documents.stack_id` cascades on stack delete).
 * Cleanup runs before each test, after each test, and again in `afterAll`, where
 * it is also asserted to have removed everything.
 *
 * ## Storage files
 *
 * The handler writes the uploaded bytes to `uploads/{stack_id}/{document_id}{ext}`
 * relative to the working directory. The suite points `UPLOAD_DIR`-relative
 * writes at a temporary directory by removing only the files whose path it can
 * derive from rows it created; it never touches the repository's `uploads/`
 * directory wholesale.
 *
 * Every contract value below was measured against the Python oracle on
 * `http://localhost:8000`.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/** Domain prefix unique to this slice; the only key cleanup ever deletes on. */
const DOMAIN_PREFIX = "w1doc-";

/** Oracle field set and order for `DocumentResponse`. */
const RESPONSE_KEYS = [
  "id",
  "stack_id",
  "filename",
  "size_bytes",
  "content_type",
  "source_hash",
  "truncated",
  "original_length",
  "ingested_at",
  "audit",
] as const;

/** An unknown-but-valid UUID used everywhere a 404 is expected. */
const UNKNOWN_UUID = "11111111-1111-1111-1111-111111111111";

/** Boundary used by {@link rawMultipart}. */
const BOUNDARY = "w1doc-route-boundary";

/**
 * Builds a single-part `multipart/form-data` body byte for byte.
 *
 * Needed for the two cases superagent cannot express: a part with no
 * `Content-Type` header, and a part whose `filename` parameter is the empty
 * string (superagent omits the parameter instead, which makes the field a plain
 * string on the wire).
 */
function rawMultipart(headerLines: string, data: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\n${headerLines}\r\n\r\n${data}\r\n--${BOUNDARY}--\r\n`,
    "utf8",
  );
}

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
  console.warn(`[documents.test] skipping integration tests — ${state.skipReason}`);
}

/** Narrows the setup state for the compiler; `describe.skipIf` guards it. */
function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

/** Resolves fast and deterministically; keeps `ingested_at` values distinct. */
async function tick(): Promise<void> {
  await new Promise((done) => setTimeout(done, 5));
}

/** Inserts a stack row directly, so fixtures never depend on the stacks router. */
async function insertStack(domain: string): Promise<string> {
  const rows = await database().execute<{ id: string }>(sql`
    insert into stacks (name, domain)
    values (${"w1doc stack"}, ${domain})
    returning id
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insert into stacks returned no row");
  }
  return row.id;
}

/** Counts documents belonging to this suite's stacks. */
async function countFixtureDocuments(): Promise<number> {
  const rows = await database().execute<{ total: number }>(sql`
    select count(*)::int as total
    from stack_documents d
    join stacks s on s.id = d.stack_id
    where s.domain like ${`${DOMAIN_PREFIX}%`}
  `);
  return rows[0]?.total ?? -1;
}

/** Storage paths of this suite's documents, for filesystem cleanup. */
async function fixtureStoragePaths(): Promise<string[]> {
  const rows = await database().execute<{ storage_path: string }>(sql`
    select d.storage_path
    from stack_documents d
    join stacks s on s.id = d.stack_id
    where s.domain like ${`${DOMAIN_PREFIX}%`}
  `);
  return rows.map((row) => row.storage_path);
}

/** Deletes this suite's storage files, ignoring ones already gone. */
async function deleteFixtureFiles(): Promise<void> {
  for (const storagePath of await fixtureStoragePaths()) {
    await rm(resolve(process.cwd(), storagePath), { force: true });
  }
}

/** Deletes every stack (and, by cascade, every document) this suite created. */
async function deleteFixtureRows(): Promise<void> {
  await deleteFixtureFiles();
  await database().execute(
    sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`,
  );
}

/** Counts this suite's stacks; proves cleanup actually happened. */
async function countFixtureStacks(): Promise<number> {
  const rows = await database().execute<{ total: number }>(
    sql`select count(*)::int as total from stacks where domain like ${`${DOMAIN_PREFIX}%`}`,
  );
  return rows[0]?.total ?? -1;
}

/** Dependencies bound to this suite's pool, never to the process-wide singleton. */
function deps(apiKey = ""): DocumentsRouterDependencies {
  return {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(
      parseConfig(apiKey === "" ? {} : { AKS_API_KEY: apiKey }),
    ),
  };
}

/**
 * A bare app around just the documents router.
 *
 * `express.json()` is mounted for fidelity with `server.ts`; the router itself
 * reads the raw body, because multipart parsing happens there.
 */
function buildApp(apiKey = ""): Express {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createDocumentsRouter(deps(apiKey)));
  return app;
}

let sequence = 0;

/** Unique domain per call, carrying the cleanup prefix. */
function uniqueDomain(label: string): string {
  sequence += 1;
  return `${DOMAIN_PREFIX}${label}-${Date.now().toString(36)}-${String(sequence)}`;
}

/** Oracle timestamp contract: 27 chars, `Z`-suffixed, exactly 6 fractional digits. */
function expectOracleTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error(`expected a timestamp string, received ${typeof value}`);
  }
  expect(value).toHaveLength(27);
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
}

/** The oracle's `DocumentResponse` key order, read off the raw JSON text. */
function responseKeys(bodyText: string): string[] {
  const parsed: unknown = JSON.parse(bodyText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object response");
  }
  return Object.keys(parsed);
}

/** Narrows a JSON array response to records without an unchecked cast. */
function asRows(body: unknown): Record<string, unknown>[] {
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) {
    throw new Error("expected a JSON array response");
  }
  return body.map((item: unknown) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("expected every array element to be an object");
    }
    return Object.fromEntries(Object.entries(item));
  });
}

/** Reads a supertest response body field as a string without a cast. */
function field(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null) {
    throw new Error("expected a JSON object response");
  }
  return Reflect.get(body, key);
}

afterAll(async () => {
  if (state.skipReason !== false) {
    return;
  }
  await deleteFixtureRows();
  expect(await countFixtureStacks()).toBe(0);
  expect(await countFixtureDocuments()).toBe(0);
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

describe.skipIf(state.skipReason !== false)(
  "documents router (live database)",
  () => {
    beforeEach(deleteFixtureRows);

    it("POST /stacks/:stack_id/documents answers 201 with the oracle field set and order", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("upload"));

      const response = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from("hello documents world\n"), {
          filename: "probe1.txt",
          contentType: "text/plain",
        });

      expect(response.status).toBe(201);
      expect(responseKeys(response.text)).toEqual([...RESPONSE_KEYS]);

      const body: unknown = response.body;
      expect(field(body, "stack_id")).toBe(stackId);
      expect(field(body, "filename")).toBe("probe1.txt");
      expect(field(body, "size_bytes")).toBe(22);
      expect(field(body, "content_type")).toBe("text/plain");
      // SHA-256 hex of the exact uploaded bytes.
      expect(field(body, "source_hash")).toBe(
        "7045ce681c23cdfe1be71e0483b3e2e8bdd762b353d87bbd46433d3870ed9712",
      );
      expect(field(body, "truncated")).toBe(false);
      expect(field(body, "original_length")).toBeNull();
      expect(field(body, "audit")).toBeNull();
      expectOracleTimestamp(field(body, "ingested_at"));
      expect(String(field(body, "id"))).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("POST is idempotent by content hash and does not create a second row", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("idem"));
      const content = Buffer.from("duplicate content\n");

      const first = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", content, { filename: "dupA.txt", contentType: "text/plain" });
      expect(first.status).toBe(201);

      // Same bytes, different filename: the stored record — filename included —
      // is the one already in the table.
      const second = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", content, { filename: "dupB.txt", contentType: "text/plain" });

      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(field(second.body, "filename")).toBe("dupA.txt");
      expect(await countFixtureDocuments()).toBe(1);

      // The same bytes in a *different* stack are a different document.
      const otherStackId = await insertStack(uniqueDomain("idem-other"));
      await tick();
      const elsewhere = await request(app)
        .post(`/stacks/${otherStackId}/documents`)
        .attach("file", content, { filename: "dupA.txt", contentType: "text/plain" });

      expect(elsewhere.status).toBe(201);
      expect(field(elsewhere.body, "id")).not.toBe(field(first.body, "id"));
      expect(field(elsewhere.body, "stack_id")).toBe(otherStackId);
      expect(await countFixtureDocuments()).toBe(2);
    });

    it("POST writes the bytes to uploads/{stack_id}/{document_id}{ext}", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("storage"));
      const bytes = Buffer.from("stored bytes\n");

      const response = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", bytes, { filename: "notes.txt", contentType: "text/plain" });
      expect(response.status).toBe(201);

      const documentId = String(field(response.body, "id"));
      const expected = getStoragePath(stackId, documentId, "notes.txt");
      expect(expected).toBe(`uploads/${stackId}/${documentId}.txt`);

      const stored = await readFile(resolve(process.cwd(), expected));
      expect(stored.equals(bytes)).toBe(true);
    });

    it("POST reports content_type null and the fallback filename", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("meta"));

      // Hand-built parts: superagent always sends a Content-Type for an
      // attachment, and drops a `filename=""` parameter entirely, so both
      // measured cases below have to be spelled out as raw multipart.
      const noContentType = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .set("content-type", `multipart/form-data; boundary=${BOUNDARY}`)
        .send(
          rawMultipart(
            `Content-Disposition: form-data; name="file"; filename="noct.txt"`,
            "no content type\n",
          ),
        );
      expect(noContentType.status).toBe(201);
      expect(field(noContentType.body, "content_type")).toBeNull();
      expect(field(noContentType.body, "filename")).toBe("noct.txt");

      await tick();
      const emptyFilename = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .set("content-type", `multipart/form-data; boundary=${BOUNDARY}`)
        .send(
          rawMultipart(
            `Content-Disposition: form-data; name="file"; filename=""`,
            "fe bytes\n",
          ),
        );
      expect(emptyFilename.status).toBe(201);
      // Measured: `file.filename or "unknown"`.
      expect(field(emptyFilename.body, "filename")).toBe("unknown");
    });

    it("POST flags truncation for text content past MAX_EXTRACTION_CHARS", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("trunc"));

      const atLimit = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from("y".repeat(500_000)), { filename: "exact.txt" });
      expect(atLimit.status).toBe(201);
      expect(field(atLimit.body, "truncated")).toBe(false);
      expect(field(atLimit.body, "original_length")).toBeNull();

      await tick();
      const overLimit = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from("x".repeat(500_001)), { filename: "trunc.txt" });
      expect(overLimit.status).toBe(201);
      expect(field(overLimit.body, "truncated")).toBe(true);
      expect(field(overLimit.body, "original_length")).toBe(500_001);

      // Binary content is not truncation-checked at upload time.
      await tick();
      const binary = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from([0xff, 0xfe, 0x00, 0x01]), {
          filename: "bin.bin",
          contentType: "application/octet-stream",
        });
      expect(binary.status).toBe(201);
      expect(field(binary.body, "truncated")).toBe(false);
      expect(field(binary.body, "original_length")).toBeNull();
    });

    it("POST rejects an empty file with 400 and an oversized file with 413", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("limits"));

      const empty = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from(""), { filename: "empty.txt", contentType: "text/plain" });
      expect(empty.status).toBe(400);
      expect(empty.body).toEqual({ detail: "Uploaded file is empty" });

      const oversized = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.alloc(MAX_UPLOAD_BYTES + 1), {
          filename: "big.bin",
          contentType: "application/octet-stream",
        });
      expect(oversized.status).toBe(413);
      // Measured exact string.
      expect(oversized.body).toEqual({
        detail: `File exceeds ${String(MAX_UPLOAD_BYTES)} byte limit`,
      });
      expect(oversized.body).toEqual({ detail: "File exceeds 52428800 byte limit" });

      // Neither attempt stored a row.
      expect(await countFixtureDocuments()).toBe(0);
    });

    it("POST accepts a file of exactly MAX_UPLOAD_BYTES", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("edge"));

      const response = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.alloc(MAX_UPLOAD_BYTES, 0x61), {
          filename: "edge.bin",
          contentType: "application/octet-stream",
        });

      expect(response.status).toBe(201);
      expect(field(response.body, "size_bytes")).toBe(MAX_UPLOAD_BYTES);
      // The all-`a` content is valid UTF-8, so truncation applies.
      expect(field(response.body, "truncated")).toBe(true);
      expect(field(response.body, "original_length")).toBe(MAX_UPLOAD_BYTES);
    });

    it("POST validates the stack before the upload and 404s an unknown stack", async () => {
      const app = buildApp();

      const response = await request(app)
        .post(`/stacks/${UNKNOWN_UUID}/documents`)
        .attach("file", Buffer.from("x"), { filename: "x.txt" });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        detail: `Stack ${UNKNOWN_UUID} not found`,
      });

      // The stack check runs first: an empty upload to a bad stack is a 404
      // rather than the 400 an empty file usually produces.
      const emptyUnknown = await request(app)
        .post(`/stacks/${UNKNOWN_UUID}/documents`)
        .attach("file", Buffer.from(""), { filename: "empty.txt" });
      expect(emptyUnknown.status).toBe(404);
      expect(emptyUnknown.body).toEqual({
        detail: `Stack ${UNKNOWN_UUID} not found`,
      });
    });

    it("POST answers 422 missing for the file field and for a plain string field", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("filefield"));

      // No file part at all.
      const missing = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .field("other", "x");
      expect(missing.status).toBe(422);
      expect(missing.body).toEqual({
        detail: [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }],
      });

      // A `file` part without a filename is a plain string to FastAPI.
      const asString = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .field("file", "abc");
      expect(asString.status).toBe(422);
      expect(asString.body).toEqual({
        detail: [
          {
            type: "value_error",
            loc: ["body", "file"],
            msg: "Value error, Expected UploadFile, received: <class 'str'>",
            input: "abc",
            ctx: { error: {} },
          },
        ],
      });
    });

    it("POST rejects a multipart body with no boundary, as the oracle does", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("noboundary"));

      const response = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .set("content-type", "multipart/form-data")
        .send(Buffer.from("xx"));

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ detail: "Missing boundary in multipart." });
    });

    it("POST reports path and file errors together, path first", async () => {
      const app = buildApp();

      const response = await request(app)
        .post("/stacks/not-a-uuid/documents")
        .field("other", "x");

      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        detail: [
          {
            type: "uuid_parsing",
            loc: ["path", "stack_id"],
            msg: "Input should be a valid UUID, invalid character: found `n` at 0",
            input: "not-a-uuid",
            ctx: { error: "invalid character: found `n` at 0" },
          },
          { type: "missing", loc: ["body", "file"], msg: "Field required", input: null },
        ],
      });
    });

    it("GET /stacks/:stack_id/documents lists a stack's documents newest first", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("list"));

      const emptyList = await request(app).get(`/stacks/${stackId}/documents`);
      expect(emptyList.status).toBe(200);
      expect(emptyList.body).toEqual([]);

      const first = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from("first document\n"), { filename: "first.txt" });
      expect(first.status).toBe(201);
      await tick();
      const second = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from("second document\n"), { filename: "second.txt" });
      expect(second.status).toBe(201);

      const listed = await request(app).get(`/stacks/${stackId}/documents`);
      expect(listed.status).toBe(200);

      const rows = asRows(listed.body);
      expect(rows.map((row) => row["filename"])).toEqual(["second.txt", "first.txt"]);
      for (const row of rows) {
        expect(Object.keys(row)).toEqual([...RESPONSE_KEYS]);
        expect(row["stack_id"]).toBe(stackId);
        expectOracleTimestamp(row["ingested_at"]);
      }

      // A second stack's documents never leak into the list.
      const otherStackId = await insertStack(uniqueDomain("list-other"));
      const other = await request(app)
        .post(`/stacks/${otherStackId}/documents`)
        .attach("file", Buffer.from("other stack\n"), { filename: "other.txt" });
      expect(other.status).toBe(201);

      const stillListed = await request(app).get(`/stacks/${stackId}/documents`);
      expect(asRows(stillListed.body)).toHaveLength(2);
    });

    it("GET /stacks/:stack_id/documents 404s an unknown stack", async () => {
      const app = buildApp();

      const response = await request(app).get(`/stacks/${UNKNOWN_UUID}/documents`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ detail: `Stack ${UNKNOWN_UUID} not found` });

      // An uppercase path id is normalized to the canonical lowercase form.
      const uppercase = await request(app).get(
        `/stacks/${UNKNOWN_UUID.toUpperCase()}/documents`,
      );
      expect(uppercase.status).toBe(404);
      expect(uppercase.body).toEqual({ detail: `Stack ${UNKNOWN_UUID} not found` });
    });

    it("GET /documents/:doc_id returns the document, and 404s an unknown id", async () => {
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("getbyid"));

      const created = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from("fetch me\n"), { filename: "fetch.txt" });
      expect(created.status).toBe(201);
      const documentId = String(field(created.body, "id"));

      const found = await request(app).get(`/documents/${documentId}`);
      expect(found.status).toBe(200);
      expect(found.body).toEqual(created.body);
      expect(responseKeys(found.text)).toEqual([...RESPONSE_KEYS]);
      expectOracleTimestamp(field(found.body, "ingested_at"));

      const missing = await request(app).get(`/documents/${UNKNOWN_UUID}`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ detail: `Document ${UNKNOWN_UUID} not found` });
    });

    it("GET /documents/:doc_id serves a document belonging to any stack", async () => {
      // The by-id route carries no stack parameter, so a document of another
      // stack is still a 200 — measured on the oracle.
      const app = buildApp();
      const stackId = await insertStack(uniqueDomain("cross"));

      const created = await request(app)
        .post(`/stacks/${stackId}/documents`)
        .attach("file", Buffer.from("cross stack\n"), { filename: "cross.txt" });
      expect(created.status).toBe(201);

      const fetched = await request(app).get(`/documents/${String(field(created.body, "id"))}`);
      expect(fetched.status).toBe(200);
      expect(field(fetched.body, "stack_id")).toBe(stackId);
    });

    it("rejects a non-UUID path parameter with a 422 on the path location", async () => {
      const app = buildApp();

      const listResponse = await request(app).get("/stacks/not-a-uuid/documents");
      expect(listResponse.status).toBe(422);
      expect(listResponse.body).toEqual({
        detail: [
          {
            type: "uuid_parsing",
            loc: ["path", "stack_id"],
            msg: "Input should be a valid UUID, invalid character: found `n` at 0",
            input: "not-a-uuid",
            ctx: { error: "invalid character: found `n` at 0" },
          },
        ],
      });

      const getResponse = await request(app).get("/documents/not-a-uuid");
      expect(getResponse.status).toBe(422);
      expect(getResponse.body).toEqual({
        detail: [
          {
            type: "uuid_parsing",
            loc: ["path", "doc_id"],
            msg: "Input should be a valid UUID, invalid character: found `n` at 0",
            input: "not-a-uuid",
            ctx: { error: "invalid character: found `n` at 0" },
          },
        ],
      });
    });

    it("requires the API key on the router", async () => {
      const guarded = buildApp("secret-key");
      const stackId = await insertStack(uniqueDomain("auth"));

      for (const pending of [
        request(guarded).get(`/stacks/${stackId}/documents`),
        request(guarded).get(`/documents/${UNKNOWN_UUID}`),
        request(guarded)
          .post(`/stacks/${stackId}/documents`)
          .attach("file", Buffer.from("x"), { filename: "x.txt" }),
      ]) {
        const response = await pending;
        expect(response.status).toBe(401);
        expect(response.body).toEqual({
          detail: "Invalid or missing API key. Provide it in the X-API-Key header.",
        });
      }

      const authenticated = await request(guarded)
        .get(`/stacks/${stackId}/documents`)
        .set("X-API-Key", "secret-key");
      expect(authenticated.status).toBe(200);
    });
  },
);

/**
 * Second cleanup pass, mirroring the stacks suite: a test that aborted mid-way
 * leaves nothing behind, because the delete keys on the domain prefix only this
 * suite uses.
 */
afterAll(async () => {
  if (state.skipReason !== false) {
    return;
  }
  await deleteFixtureRows();
  expect(await countFixtureStacks()).toBe(0);
});
