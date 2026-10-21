import { sql } from "drizzle-orm";
import express from "express";
import type { Express } from "express";
import type { Sql } from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "../db.js";
import type { Database } from "../db.js";
import { createApp } from "../server.js";
import { createBackfeedRouter } from "./backfeed.js";
import type { BackfeedRouterDependencies } from "./backfeed.js";

/**
 * Integration tests for the `/aks/v1/backfeed` router, against the live compose
 * database.
 *
 * Same conventions as `routes/stacks.test.ts`: host port 5434 from
 * `docker-compose.override.yml`, an own pool rather than the process-wide
 * singleton, and a clean skip — never a failure — when Postgres is unreachable.
 * The reachability probe runs at module load because `describe.skipIf` is
 * evaluated during collection, before any hook would run.
 *
 * ## Shared-database discipline
 *
 * Two sibling slices are writing to this same database concurrently, so every
 * fixture hangs off a Stack whose `domain` starts with {@link DOMAIN_PREFIX}.
 * All three tables this suite touches reference `stacks(id)` with
 * `on delete cascade`, so deleting the prefixed Stacks cleans up completely; the
 * explicit child-first deletes in `afterAll` are defence in depth. No query in
 * this file is unfiltered, so a sibling's rows are never read or written.
 *
 * ## Every expectation was measured against the Python oracle on :8000
 *
 * Where a status code or message is surprising, the measurement is recorded in
 * the comment next to the assertion.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/** Domain prefix for every Stack this suite creates. */
const DOMAIN_PREFIX = "w1bf-router-";

/** Unknown-but-well-formed UUID, for the not-found paths. */
const ABSENT_UUID = "00000000-0000-0000-0000-000000000000";

/** Response key order is contractual; asserted against every item body. */
const ITEM_KEYS = [
  "id",
  "stack_id",
  "origin",
  "trigger_type",
  "proposal",
  "note",
  "metadata",
  "status",
  "reviewed_at",
  "reviewed_by",
  "review_note",
  "created_at",
] as const;

/** The four audit fields are required-nullable: always present, `null` allowed. */
const REQUIRED_NULLABLE_KEYS = [
  "note",
  "reviewed_at",
  "reviewed_by",
  "review_note",
] as const;

const state: {
  client?: Sql;
  database?: Database;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  const candidate = createClient(TEST_DATABASE_URL, CONNECT_TIMEOUT_SECONDS);
  try {
    await candidate`select 1`;
    state.client = candidate;
    state.database = createDatabase(candidate);
    state.skipReason = false;
  } catch (error) {
    state.skipReason = `database unreachable at ${TEST_DATABASE_URL}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await candidate.end({ timeout: 1 }).catch(() => undefined);
  }
}

if (state.skipReason !== false) {
  console.warn(`[backfeed.test] skipping integration tests — ${state.skipReason}`);
}

/**
 * Narrows the setup state for the compiler without an unchecked cast, matching
 * `stacks.test.ts`. `describe.skipIf` already guarantees it is set.
 */
function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

/** Deletes every row this suite created, children first. */
async function deleteFixtureRows(): Promise<void> {
  const prefixed = sql`select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}`;

  await database().execute(
    sql`delete from ontology_relationships where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_entities where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from backfeed_queue where stack_id in (${prefixed})`,
  );
  await database().execute(sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`);
}

/** Counts this suite's rows across every table it writes. */
async function counts(): Promise<{
  stacks: number;
  queue: number;
  entities: number;
  relationships: number;
}> {
  const prefixed = sql`select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}`;
  const rows = await database().execute<{
    stacks: number;
    queue: number;
    entities: number;
    relationships: number;
  }>(sql`
    select
      (select count(*)::int from stacks where domain like ${`${DOMAIN_PREFIX}%`}) as stacks,
      (select count(*)::int from backfeed_queue where stack_id in (${prefixed})) as queue,
      (select count(*)::int from ontology_entities where stack_id in (${prefixed})) as entities,
      (select count(*)::int from ontology_relationships where stack_id in (${prefixed})) as relationships
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("count query returned no row");
  }
  return row;
}

/**
 * Dependencies bound to this suite's pool, never to the process-wide singleton.
 */
function deps(apiKey = ""): BackfeedRouterDependencies {
  return {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(
      parseConfig(apiKey === "" ? {} : { AKS_API_KEY: apiKey }),
    ),
  };
}

/** A bare app around just the router, under the oracle's mount prefix. */
function buildApp(apiKey = ""): Express {
  const app = express();
  app.use(express.json());
  app.use("/aks/v1/backfeed", createBackfeedRouter(deps(apiKey)));
  return app;
}

/**
 * The real `createApp()`, bound to this suite's pool and auth config.
 *
 * This is the genuine app factory, not a locally-composed stand-in: it proves
 * `server.ts` actually mounts this router at the oracle's prefix, behind the CORS
 * shim, the 405 middleware and the JSON body parser, and ahead of the 404
 * fallback. A missing or misordered mount therefore fails here rather than
 * silently passing.
 */
function buildFullApp(): Express {
  return createApp(deps());
}

/** Oracle timestamp contract: 27 chars, `Z`-suffixed, exactly 6 fractional digits. */
function expectOracleTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new Error(`expected a timestamp string, received ${typeof value}`);
  }
  expect(value).toHaveLength(27);
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
}

/**
 * Narrows a supertest response body to a record without an unchecked cast.
 *
 * Supertest types `body` as `any`, which the constraints forbid using directly.
 * The object contract is asserted at runtime first, so the returned type is
 * honest rather than assumed.
 */
function asRecord(body: unknown): Record<string, unknown> {
  expect(typeof body).toBe("object");
  expect(body).not.toBeNull();
  expect(Array.isArray(body)).toBe(false);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected a JSON object response");
  }
  return Object.fromEntries(Object.entries(body));
}

/** Narrows a body to a list of records. */
function asRecords(body: unknown): Record<string, unknown>[] {
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) {
    throw new Error("expected a JSON array response");
  }
  return body.map((item: unknown) => asRecord(item));
}

/** Resolves fast and deterministically; keeps `created_at` distinct per request. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

afterAll(async () => {
  await deleteFixtureRows();
  // Cleanup is a contract of this suite: nothing prefixed may survive it.
  expect(await counts()).toEqual({
    stacks: 0,
    queue: 0,
    entities: 0,
    relationships: 0,
  });
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

describe.skipIf(state.skipReason !== false)(
  "/aks/v1/backfeed router (live database)",
  () => {
    let sequence = 0;
    let stackId = "";
    let stackDomain = "";

    /** Unique domain per call, carrying the cleanup prefix. */
    function uniqueDomain(label: string): string {
      sequence += 1;
      return `${DOMAIN_PREFIX}${label}-${Date.now().toString(36)}-${String(sequence)}`;
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

    // -----------------------------------------------------------------------
    // flag
    // -----------------------------------------------------------------------

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
          { name: "Widget", type: "Thing", description: null, confidence: 0.7, properties: {} },
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
              entities: [{ name: "A", type: "T" }],
              relationships: [{ from_entity: "A", to_entity: "B", type: "knows" }],
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
        .send({ stack_id: stackId, proposal: { entities: [{ name: "ById", type: "T" }] } });

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
          proposal: { entities: [{ name: "Both", type: "T" }] },
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
        .send({ proposal: { entities: [{ name: "A", type: "T" }] } });

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
        .send({ domain: "", proposal: { entities: [{ name: "A", type: "T" }] } });

      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        detail: "Either stack_id (UUID) or domain (slug) must be provided",
      });
    });

    it("POST /flag answers 404 for an unknown domain and for an unknown stack_id", async () => {
      const app = buildApp();

      const byDomain = await request(app)
        .post("/aks/v1/backfeed/flag")
        .send({ domain: "no-such-domain", proposal: { entities: [{ name: "A", type: "T" }] } });
      expect(byDomain.status).toBe(404);
      expect(byDomain.body).toEqual({ detail: "Stack 'no-such-domain' not found" });

      const byId = await request(app)
        .post("/aks/v1/backfeed/flag")
        .send({ stack_id: ABSENT_UUID, proposal: { entities: [{ name: "A", type: "T" }] } });
      expect(byId.status).toBe(404);
      expect(byId.body).toEqual({ detail: `Stack '${ABSENT_UUID}' not found` });
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
        .send(flagBody({ proposal: { entities: [{ name: "A", type: "T", confidence: 1.5 }] } }));
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
        .send(flagBody({ proposal: { entities: [{ name: "A", type: "T", confidence: -0.1 }] } }));
      expect(tooLow.status).toBe(422);

      // Both bounds are inclusive, so the endpoints are accepted.
      const atBounds = await request(app)
        .post("/aks/v1/backfeed/flag")
        .send(
          flagBody({
            proposal: {
              entities: [
                { name: "Low", type: "T", confidence: 0 },
                { name: "High", type: "T", confidence: 1 },
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

    // -----------------------------------------------------------------------
    // queue
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // by-item GET
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // approve
    // -----------------------------------------------------------------------

    it("POST /approve absorbs the proposal, returns counts and flips the status", async () => {
      const app = buildApp();
      const id = await flag(app, {
        proposal: {
          entities: [
            { name: "Approved", type: "T", description: "from approval" },
            { name: "Approved2", type: "T" },
          ],
          relationships: [{ from_entity: "Approved", to_entity: "Approved2", type: "links" }],
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

    // -----------------------------------------------------------------------
    // reject
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // contract details shared by every response
    // -----------------------------------------------------------------------

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
      const reread = await request(app).get(`/aks/v1/backfeed/${String(body["id"])}`);
      const rereadBody = asRecord(reread.body);
      for (const key of REQUIRED_NULLABLE_KEYS) {
        expect(Object.hasOwn(rereadBody, key)).toBe(true);
        expect(rereadBody[key]).toBeNull();
      }
    });

    it("serializes every timestamp as a microsecond-precision string", async () => {
      const app = buildApp();
      const id = await flag(app);

      const flagged = await request(app).get(`/aks/v1/backfeed/${id}`);
      expectOracleTimestamp(asRecord(flagged.body)["created_at"]);

      const approved = await request(app)
        .post("/aks/v1/backfeed/approve")
        .send({ item_id: id });
      expect(approved.status).toBe(200);

      const after = await request(app).get(`/aks/v1/backfeed/${id}`);
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

      await request(app).get(`/aks/v1/backfeed/${id}`).expect(200);
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
