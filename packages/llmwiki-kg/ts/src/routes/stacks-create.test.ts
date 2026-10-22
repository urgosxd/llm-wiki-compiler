/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-create.test.ts
 * @description `POST /stacks`: creation, duplicates and validation.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { RESPONSE_KEYS, buildApp, countFixtureRows, createBody, currentDomainPrefix, deleteFixtureRows, expectOracleTimestamp, skipReason, useDomainPrefix } from "./stacks-harness.js";



import { toFastApiValidationError } from "../errors.js";
import { StackCreate } from "../dto.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("create");


describe.skipIf(skipReason !== false)("/stacks create (live database)", () => {
    let sequence = 0;

    /** Unique domain per call, carrying the cleanup prefix. */
    function uniqueDomain(label: string): string {
      sequence += 1;
      return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
    }

    // Start every test from a known state, and clean up even if a test failed
    // before its own assertions ran.
    beforeEach(deleteFixtureRows);

    it("POST /stacks creates a row and answers 201 with the oracle field set and order", async () => {
      const app = buildApp();
      const payloadDomain = uniqueDomain("create");

      const response = await request(app)
        .post("/stacks")
        .send(createBody(payloadDomain));

      expect(response.status).toBe(201);

      // Key order is contractual, and it is visible in the raw JSON text.
      expect(Object.keys(response.body)).toEqual([...RESPONSE_KEYS]);

      expect(response.body).toMatchObject({
        name: "T0.7 Stack",
        domain: payloadDomain,
        description: null,
        scope: "stack",
        compilation_strategy: "incremental",
        synthesize_descriptions: false,
      });
      expect(response.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expectOracleTimestamp(response.body.created_at);
      expectOracleTimestamp(response.body.updated_at);
      // A fresh row has not been updated yet.
      expect(response.body.updated_at).toBe(response.body.created_at);
    });

    it("POST /stacks accepts optional fields and unknown keys", async () => {
      const app = buildApp();

      // Measured on the oracle: `{"name":" ","domain":"ok4"}` is a 201 because
      // `min_length=1` counts the whitespace, and an unknown `bogus` key is
      // stripped rather than rejected.
      const whitespace = await request(app)
        .post("/stacks")
        .send({ name: " ", domain: uniqueDomain("ws") });
      expect(whitespace.status).toBe(201);
      expect(whitespace.body.name).toBe(" ");

      const withUnknown = await request(app)
        .post("/stacks")
        .send({
          ...createBody(uniqueDomain("unknown"), {
            description: "described",
            scope: "domain",
            synthesize_descriptions: true,
          }),
          bogus: "ignored",
        });
      expect(withUnknown.status).toBe(201);
      expect(withUnknown.body).toMatchObject({
        description: "described",
        scope: "domain",
        synthesize_descriptions: true,
      });
      expect(withUnknown.body).not.toHaveProperty("bogus");
    });

    it("POST /stacks returns 409 with the oracle detail for a duplicate domain", async () => {
      const app = buildApp();
      const payloadDomain = uniqueDomain("dup");

      const first = await request(app)
        .post("/stacks")
        .send(createBody(payloadDomain));
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/stacks")
        .send(createBody(payloadDomain, { name: "Sibling" }));

      expect(second.status).toBe(409);
      expect(second.body).toEqual({
        detail: `Stack with domain '${payloadDomain}' already exists`,
      });
      // The app-level pre-check must not have written a second row.
      expect(await countFixtureRows()).toBe(1);
    });

    it("POST /stacks returns 422 identical to toFastApiValidationError", async () => {
      const app = buildApp();
      const body = { name: "" };

      const response = await request(app).post("/stacks").send(body);

      expect(response.status).toBe(422);

      // Build the expected body with the same mapper the route uses, from the same
      // raw input, so the assertion pins the exact type/loc/msg/input/ctx shape.
      const parsed = StackCreate.safeParse(body);
      expect(parsed.success).toBe(false);
      if (parsed.success) {
        throw new Error("expected the payload to fail validation");
      }
      const expected = toFastApiValidationError(parsed.error, "body", body);

      expect(response.body).toEqual(expected.body);
      expect(response.body.detail).toEqual([
        {
          type: "string_too_short",
          loc: ["body", "name"],
          msg: "String should have at least 1 character",
          input: "",
          ctx: { min_length: 1 },
        },
        {
          type: "missing",
          loc: ["body", "domain"],
          msg: "Field required",
          input: { name: "" },
        },
      ]);
    });
  },
);
