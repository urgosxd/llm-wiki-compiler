/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-update.test.ts
 * @description `PATCH /stacks/:stackId` and its `exclude_unset` semantics.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { buildApp, createBody, deleteFixtureRows, expectOracleTimestamp, skipReason, tick, uniqueDomain, useDomainPrefix } from "./stacks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("update");





describe.skipIf(skipReason !== false)("/stacks update (live database)", () => {
    // Start every test from a known state, and clean up even if a test failed
    // before its own assertions ran.
    beforeEach(deleteFixtureRows);

    it("PATCH /stacks/:stackId updates only the fields present in the body", async () => {
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

    it("PATCH /stacks/:stackId distinguishes an absent key from an explicit null", async () => {
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

    it("PATCH /stacks/:stackId rejects an empty body with 400, not 422", async () => {
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

    it("PATCH /stacks/:stackId touches `active` only when the body names it", async () => {
      const app = buildApp();
      const created = await request(app)
        .post("/stacks")
        .send(createBody(uniqueDomain("active")));
      expect(created.status).toBe(201);
      const id = String(created.body.id);
      expect(created.body.active).toBe(true);

      // `exclude_unset` applied to the new field: an update that does not mention it
      // must not silently retire the Stack, and must not rewrite the column either.
      const untouched = await request(app)
        .patch(`/stacks/${id}`)
        .send({ description: "still usable" });
      expect(untouched.status).toBe(200);
      expect(untouched.body.active).toBe(true);

      // The column is `not null`, so `null` is not a state it can hold: the refusal is
      // a 422 on the field, not a 500 from the constraint.
      const nulled = await request(app).patch(`/stacks/${id}`).send({ active: null });
      expect(nulled.status).toBe(422);
      expect(nulled.body.detail).toHaveLength(1);
      expect(nulled.body.detail[0]).toMatchObject({ loc: ["body", "active"] });

      const uncoerced = await request(app)
        .patch(`/stacks/${id}`)
        .send({ active: "yes-please" });
      expect(uncoerced.status).toBe(422);
      expect(uncoerced.body.detail[0]).toMatchObject({
        type: "bool_parsing",
        loc: ["body", "active"],
      });

      // Neither refusal wrote anything.
      const read = await request(app).get(`/stacks/${id}`);
      expect(read.body.active).toBe(true);
      expect(read.body.description).toBe("still usable");
    });

    it("PATCH /stacks/:stackId returns 404 for an unknown id", async () => {
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
