/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-flag.test.ts
 * @description `POST /flag`: the stored item and Stack resolution.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import request from "supertest";
import { ABSENT_UUID, ITEM_KEYS, asRecord, asRecords, buildApp, counts, currentDomainPrefix, database, deleteFixtureRows, expectOracleTimestamp, skipReason, useDomainPrefix, trackFixtureStack } from "./backfeed-harness.js";
import { withFixtureTenant } from "./fixture-tenant.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("flag-basic");

describe.skipIf(skipReason !== false)("backfeed flag (live database)", () => {
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

      beforeEach(async () => {
        await deleteFixtureRows();
        await createStack("case");
      });

      it("POST /flag creates a pending item with the oracle field set and order", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody());

        expect(response.status).toBe(201);
        const body = asRecord(response.body);

        // Key order is contractual and visible in the raw JSON text.
        expect(Object.keys(body)).toEqual([...ITEM_KEYS]);

        expect(body).toMatchObject({
          stack_id: stackId,
          // `origin` defaults to "direct", `trigger_type` to "manual".
          origin: "direct",
          trigger_type: "manual",
          status: "pending",
          metadata: {},
        });

        // Nothing is absorbed on flag: the item waits for approval.
        expect(await counts()).toMatchObject({ queue: 1, entities: 0, relationships: 0 });

        // The proposal round-trips through validation, defaults included.
        expect(body["proposal"]).toEqual({
          entities: [
            { name: "Widget", type: "PRODUCT", description: null, confidence: 0.7, properties: {} },
          ],
          relationships: [],
        });

        expectOracleTimestamp(body["created_at"]);
      });

      it("POST /flag applies the 0.7 confidence default and the nested defaults", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(
            flagBody({
              proposal: {
                entities: [{ name: "A", type: "PRODUCT" }],
                relationships: [{ from_entity: "A", to_entity: "B", type: "IS_A" }],
              },
            }),
          );

        expect(response.status).toBe(201);
        const proposal = asRecord(asRecord(response.body)["proposal"]);
        const entities = asRecords(proposal["entities"]);
        const relationships = asRecords(proposal["relationships"]);

        expect(entities[0]).toMatchObject({ description: null, confidence: 0.7, properties: {} });
        expect(relationships[0]).toMatchObject({ description: null, confidence: 0.7 });
      });

      it("POST /flag reaches the Stack by stack_id as well as by domain", async () => {
        const app = buildApp();

        const byId = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ stack_id: stackId, proposal: { entities: [{ name: "ById", type: "PRODUCT" }] } });

        expect(byId.status).toBe(201);
        expect(asRecord(byId.body)["stack_id"]).toBe(stackId);
      });

      it("POST /flag prefers stack_id when both stack_id and domain are supplied", async () => {
        const app = buildApp();

        // Measured: a valid stack_id with a nonexistent domain answers 201.
        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({
            stack_id: stackId,
            domain: "definitely-not-a-domain",
            proposal: { entities: [{ name: "Both", type: "PRODUCT" }] },
          });

        expect(response.status).toBe(201);
        expect(asRecord(response.body)["stack_id"]).toBe(stackId);
      });

      it("POST /flag stores origin, trigger_type, note and metadata verbatim", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(
            flagBody({
              origin: "run",
              trigger_type: "auto",
              note: "flagged by the agent",
              metadata: { run_id: "r-1", nested: { deep: [1, 2] } },
            }),
          );

        expect(response.status).toBe(201);
        expect(asRecord(response.body)).toMatchObject({
          origin: "run",
          trigger_type: "auto",
          note: "flagged by the agent",
          metadata: { run_id: "r-1", nested: { deep: [1, 2] } },
        });
      });

      it("POST /flag rejects an empty proposal with 400 before resolving the Stack", async () => {
        const app = buildApp();

        // Measured: `{"proposal": {}}` with no Stack at all answers 400, so the
        // empty-proposal check runs before stack resolution.
        const noStack = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ proposal: {} });
        expect(noStack.status).toBe(400);
        expect(noStack.body).toEqual({
          detail: "Proposal must include at least one entity or relationship",
        });

        const emptyArrays = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send(flagBody({ proposal: { entities: [], relationships: [] } }));
        expect(emptyArrays.status).toBe(400);
      });

      it("POST /flag answers 422 when neither stack_id nor domain is given", async () => {
        const app = buildApp();

        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ proposal: { entities: [{ name: "A", type: "PRODUCT" }] } });

        // A plain-string detail, not the 422 error array — FastAPI raised it from
        // the handler, not from request validation.
        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: "Either stack_id (UUID) or domain (slug) must be provided",
        });
      });

      it("POST /flag treats an empty-string domain as absent", async () => {
        const app = buildApp();

        // Python's guard is a truthiness test, so "" falls through to the 422.
        const response = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ domain: "", proposal: { entities: [{ name: "A", type: "PRODUCT" }] } });

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          detail: "Either stack_id (UUID) or domain (slug) must be provided",
        });
      });

      it("POST /flag answers 404 for an unknown domain and for an unknown stack_id", async () => {
        const app = buildApp();

        const byDomain = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ domain: "no-such-domain", proposal: { entities: [{ name: "A", type: "PRODUCT" }] } });
        expect(byDomain.status).toBe(404);
        expect(byDomain.body).toEqual({ detail: "Stack 'no-such-domain' not found" });

        const byId = await request(app)
          .post("/aks/v1/backfeed/flag")
          .send({ stack_id: ABSENT_UUID, proposal: { entities: [{ name: "A", type: "PRODUCT" }] } });
        expect(byId.status).toBe(404);
        expect(byId.body).toEqual({ detail: `Stack '${ABSENT_UUID}' not found` });
      });
  },
);
