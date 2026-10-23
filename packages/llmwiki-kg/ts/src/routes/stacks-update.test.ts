/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-update.test.ts
 * @description `PATCH /stacks/:stack_id` and its `exclude_unset` semantics.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp, createBody, currentDomainPrefix, deleteFixtureRows, expectOracleTimestamp, skipReason, tick, useDomainPrefix } from "./stacks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("update");





describe.skipIf(skipReason !== false)("/stacks update (live database)", () => {
    let sequence = 0;

    /** Unique domain per call, carrying the cleanup prefix. */
    function uniqueDomain(label: string): string {
      sequence += 1;
      return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
    }

    // Start every test from a known state, and clean up even if a test failed
    // before its own assertions ran.
    beforeEach(deleteFixtureRows);

    it("PATCH /stacks/:stack_id updates only the fields present in the body", async () => {
      const app = buildApp();
      const payloadDomain = uniqueDomain("patch");
      const created = await request(app)
        .post("/stacks")
        .send(createBody(payloadDomain, { description: "before" }));
      expect(created.status).toBe(201);

      await tick();
      // `description` is the only key present: `name` must be left untouched even
      // though `StackUpdate` defaults it to null.
      const patched = await request(app)
        .patch(`/stacks/${String(created.body.id)}`)
        .send({ description: "after" });

      expect(patched.status).toBe(200);
      expect(patched.body.description).toBe("after");
      expect(patched.body.name).toBe(created.body.name);
      expect(patched.body.domain).toBe(payloadDomain);
      expect(patched.body.created_at).toBe(created.body.created_at);
      // `updated_at = now()` is appended to the SET clause by the handler.
      expect(patched.body.updated_at).not.toBe(created.body.updated_at);
      expectOracleTimestamp(patched.body.updated_at);
    });

    it("PATCH /stacks/:stack_id distinguishes an absent key from an explicit null", async () => {
      const app = buildApp();
      const created = await request(app)
        .post("/stacks")
        .send(createBody(uniqueDomain("null"), { description: "present" }));
      expect(created.status).toBe(201);
      const id = String(created.body.id);

      // Absent key: untouched.
      const untouched = await request(app)
        .patch(`/stacks/${id}`)
        .send({ synthesize_descriptions: true });
      expect(untouched.status).toBe(200);
      expect(untouched.body.description).toBe("present");

      // Explicit null: writes NULL.
      const nulled = await request(app).patch(`/stacks/${id}`).send({ description: null });
      expect(nulled.status).toBe(200);
      expect(nulled.body.description).toBeNull();
    });

    it("PATCH /stacks/:stack_id rejects an empty body with 400, not 422", async () => {
      const app = buildApp();
      const created = await request(app)
        .post("/stacks")
        .send(createBody(uniqueDomain("empty")));
      expect(created.status).toBe(201);

      const response = await request(app)
        .patch(`/stacks/${String(created.body.id)}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ detail: "At least one field must be provided" });
    });

    it("PATCH /stacks/:stack_id returns 404 for an unknown id", async () => {
      const app = buildApp();
      const missingId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

      const response = await request(app)
        .patch(`/stacks/${missingId}`)
        .send({ name: "Nope" });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ detail: `Stack ${missingId} not found` });
    });
  },
);
