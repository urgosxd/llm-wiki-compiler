/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-flag-validation.test.ts
 * @description `POST /flag` body validation.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import request from "supertest";
import { asRecord, buildApp, currentDomainPrefix, database, deleteFixtureRows, skipReason, useDomainPrefix } from "./backfeed-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("flag-validation");

describe.skipIf(skipReason !== false)("backfeed flag validation (live database)", () => {
      let sequence = 0;

      let stackDomain = "";

      /** Unique domain per call, carrying the cleanup prefix. */
      function uniqueDomain(label: string): string {
        sequence += 1;
        return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
      }

      /** Creates a fixture Stack through the DB and records it for the tests. */
      async function createStack(label: string): Promise<string> {
        const domain = uniqueDomain(label);
        const rows = await database().execute<{ id: string }>(sql`
          insert into stacks (name, domain)
          values (${`Backfeed fixture ${label}`}, ${domain})
          returning id
        `);
        const row = rows[0];
        if (row === undefined) {
          throw new Error("insert into stacks returned no row");
        }
        stackDomain = domain;
        return row.id;
      }

      /** A minimal valid flag body targeting the current fixture Stack. */
      function flagBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
          domain: stackDomain,
          proposal: { entities: [{ name: "Widget", type: "PRODUCT" }] },
          ...overrides,
        };
      }

      beforeEach(async () => {
        await deleteFixtureRows();
        await createStack("case");
      });

      it("POST /flag answers 422 for an invalid origin Literal", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody({ origin: "bogus" }));

        // The Pydantic Literal catches this as a 422; the DB CHECK constraint is
        // never reached, so the oracle does not answer 500 here.
        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: [
            {
              type: "literal_error",
              loc: ["body", "origin"],
              msg: "Input should be 'run' or 'direct'",
              input: "bogus",
              ctx: { expected: "'run' or 'direct'" },
            },
          ],
        });
      });

      it("POST /flag answers 422 for an invalid trigger_type Literal", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody({ trigger_type: "bogus" }));

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: [
            {
              type: "literal_error",
              loc: ["body", "trigger_type"],
              msg: "Input should be 'manual', 'auto' or 'api'",
              input: "bogus",
              ctx: { expected: "'manual', 'auto' or 'api'" },
            },
          ],
        });
      });

      it("POST /flag enforces confidence bounds of 0 and 1", async () => {
        const app = buildApp();

        const tooHigh = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody({ proposal: { entities: [{ name: "A", type: "PRODUCT", confidence: 1.5 }] } }));
        expect(tooHigh.status).toBe(422);
        expect(tooHigh.body).toEqual({
          detail: [
            {
              type: "less_than_equal",
              loc: ["body", "proposal", "entities", 0, "confidence"],
              msg: "Input should be less than or equal to 1",
              input: 1.5,
              ctx: { le: 1.0 },
            },
          ],
        });

        const tooLow = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody({ proposal: { entities: [{ name: "A", type: "PRODUCT", confidence: -0.1 }] } }));
        expect(tooLow.status).toBe(422);

        // Both bounds are inclusive, so the endpoints are accepted.
        const atBounds = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(
            flagBody({
              proposal: {
                entities: [
                  { name: "Low", type: "PRODUCT", confidence: 0 },
                  { name: "High", type: "PRODUCT", confidence: 1 },
                ],
              },
            }),
          );
        expect(atBounds.status).toBe(201);
      });

      it("POST /flag reports a missing proposal as 422 missing", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ domain: stackDomain });

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: [
            {
              type: "missing",
              loc: ["body", "proposal"],
              msg: "Field required",
              input: { domain: stackDomain },
            },
          ],
        });
      });

      it("POST /flag accepts a non-object proposal as 422 model_attributes_type", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ domain: stackDomain, proposal: [] });

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: [
            {
              type: "model_attributes_type",
              loc: ["body", "proposal"],
              msg: "Input should be a valid dictionary or object to extract fields from",
              input: [],
            },
          ],
        });
      });

      it("POST /flag strips unknown fields instead of rejecting them", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody({ bogus: 1 }));

        expect(response.status).toBe(201);
        expect(asRecord(response.body)).not.toHaveProperty("bogus");
      });
  },
);
