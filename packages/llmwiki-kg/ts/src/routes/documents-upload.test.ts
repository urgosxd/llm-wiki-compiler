/**
 * @file packages/llmwiki-kg/ts/src/routes/documents-upload.test.ts
 * @description `POST .../documents`: the stored record, idempotency and truncation.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { BOUNDARY, RESPONSE_KEYS, buildApp, countFixtureDocuments, deleteFixtureRows, expectOracleTimestamp, field, insertStack, rawMultipart, responseKeys, skipReason, tick, uniqueDomain, useDomainPrefix } from "./documents-harness.js";

import { getStoragePath } from "../core/files.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
useDomainPrefix("upload");

describe.skipIf(skipReason !== false)("documents upload (live database)", () => {
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
  },
);
