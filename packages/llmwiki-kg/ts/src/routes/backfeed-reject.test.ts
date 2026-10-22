/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-reject.test.ts
 * @description `POST /reject`.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { ABSENT_UUID, ITEM_KEYS, asRecord, buildApp, counts, currentDomainPrefix, database, deleteFixtureRows, expectOracleTimestamp, skipReason, useDomainPrefix } from "./backfeed-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("reject");

describe.skipIf(skipReason !== false)("backfeed reject (live database)", () => {
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
          proposal: { entities: [{ name: "Widget", type: "Thing" }] },
          ...overrides,
        };
      }

      /** Flags one item and returns its id. */
      async function flag(app: Express, overrides: Record<string, unknown> = {}): Promise<string> {
        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody(overrides));
        expect(response.status).toBe(201);
        return String(asRecord(response.body)["id"]);
      }

      beforeEach(async () => {
        await deleteFixtureRows();
        await createStack("case");
      });

      it("POST /reject flips the status, returns the item and never touches the ontology", async () => {
        const app = buildApp();
        const id = await flag(app);

        const response = await request(app)
          .post("/aks/v1/backfeed/reject")
          .send({ item_id: id, reviewed_by: "bob", review_note: "not relevant" });

        expect(response.status).toBe(200);
        const body = asRecord(response.body);
        expect(Object.keys(body)).toEqual([...ITEM_KEYS]);
        expect(body).toMatchObject({
          id,
          status: "rejected",
          reviewed_by: "bob",
          review_note: "not relevant",
        });
        expectOracleTimestamp(body["reviewed_at"]);

        // Absorbed rows stay at zero: rejection is a status change only.
        expect(await counts()).toMatchObject({ entities: 0, relationships: 0 });
      });

      it("POST /reject answers 404 on a second reject, not 409", async () => {
        const app = buildApp();
        const id = await flag(app);

        await request(app).post("/aks/v1/backfeed/reject").send({ item_id: id }).expect(200);

        const response = await request(app)
          .post("/aks/v1/backfeed/reject")
          .send({ item_id: id });

        // The `and status = 'pending'` guard makes this a 404 with the combined
        // message, which is what the oracle answers.
        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          detail: `Backfeed item ${id} not found or not in pending status`,
        });
      });

      it("POST /reject answers 404 for an already-approved item", async () => {
        const app = buildApp();
        const id = await flag(app);

        await request(app).post("/aks/v1/backfeed/approve").send({ item_id: id }).expect(200);

        const response = await request(app)
          .post("/aks/v1/backfeed/reject")
          .send({ item_id: id });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          detail: `Backfeed item ${id} not found or not in pending status`,
        });
      });

      it("POST /reject answers 404 for an unknown id", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/reject")
          .send({ item_id: ABSENT_UUID });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          detail: `Backfeed item ${ABSENT_UUID} not found or not in pending status`,
        });
      });
  },
);
