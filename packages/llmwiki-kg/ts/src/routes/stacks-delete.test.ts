/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-delete.test.ts
 * @description `DELETE /stacks/:stack_id`.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp, createBody, currentDomainPrefix, deleteFixtureRows, skipReason, useDomainPrefix } from "./stacks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("delete");





describe.skipIf(skipReason !== false)("/stacks delete (live database)", () => {
    let sequence = 0;

    /** Unique domain per call, carrying the cleanup prefix. */
    function uniqueDomain(label: string): string {
      sequence += 1;
      return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
    }

    // Start every test from a known state, and clean up even if a test failed
    // before its own assertions ran.
    beforeEach(deleteFixtureRows);

    it("DELETE /stacks/:stack_id returns 204 with a truly empty body, then 404", async () => {
      const app = buildApp();
      const created = await request(app)
        .post("/stacks")
        .send(createBody(uniqueDomain("delete")));
      expect(created.status).toBe(201);
      const id = String(created.body.id);

      const deleted = await request(app).delete(`/stacks/${id}`);
      expect(deleted.status).toBe(204);
      // Not `{}` and not `null`: FastAPI's 204 has no body at all.
      expect(deleted.text).toBe("");
      expect(deleted.body).toEqual({});

      // The row is gone, so the second delete is a 404.
      const again = await request(app).delete(`/stacks/${id}`);
      expect(again.status).toBe(404);
      expect(again.body).toEqual({ detail: `Stack ${id} not found` });
    });
  },
);
