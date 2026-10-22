/**
 * @file packages/llmwiki-kg/ts/src/routes/documents-form.test.ts
 * @description Multipart form validation and error ordering.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp, deleteFixtureRows, insertStack, skipReason, uniqueDomain, useDomainPrefix } from "./documents-harness.js";
useDomainPrefix("form");


describe.skipIf(skipReason !== false)("documents form validation (live database)", () => {
      beforeEach(deleteFixtureRows);

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
  },
);
