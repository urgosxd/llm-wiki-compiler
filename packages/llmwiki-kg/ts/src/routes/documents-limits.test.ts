/**
 * @file packages/llmwiki-kg/ts/src/routes/documents-limits.test.ts
 * @description Upload bounds and the Stack check that precedes them.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { UNKNOWN_UUID, buildApp, countFixtureDocuments, deleteFixtureRows, field, insertStack, skipReason, uniqueDomain, useDomainPrefix } from "./documents-harness.js";

import { MAX_UPLOAD_BYTES } from "../core/files.js";
useDomainPrefix("limits");

describe.skipIf(skipReason !== false)("documents upload limits (live database)", () => {
      beforeEach(deleteFixtureRows);

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
  },
);
