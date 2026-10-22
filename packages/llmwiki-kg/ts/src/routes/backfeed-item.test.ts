/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-item.test.ts
 * @description `GET /:item_id`.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { ABSENT_UUID, ITEM_KEYS, REQUIRED_NULLABLE_KEYS, asRecord, buildApp, currentDomainPrefix, database, deleteFixtureRows, skipReason, useDomainPrefix } from "./backfeed-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("item");

describe.skipIf(skipReason !== false)("backfeed item (live database)", () => {
      let sequence = 0;

      let stackId = "";

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
        stackId = row.id;
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

      it("GET /:item_id returns one item with the full field set", async () => {
        const app = buildApp();
        const id = await flag(app);

        const response = await request(app).get(`/aks/v1/backfeed/${id}`);

        expect(response.status).toBe(200);
        const body = asRecord(response.body);
        expect(Object.keys(body)).toEqual([...ITEM_KEYS]);
        expect(body).toMatchObject({ id, stack_id: stackId, status: "pending" });

        // Required-nullable: all four keys are present, all four are null.
        for (const key of REQUIRED_NULLABLE_KEYS) {
          expect(body).toHaveProperty(key);
          expect(body[key]).toBeNull();
        }
      });

      it("GET /:item_id answers 404 for an unknown id", async () => {
        const app = buildApp();

        const response = await request(app).get(`/aks/v1/backfeed/${ABSENT_UUID}`);

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          detail: `Backfeed item ${ABSENT_UUID} not found`,
        });
      });

      it("GET /:item_id answers 422 for a malformed id, using the path loc", async () => {
        const app = buildApp();

        const response = await request(app).get("/aks/v1/backfeed/nope");

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: [
            {
              type: "uuid_parsing",
              loc: ["path", "item_id"],
              msg: "Input should be a valid UUID, invalid character: found `n` at 0",
              input: "nope",
              ctx: { error: "invalid character: found `n` at 0" },
            },
          ],
        });
      });

      it("GET /:item_id normalizes an uppercase UUID in the 404 detail", async () => {
        const app = buildApp();

        const response = await request(app).get(
          "/aks/v1/backfeed/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        );

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          detail: "Backfeed item aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee not found",
        });
      });
  },
);
