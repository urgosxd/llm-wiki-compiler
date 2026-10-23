/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-contract.test.ts
 * @description Response envelope, validation order and 404 handling.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { RESPONSE_KEYS, useDomainPrefix } from "./ingest-harness.js";

import type { Express } from "express";
import { UNKNOWN_UUID, createDocument, createStack, createTestApp, deleteFixtureRows, ingestUrl, skipReason } from "./ingest-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("contract");

describe.skipIf(skipReason !== false)("ingest request handling (no gateway)", () => {
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
  },
);
