/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-item.test.ts
 * @description `GET /:item_id`.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { ABSENT_UUID, ITEM_KEYS, REQUIRED_NULLABLE_KEYS, asRecord, buildApp, currentDomainPrefix, database, deleteFixtureRows, skipReason, useDomainPrefix, trackFixtureStack } from "./backfeed-harness.js";
import { withFixtureTenant } from "./fixture-tenant.js";

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
        const rows = await withFixtureTenant(database(), { domain: domain }, (tx) => tx.execute<{ id: string }>(sql`
          insert into stacks (name, domain)
          values (${`Backfeed fixture ${label}`}, ${domain})
          returning id
        `));
        const row = rows[0];
        if (row === undefined) {
          throw new Error("insert into stacks returned no row");
        }
        trackFixtureStack(row.id);
        stackId = row.id;
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

        const response = await request(app).get(`/aks/v1/backfeed/${id}`).query({ domain: stackDomain });

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

        const response = await request(app).get(`/aks/v1/backfeed/${ABSENT_UUID}`).query({ domain: stackDomain });

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

      it("GET /:item_id answers 404 for an item belonging to another Stack", async () => {
        // The reason this route requires a Stack at all. The lookup used to be
        // `where id = $1`, so any caller holding an item UUID could read another
        // tenant's proposal. RLS does not cover it in this deployment: the app role
        // is a superuser with `bypassrls` and owns the table, and nothing in the
        // backfeed path sets `app.stack_id`.
        const app = buildApp();
        const id = await flag(app);
        const ownDomain = stackDomain;

        // A second Stack, and the same id read against it.
        await createStack("other");

        const response = await request(app)
          .get(`/aks/v1/backfeed/${id}`)
          .query({ domain: stackDomain });

        expect(response.status).toBe(404);

        // And the owner can still read it, so the refusal is scoping and not a
        // broken lookup.
        const owned = await request(app)
          .get(`/aks/v1/backfeed/${id}`)
          .query({ domain: ownDomain });
        expect(owned.status).toBe(200);
      });

      it("GET /:item_id answers 422 when no Stack is supplied", async () => {
        // No alias keeps the unscoped path alive: an unscoped read is the defect.
        const app = buildApp();
        const id = await flag(app);

        const response = await request(app).get(`/aks/v1/backfeed/${id}`);

        expect(response.status).toBe(422);
        expect(asRecord(response.body)["detail"]).toBe(
          "Either stack_id (UUID) or domain (slug) must be provided",
        );
      });

      it("GET /:item_id normalizes an uppercase UUID in the 404 detail", async () => {
        const app = buildApp();
        // A Stack is required and resolved BEFORE the lookup, so the route answers
        // the Stack error rather than a validation one. The point of this test is
        // the UUID normalisation in the 404 detail, which needs a real Stack.
        await createStack("uuidcase");

        const response = await request(app)
          .get("/aks/v1/backfeed/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")
          .query({ domain: stackDomain });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          detail: "Backfeed item aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee not found",
        });
      });
  },
);
