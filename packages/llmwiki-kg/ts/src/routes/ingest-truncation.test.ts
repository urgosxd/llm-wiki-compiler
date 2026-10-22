/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-truncation.test.ts
 * @description Truncation detection at and beyond the extraction limit.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { createDocument, createStack, createTestApp, deleteFixtureRows, ingestUrl, skipReason, useDomainPrefix } from "./ingest-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("truncation");

describe.skipIf(skipReason !== false)("ingest truncation (no gateway)", () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      app = createTestApp();
    });

    afterEach(async () => {
      await deleteFixtureRows();
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
  },
);
