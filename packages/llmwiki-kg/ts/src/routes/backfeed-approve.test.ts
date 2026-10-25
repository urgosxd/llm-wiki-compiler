/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-approve.test.ts
 * @description `POST /approve`: absorption, idempotency and conflicts.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { ABSENT_UUID, asRecord, asRecords, buildApp, counts, currentDomainPrefix, database, deleteFixtureRows, expectOracleTimestamp, skipReason, useDomainPrefix } from "./backfeed-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("approve");

describe.skipIf(skipReason !== false)("backfeed approve (live database)", () => {
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

      it("POST /approve absorbs the proposal, returns counts and flips the status", async () => {
        const app = buildApp();
        const id = await flag(app, {
          proposal: {
            entities: [
              { name: "Approved", type: "PRODUCT", description: "from approval" },
              { name: "Approved2", type: "PRODUCT" },
            ],
            relationships: [{ from_entity: "Approved", to_entity: "Approved2", type: "IS_A" }],
          },
        });

        const response = await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: id, reviewed_by: "alice", review_note: "looks right" });

        expect(response.status).toBe(200);
        // BackfeedApprovalResult, not the queue item.
        expect(Object.keys(asRecord(response.body))).toEqual([
          "item_id",
          "entities_absorbed",
          "relationships_absorbed",
          "status",
        ]);
        expect(response.body).toEqual({
          item_id: id,
          entities_absorbed: 2,
          relationships_absorbed: 1,
          status: "approved",
        });

        const stored = await request(app).get(`/aks/v1/backfeed/${id}`);
        expect(asRecord(stored.body)).toMatchObject({
          status: "approved",
          reviewed_by: "alice",
          review_note: "looks right",
        });
        expectOracleTimestamp(asRecord(stored.body)["reviewed_at"]);

        expect(await counts()).toMatchObject({ entities: 2, relationships: 1 });
      });

      it("POST /approve marks absorbed rows verified and backfeed-sourced", async () => {
        const app = buildApp();
        const id = await flag(app);

        await request(app).post("/aks/v1/backfeed/approve").send({ item_id: id }).expect(200);

        const rows = await database().execute<{
          verified: boolean;
          source_kind: string | null;
          pipeline: string | null;
        }>(sql`
          select verified, source_kind, pipeline
          from ontology_entities
          where stack_id = ${stackId} and name = 'Widget'
        `);

        expect(rows[0]).toEqual({
          verified: true,
          source_kind: "backfeed",
          pipeline: "human-review",
        });
      });

      it("POST /approve is idempotent and reports zero counts the second time", async () => {
        const app = buildApp();
        const id = await flag(app);

        const first = await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: id });
        expect(first.body).toEqual({
          item_id: id,
          entities_absorbed: 1,
          relationships_absorbed: 0,
          status: "approved",
        });

        const second = await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: id });
        expect(second.status).toBe(200);
        // Idempotent path: nothing is re-absorbed, so both counts are zero.
        expect(second.body).toEqual({
          item_id: id,
          entities_absorbed: 0,
          relationships_absorbed: 0,
          status: "approved",
        });

        // And the ontology was not written twice.
        expect(await counts()).toMatchObject({ entities: 1, relationships: 0 });
      });

      it("POST /approve answers 409 for a rejected item and leaves the ontology alone", async () => {
        const app = buildApp();
        const id = await flag(app);

        await request(app).post("/aks/v1/backfeed/reject").send({ item_id: id }).expect(200);

        const response = await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: id });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          detail: "Cannot approve an item that has been rejected",
        });
        expect(await counts()).toMatchObject({ entities: 0, relationships: 0 });
      });

      it("POST /approve answers 404 for an unknown id", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: ABSENT_UUID });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          detail: `Backfeed item ${ABSENT_UUID} not found`,
        });
      });

      it("POST /approve answers 422 for a malformed item_id, using the body loc", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: "nope" });

        expect(response.status).toBe(422);
        const detail = asRecords(asRecord(response.body)["detail"]);
        expect(detail[0]).toMatchObject({ type: "uuid_parsing", loc: ["body", "item_id"] });
      });

      it("POST /approve accepts missing reviewed_by and review_note as null", async () => {
        const app = buildApp();
        const id = await flag(app);

        await request(app)
          .post("/aks/v1/backfeed/approve")
          .send({ item_id: id })
          .expect(200);

        const stored = await request(app).get(`/aks/v1/backfeed/${id}`);
        expect(asRecord(stored.body)).toMatchObject({
          reviewed_by: null,
          review_note: null,
        });
      });
  },
);
