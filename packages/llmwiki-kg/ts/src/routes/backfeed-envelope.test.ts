/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-envelope.test.ts
 * @description Nullable fields, timestamps, auth and the mounted router surface.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { REQUIRED_NULLABLE_KEYS, asRecord, buildApp, buildFullApp, currentDomainPrefix, database, deleteFixtureRows, expectOracleTimestamp, skipReason, useDomainPrefix } from "./backfeed-harness.js";
import { withFixtureTenant } from "./fixture-tenant.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("envelope");

describe.skipIf(skipReason !== false)("backfeed envelope and mounting (live database)", () => {
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
        const rows = await withFixtureTenant(database(), { domain: domain }, (tx) => tx.execute<{ id: string }>(sql`
          insert into stacks (name, domain)
          values (${`Backfeed fixture ${label}`}, ${domain})
          returning id
        `));
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

      it("keeps note, reviewed_at, reviewed_by and review_note required-nullable", async () => {
        const app = buildApp();

        // Missing fails: Pydantic has no default for these four, so their absence
        // from a response model is a validation error, not an implicit null.
        const missing = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody());
        const body = asRecord(missing.body);
        for (const key of REQUIRED_NULLABLE_KEYS) {
          expect(Object.hasOwn(body, key)).toBe(true);
          expect(body[key]).toBeNull();
        }

        // Explicit null passes: re-reading the stored row keeps the keys present.
        const reread = await request(app).get(`/aks/v1/backfeed/${String(body["id"])}`).query({ domain: stackDomain });
        const rereadBody = asRecord(reread.body);
        for (const key of REQUIRED_NULLABLE_KEYS) {
          expect(Object.hasOwn(rereadBody, key)).toBe(true);
          expect(rereadBody[key]).toBeNull();
        }
      });

      it("serializes every timestamp as a microsecond-precision string", async () => {
        const app = buildApp();
        const id = await flag(app);

        const flagged = await request(app).get(`/aks/v1/backfeed/${id}`).query({ domain: stackDomain });
        expectOracleTimestamp(asRecord(flagged.body)["created_at"]);

        const approved = await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: id });
        expect(approved.status).toBe(200);

        const after = await request(app).get(`/aks/v1/backfeed/${id}`).query({ domain: stackDomain });
        expectOracleTimestamp(asRecord(after.body)["reviewed_at"]);
      });

      it("requires the API key when auth is enabled, like every other router", async () => {
        const app = buildApp("secret-key");

        const unauthorized = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody());
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.body).toEqual({
          detail: "Invalid or missing API key. Provide it in the X-API-Key header.",
        });

        const authorized = await request(app)
          .post("/aks/v1/backfeed/flag")
          .set("X-API-Key", "secret-key")
          .send(flagBody());
        expect(authorized.status).toBe(201);
      });

      it("serves every endpoint at the oracle's prefix through the real createApp()", async () => {
        const app = buildFullApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody());

        expect(response.status).toBe(201);
        const id = String(asRecord(response.body)["id"]);

        await request(app).get(`/aks/v1/backfeed/${id}`).query({ domain: stackDomain }).expect(200);
        await request(app).get("/aks/v1/backfeed/queue").query({ domain: stackDomain }).expect(200);
        await request(app).post("/aks/v1/backfeed/approve").send({ item_id: id }).expect(200);
        await request(app).post("/aks/v1/backfeed/reject").send({ item_id: id }).expect(404);
      });

      it("answers 405 with an allow header for an unsupported method", async () => {
        const app = buildFullApp();

        const response = await request(app).post("/aks/v1/backfeed/queue");

        // Matches the oracle exactly: 405 with `allow: GET`.
        expect(response.status).toBe(405);
        expect(response.headers["allow"]).toBe("GET");
        expect(response.body).toEqual({ detail: "Method Not Allowed" });
      });

      it("leaves unmatched paths to the 404 fallback", async () => {
        const app = buildFullApp();

        const response = await request(app).get("/aks/v1/backfeed/queue/extra");

        // FastAPI's unmatched-route shape, not Express's HTML page.
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ detail: "Not Found" });
      });
  },
);
