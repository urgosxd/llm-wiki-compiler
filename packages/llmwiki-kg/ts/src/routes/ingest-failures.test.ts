/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-failures.test.ts
 * @description Missing files and non-UTF-8 content.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import { createDocument, createStack, createTestApp, database, deleteFixtureRows, ingestUrl, skipReason, useDomainPrefix } from "./ingest-harness.js";
import { withFixtureTenant } from "./fixture-tenant.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("failures");

describe.skipIf(skipReason !== false)("ingest file failures (no gateway)", () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      app = createTestApp();
    });

    afterEach(async () => {
      await deleteFixtureRows();
    });

    it("answers 500 text when the row exists but the file is gone", async () => {
      // Measured: `Document file is missing on disk`, status 500.
      const stackId = await createStack();
      const missing = randomUUID();
      await withFixtureTenant(database(), { stackId }, (tx) => tx.execute(sql`
        insert into stack_documents (
          id, stack_id, filename, storage_path, size_bytes, source_hash
        )
        values (
          ${missing}, ${stackId}, ${"gone.txt"},
          ${`uploads/${stackId}/definitely-not-there.txt`}, ${5}, ${randomUUID()}
        )
      `));

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
  },
);
