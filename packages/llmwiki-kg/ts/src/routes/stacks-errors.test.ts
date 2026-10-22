/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-errors.test.ts
 * @description Validation order and router-level auth.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp, deleteFixtureRows, deps, skipReason, useDomainPrefix } from "./stacks-harness.js";

import { createApp } from "../server.js";

/**
 * The measured `uuid_parsing` entry for `/stacks/not-a-uuid`.
 *
 * Shared by both assertions in the ordering test, which would otherwise repeat
 * the same six lines twice.
 */
const UUID_PATH_DETAIL = {
  type: "uuid_parsing",
  loc: ["path", "stack_id"],
  msg: "Input should be a valid UUID, invalid character: found `n` at 0",
  input: "not-a-uuid",
  ctx: { error: "invalid character: found `n` at 0" },
} as const;

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("errors");

describe.skipIf(skipReason !== false)("/stacks validation and auth (live database)", () => {

    // Start every test from a known state, and clean up even if a test failed
    // before its own assertions ran.
    beforeEach(deleteFixtureRows);

    it("rejects a non-UUID path parameter with a 422 on the path location", async () => {
      const app = buildApp();

      // A valid body on PATCH keeps the body out of the error list, so the path
      // entry is the only one asserted here. (With no body at all the oracle also
      // reports `missing` on `["body"]`; that combination is pinned separately.)
      const requests = [
        request(app).get("/stacks/not-a-uuid"),
        request(app).patch("/stacks/not-a-uuid").send({ name: "Nope" }),
        request(app).delete("/stacks/not-a-uuid"),
      ];

      for (const pending of requests) {
        const response = await pending;
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
          ],
        });
      }
    });

    it("reports path and body errors together, path first", async () => {
      const app = buildApp();

      // Measured on the oracle: `PATCH /stacks/not-a-uuid` with `{"name": ""}`
      // answers 422 with the path entry followed by the body entry.
      const both = await request(app)
        .patch("/stacks/not-a-uuid")
        .send({ name: "" });
      expect(both.status).toBe(422);
      expect(both.body).toEqual({
        detail: [UUID_PATH_DETAIL, {
          type: "string_too_short",
          loc: ["body", "name"],
          msg: "String should have at least 1 character",
          input: "",
          ctx: { min_length: 1 },
        }],
      });

      // And a PATCH with no body at all reports `missing` for the body, next to
      // the path failure.
      const noBody = await request(app).patch("/stacks/not-a-uuid");
      expect(noBody.status).toBe(422);
      expect(noBody.body).toEqual({
        detail: [UUID_PATH_DETAIL, { type: "missing", loc: ["body"], msg: "Field required", input: null }],
      });
    });

    it("requires the API key on the router while /health stays open", async () => {
      // The real `createApp`, with the router's dependencies pointed at this
      // suite's pool so the registration itself is what gets exercised.
      const app = createApp(deps());

      // `/health` is still served by the app, and `/stacks` reaches the router
      // (auth disabled for these deps, so 200).
      const health = await request(app).get("/health");
      expect(health.status).toBe(200);
      const openList = await request(app).get("/stacks");
      expect(openList.status).toBe(200);

      // With a key configured, the router — not the app — rejects the request.
      const guarded = buildApp("secret-key");
      const unauthenticated = await request(guarded).get("/stacks");
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body).toEqual({
        detail: "Invalid or missing API key. Provide it in the X-API-Key header.",
      });

      const authenticated = await request(guarded)
        .get("/stacks")
        .set("X-API-Key", "secret-key");
      expect(authenticated.status).toBe(200);
    });
  },
);
