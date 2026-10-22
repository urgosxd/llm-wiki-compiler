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
import { StackCreate } from "../dto.js";
import { toFastApiValidationError } from "../errors.js";
import { createApp } from "../server.js";
import { createStacksRouter } from "./stacks.js";
import type { StacksRouterDependencies } from "./stacks.js";

/**
 * Integration tests for the `/stacks` router, against the live compose database.
 *
 * Same conventions as `db.test.ts`: the host port is 5434 because
 * `docker-compose.override.yml` remaps the container's 5432, and this suite
 * builds its own pool instead of reusing the process-wide singleton, so it never
 * touches the oracle's data.
 *
 * Every DB-backed test skips — never fails — when Postgres is unreachable, so
 * `npm test` still works without Docker. The reachability probe runs at module
 * load because `describe.skipIf` is evaluated during collection, before any hook
 * would have run.
 *
 * Every expectation below was measured against the Python oracle on
 * `http://localhost:8000`; the comments name the measurement where the contract
 * is surprising.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix for every row this suite creates.
 *
 * `domain` is the natural cleanup key — unique, and never matching another
 * suite's prefix — so cleanup can only ever delete this suite's fixtures.
 */
const DOMAIN_PREFIX = "t07-stacks-";

/** Oracle column order, asserted against every response. */
const RESPONSE_KEYS = [
  "id",
  "name",
  "domain",
  "description",
  "scope",
  "compilation_strategy",
  "synthesize_descriptions",
  "created_at",
  "updated_at",
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
  console.warn(`[stacks.test] skipping integration tests — ${state.skipReason}`);
}

/**
 * Narrows the setup state for the compiler without an unchecked cast, matching
 * `db.test.ts`. `describe.skipIf` already guarantees it is set.
 */
function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

/** Deletes every row this suite created. */
async function deleteFixtureRows(): Promise<void> {
  await database().execute(
    sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`,
  );
}

/** Counts this suite's rows; used to prove cleanup actually happened. */
async function countFixtureRows(): Promise<number> {
  const rows = await database().execute<{ total: number }>(
    sql`select count(*)::int as total from stacks where domain like ${`${DOMAIN_PREFIX}%`}`,
  );
  return rows[0]?.total ?? -1;
}

/**
 * Dependencies bound to this suite's pool, never to the process-wide singleton.
 *
 * Auth is built from an explicit config so the enabled case does not depend on
 * ambient environment variables.
 */
function deps(apiKey = ""): StacksRouterDependencies {
  return {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(
      parseConfig(apiKey === "" ? {} : { AKS_API_KEY: apiKey }),
    ),
  };
}

/** A bare app around just the router. */
function buildApp(apiKey = ""): Express {
  const app = express();
  app.use(express.json());
  app.use("/stacks", createStacksRouter(deps(apiKey)));
  return app;
}

/** Minimal valid create body. */
function createBody(
  payloadDomain: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name: "T0.7 Stack", domain: payloadDomain, ...overrides };
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

/** Resolves fast and deterministically; keeps timestamps distinct across requests. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * Narrows a JSON response body to an array of records without an unchecked
 * cast.
 *
 * Supertest types `body` as `any`, which the task's constraints forbid using
 * directly. The array contract is asserted at runtime first, so the returned
 * element type is honest rather than assumed.
 */
function asRows(body: unknown): Record<string, unknown>[] {
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) {
    throw new Error("expected a JSON array response");
  }
  return body.map((item: unknown) => {
    expect(typeof item).toBe("object");
    if (typeof item !== "object" || item === null) {
      throw new Error("expected every array element to be an object");
    }
    return Object.fromEntries(Object.entries(item));
  });
}

afterAll(async () => {
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

describe.skipIf(state.skipReason !== false)("/stacks router (live database)", () => {
  let sequence = 0;

  /** Unique domain per call, carrying the cleanup prefix. */
  function uniqueDomain(label: string): string {
    sequence += 1;
    return `${DOMAIN_PREFIX}${label}-${Date.now().toString(36)}-${String(sequence)}`;
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

  it("GET /stacks lists rows ordered by updated_at desc", async () => {
    const app = buildApp();

    // `stacks` is shared: `db.test.ts` runs in a parallel worker and writes its
    // own `t04-` rows, so "the table is empty" is not a stable assertion. What is
    // stable — and what this suite is responsible for — is that none of *this*
    // suite's rows exist yet.
    const empty = await request(app).get("/stacks");
    expect(empty.status).toBe(200);
    expect(
      asRows(empty.body).filter((row) =>
        String(row["domain"]).startsWith(DOMAIN_PREFIX),
      ),
    ).toEqual([]);

    const first = await request(app)
      .post("/stacks")
      .send(createBody(uniqueDomain("order-a"), { name: "A" }));
    const second = await request(app)
      .post("/stacks")
      .send(createBody(uniqueDomain("order-b"), { name: "B" }));
    const third = await request(app)
      .post("/stacks")
      .send(createBody(uniqueDomain("order-c"), { name: "C" }));
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);

    // Touching the middle row must move it to the front — the reason the
    // ORDER BY exists.
    await tick();
    const touched = await request(app)
      .patch(`/stacks/${String(second.body.id)}`)
      .send({ description: "touched" });
    expect(touched.status).toBe(200);

    const listed = await request(app).get("/stacks");
    expect(listed.status).toBe(200);

    // Relative order of this suite's own rows, ignoring any concurrent fixture
    // from another suite: the touched row moves to the front.
    const rows = asRows(listed.body);
    const mine = rows.filter((row) => String(row["domain"]).startsWith(DOMAIN_PREFIX));
    expect(mine.map((row) => row["name"])).toEqual(["B", "C", "A"]);

    // Every row carries the full oracle shape, in order.
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([...RESPONSE_KEYS]);
    }
  });

  it("GET /stacks/:stack_id returns 200 for a known id and 404 for an unknown one", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/stacks")
      .send(createBody(uniqueDomain("get")));
    expect(created.status).toBe(201);

    const found = await request(app).get(`/stacks/${String(created.body.id)}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual(created.body);

    const missingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const missing = await request(app).get(`/stacks/${missingId}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ detail: `Stack ${missingId} not found` });

    // The detail carries the canonical lowercase hyphenated form, which is what
    // Pydantic serializes — an uppercase or simple-form id is normalized first.
    const uppercase = await request(app).get(
      "/stacks/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    );
    expect(uppercase.status).toBe(404);
    expect(uppercase.body).toEqual({ detail: `Stack ${missingId} not found` });
  });

  it("PATCH /stacks/:stack_id updates only the fields present in the body", async () => {
    const app = buildApp();
    const payloadDomain = uniqueDomain("patch");
    const created = await request(app)
      .post("/stacks")
      .send(createBody(payloadDomain, { description: "before" }));
    expect(created.status).toBe(201);

    await tick();
    // `description` is the only key present: `name` must be left untouched even
    // though `StackUpdate` defaults it to null.
    const patched = await request(app)
      .patch(`/stacks/${String(created.body.id)}`)
      .send({ description: "after" });

    expect(patched.status).toBe(200);
    expect(patched.body.description).toBe("after");
    expect(patched.body.name).toBe(created.body.name);
    expect(patched.body.domain).toBe(payloadDomain);
    expect(patched.body.created_at).toBe(created.body.created_at);
    // `updated_at = now()` is appended to the SET clause by the handler.
    expect(patched.body.updated_at).not.toBe(created.body.updated_at);
    expectOracleTimestamp(patched.body.updated_at);
  });

  it("PATCH /stacks/:stack_id distinguishes an absent key from an explicit null", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/stacks")
      .send(createBody(uniqueDomain("null"), { description: "present" }));
    expect(created.status).toBe(201);
    const id = String(created.body.id);

    // Absent key: untouched.
    const untouched = await request(app)
      .patch(`/stacks/${id}`)
      .send({ synthesize_descriptions: true });
    expect(untouched.status).toBe(200);
    expect(untouched.body.description).toBe("present");

    // Explicit null: writes NULL.
    const nulled = await request(app).patch(`/stacks/${id}`).send({ description: null });
    expect(nulled.status).toBe(200);
    expect(nulled.body.description).toBeNull();
  });

  it("PATCH /stacks/:stack_id rejects an empty body with 400, not 422", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/stacks")
      .send(createBody(uniqueDomain("empty")));
    expect(created.status).toBe(201);

    const response = await request(app)
      .patch(`/stacks/${String(created.body.id)}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ detail: "At least one field must be provided" });
  });

  it("PATCH /stacks/:stack_id returns 404 for an unknown id", async () => {
    const app = buildApp();
    const missingId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const response = await request(app)
      .patch(`/stacks/${missingId}`)
      .send({ name: "Nope" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: `Stack ${missingId} not found` });
  });

  it("DELETE /stacks/:stack_id returns 204 with a truly empty body, then 404", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/stacks")
      .send(createBody(uniqueDomain("delete")));
    expect(created.status).toBe(201);
    const id = String(created.body.id);

    const deleted = await request(app).delete(`/stacks/${id}`);
    expect(deleted.status).toBe(204);
    // Not `{}` and not `null`: FastAPI's 204 has no body at all.
    expect(deleted.text).toBe("");
    expect(deleted.body).toEqual({});

    // The row is gone, so the second delete is a 404.
    const again = await request(app).delete(`/stacks/${id}`);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ detail: `Stack ${id} not found` });
  });

  it("rejects a non-UUID path parameter with a 422 on the path location", async () => {
    const app = buildApp();

    // A valid body on PATCH keeps the body out of the error list, so the path
    // entry is the only one asserted here. (With no body at all the oracle also
    // reports `missing` on `["body"]`; that combination is pinned separately.)
    const requests = [
      request(app).get("/stacks/not-a-uuid"),
      request(app).patch("/stacks/not-a-uuid").send({ name: "Nope" }),
      request(app).delete("/stacks/not-a-uuid"),
    ];

    for (const pending of requests) {
      const response = await pending;
      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        detail: [
          {
            type: "uuid_parsing",
            loc: ["path", "stack_id"],
            msg: "Input should be a valid UUID, invalid character: found `n` at 0",
            input: "not-a-uuid",
            ctx: { error: "invalid character: found `n` at 0" },
          },
        ],
      });
    }
  });

  it("reports path and body errors together, path first", async () => {
    const app = buildApp();

    // Measured on the oracle: `PATCH /stacks/not-a-uuid` with `{"name": ""}`
    // answers 422 with the path entry followed by the body entry.
    const both = await request(app)
      .patch("/stacks/not-a-uuid")
      .send({ name: "" });
    expect(both.status).toBe(422);
    expect(both.body).toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "stack_id"],
          msg: "Input should be a valid UUID, invalid character: found `n` at 0",
          input: "not-a-uuid",
          ctx: { error: "invalid character: found `n` at 0" },
        },
        {
          type: "string_too_short",
          loc: ["body", "name"],
          msg: "String should have at least 1 character",
          input: "",
          ctx: { min_length: 1 },
        },
      ],
    });

    // And a PATCH with no body at all reports `missing` for the body, next to
    // the path failure.
    const noBody = await request(app).patch("/stacks/not-a-uuid");
    expect(noBody.status).toBe(422);
    expect(noBody.body).toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "stack_id"],
          msg: "Input should be a valid UUID, invalid character: found `n` at 0",
          input: "not-a-uuid",
          ctx: { error: "invalid character: found `n` at 0" },
        },
        { type: "missing", loc: ["body"], msg: "Field required", input: null },
      ],
    });
  });

  it("requires the API key on the router while /health stays open", async () => {
    // The real `createApp`, with the router's dependencies pointed at this
    // suite's pool so the registration itself is what gets exercised.
    const app = createApp(deps());

    // `/health` is still served by the app, and `/stacks` reaches the router
    // (auth disabled for these deps, so 200).
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    const openList = await request(app).get("/stacks");
    expect(openList.status).toBe(200);

    // With a key configured, the router — not the app — rejects the request.
    const guarded = buildApp("secret-key");
    const unauthenticated = await request(guarded).get("/stacks");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({
      detail: "Invalid or missing API key. Provide it in the X-API-Key header.",
    });

    const authenticated = await request(guarded)
      .get("/stacks")
      .set("X-API-Key", "secret-key");
    expect(authenticated.status).toBe(200);
  });

});

/**
 * Cleanup, and the proof that it happened.
 *
 * Runs after the suite's last test regardless of failures, then asserts the
 * `stacks` table holds none of this suite's rows. A test that aborted mid-way
 * still leaves nothing behind, because the delete keys on the domain prefix that
 * only this suite uses.
 */
afterAll(async () => {
  if (state.skipReason !== false) {
    return;
  }
  await deleteFixtureRows();
  expect(await countFixtureRows()).toBe(0);
});
