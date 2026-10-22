/**
 * @file packages/llmwiki-kg/ts/src/routes/documents-errors.test.ts
 * @description Path-parameter validation and router-level auth.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { UNKNOWN_UUID, buildApp, deleteFixtureRows, insertStack, skipReason, uniqueDomain, useDomainPrefix } from "./documents-harness.js";
useDomainPrefix("errors");


describe.skipIf(skipReason !== false)("documents validation and auth (live database)", () => {
      beforeEach(deleteFixtureRows);

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
