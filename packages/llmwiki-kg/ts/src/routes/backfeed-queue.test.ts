/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-queue.test.ts
 * @description `GET /queue`: ordering, filters and query validation.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { ABSENT_UUID, ITEM_KEYS, asRecord, asRecords, buildApp, currentDomainPrefix, database, deleteFixtureRows, skipReason, tick, useDomainPrefix } from "./backfeed-harness.js";
import { withFixtureTenant } from "./fixture-tenant.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("queue");

describe.skipIf(skipReason !== false)("backfeed queue (live database)", () => {
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

      it("GET /queue lists the flagged item and defaults to pending only", async () => {
        const app = buildApp();
        const id = await flag(app);

        const response = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain });

        expect(response.status).toBe(200);
        const items = asRecords(response.body);
        expect(items).toHaveLength(1);
        expect(Object.keys(items[0] ?? {})).toEqual([...ITEM_KEYS]);
        expect(items[0]).toMatchObject({ id, status: "pending" });
      });

      it("GET /queue orders newest first", async () => {
        const app = buildApp();
        const first = await flag(app);
        await tick();
        const second = await flag(app);

        const response = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, item_status: "all" });

        expect(response.status).toBe(200);
        const ids = asRecords(response.body).map((item) => String(item["id"]));
        expect(ids).toEqual([second, first]);
      });

      it("GET /queue honours limit and the status filter", async () => {
        const app = buildApp();
        const keepPending = await flag(app);
        await tick();
        const toReject = await flag(app);

        await request(app)
          .post("/aks/v1/backfeed/reject")
          .send({ item_id: toReject })
          .expect(200);

        const pending = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, item_status: "pending" });
        expect(asRecords(pending.body).map((item) => String(item["id"]))).toEqual([keepPending]);

        const rejected = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, item_status: "rejected" });
        expect(asRecords(rejected.body).map((item) => String(item["id"]))).toEqual([toReject]);

        // `all` disables the filter entirely.
        const all = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, item_status: "all" });
        expect(asRecords(all.body)).toHaveLength(2);

        const limited = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, item_status: "all", limit: 1 });
        expect(asRecords(limited.body)).toHaveLength(1);
      });

      it("GET /queue treats an empty item_status as unfiltered", async () => {
        const app = buildApp();
        await flag(app);

        // Measured: `?item_status=` answers 200 with every status, because the
        // Python guard is `if item_status and item_status != "all"`.
        const response = await request(app)
          .get("/aks/v1/backfeed/queue?domain=" + stackDomain + "&item_status=");

        expect(response.status).toBe(200);
        expect(asRecords(response.body)).toHaveLength(1);
      });

      it("GET /queue answers 400 for an unknown item_status", async () => {
        const app = buildApp();
        await flag(app);

        const response = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, item_status: "bogus" });

        // A plain-string detail: the status set is validated in the handler.
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          detail: "status must be pending, approved, rejected, or all",
        });

        // The comparison is case-sensitive.
        const upperCase = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, item_status: "PENDING" });
        expect(upperCase.status).toBe(400);
      });

      it("GET /queue enforces the limit bounds and reports them as query 422s", async () => {
        const app = buildApp();

        const zero = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, limit: "0" });
        expect(zero.status).toBe(422);
        expect(zero.body).toEqual({
          detail: [
            {
              type: "greater_than_equal",
              loc: ["query", "limit"],
              msg: "Input should be greater than or equal to 1",
              input: "0",
              ctx: { ge: 1 },
            },
          ],
        });

        const tooBig = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, limit: "201" });
        expect(tooBig.status).toBe(422);

        const notANumber = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ domain: stackDomain, limit: "abc" });
        expect(notANumber.status).toBe(422);
        expect(notANumber.body).toEqual({
          detail: [
            {
              type: "int_parsing",
              loc: ["query", "limit"],
              msg: "Input should be a valid integer, unable to parse string as an integer",
              input: "abc",
            },
          ],
        });
      });

      it("GET /queue reports query failures in the Python parameter order", async () => {
        const app = buildApp();

        const response = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ stack_id: "nope", limit: "0" });

        expect(response.status).toBe(422);
        const detail = asRecords(asRecord(response.body)["detail"]);
        // stack_id is declared before limit in the Python signature.
        expect(detail.map((entry) => entry["loc"])).toEqual([
          ["query", "stack_id"],
          ["query", "limit"],
        ]);
      });

      it("GET /queue answers 422 for an empty stack_id and 404 for an unknown one", async () => {
        const app = buildApp();

        const empty = await request(app).get("/aks/v1/backfeed/queue?stack_id=");
        expect(empty.status).toBe(422);

        const unknown = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ stack_id: ABSENT_UUID });
        expect(unknown.status).toBe(404);
        expect(unknown.body).toEqual({ detail: `Stack '${ABSENT_UUID}' not found` });
      });

      it("GET /queue answers 422 when no Stack is supplied at all", async () => {
        const app = buildApp();

        const response = await request(app).get("/aks/v1/backfeed/queue");

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: "Either stack_id (UUID) or domain (slug) must be provided",
        });
      });

      it("GET /queue can be addressed by stack_id", async () => {
        const app = buildApp();
        const id = await flag(app);

        const response = await request(app)
          .get("/aks/v1/backfeed/queue")
          .query({ stack_id: stackId });

        expect(response.status).toBe(200);
        expect(asRecords(response.body).map((item) => String(item["id"]))).toEqual([id]);
      });
  },
);
