import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createRequireApiKey } from "./auth.js";
import { parseConfig } from "./config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "./db.js";
import type { Database } from "./db.js";
import { noDatabase } from "./testing/no-database.js";
import { perRunDatabase } from "./testing/per-run-database.js";
import { createApp } from "./server.js";
import type { StacksRouterDependencies } from "./routes/stacks.js";

/**
 * Byte-for-byte liveness contract, verified against the Python oracle
 * (`GET http://localhost:8000/health`). Field names, values, and order
 * are part of the contract: the TS port must not reorder or reshape it.
 */
const EXPECTED_HEALTH_BODY =
  '{"status":"ok","service":"aks-reference-server","version":"0.2.0"}';

describe("GET /health", () => {
  it("returns 200 with the exact oracle body, in oracle field order", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    // Compare the raw text so field order is verified, not just deep equality.
    expect(response.text).toBe(EXPECTED_HEALTH_BODY);
    expect(response.body).toEqual({
      status: "ok",
      service: "aks-reference-server",
      version: "0.2.0",
    });
  });

  it("requires no authentication", async () => {
    const response = await request(createApp()).get("/health");
    expect(response.status).toBe(200);
  });
});

describe("unknown route", () => {
  it("returns 404 with a JSON body containing detail", async () => {
    const response = await request(createApp()).get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toHaveProperty("detail");
    expect(typeof response.body.detail).toBe("string");
  });
});

/**
 * The generic 500 path.
 *
 * This needs a real row, so it follows the same database conventions as the harnesses in
 * `routes/` and as `db.test.ts`: a server from `AKS_TEST_DATABASE_URL` or the runner's
 * `LLMWIKI_TEST_DATABASE_URL`, plus a database of this process's own from
 * `./testing/per-run-database.js`.
 *
 * That last part is not decoration. The container a run starts publishes a server whose default
 * database carries NO schema (measured: zero tables in `public`), so a suite that answered on that
 * URL and queried it directly would assert against an empty database. And CI publishes only
 * `LLMWIKI_TEST_DATABASE_URL` on 5432, never 5434: this block SKIPPED there before, and a loud
 * failure that ignored the documented override would just turn that skip into a red build.
 *
 * No database and no opt-out is therefore a FAILURE, not a skip: a skip is reported as a pass while
 * asserting nothing. `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is the only path back to the old skip.
 */
const TEST_SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** This process's own database, or the error that stopped it from being created. */
const SUITE = await perRunDatabase(TEST_SERVER_URL).catch((error: unknown) =>
  error instanceof Error ? error : new Error(String(error)),
);

/** The connection string every test below uses: this process's own database. */
const TEST_DATABASE_URL = SUITE instanceof Error ? TEST_SERVER_URL : SUITE.url;

/** Small handshake bound so an absent database fails fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/** Domain prefix for every row this block creates. */
const DOMAIN_PREFIX = "t-server-500-";

const state: {
  client?: Sql;
  database?: Database;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  if (SUITE instanceof Error) {
    // Loud, never a silent pass and never a shared-database fallback.
    state.skipReason = noDatabase(
      "The server suite needs a Postgres database and none could be obtained.",
      `database unreachable at ${TEST_SERVER_URL}: could not create a per-run database (${SUITE.message})`,
    );
  } else {
    const candidate = createClient(SUITE.url, CONNECT_TIMEOUT_SECONDS);
    try {
      await candidate`select 1`;
      state.client = candidate;
      state.database = createDatabase(candidate);
      state.skipReason = false;
    } catch (error) {
      state.skipReason = noDatabase(
        "The server suite needs a Postgres database and none could be obtained.",
        `database unreachable at ${TEST_DATABASE_URL}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await candidate.end({ timeout: 1 }).catch(() => undefined);
    }
  }
}

if (state.skipReason !== false) {
  console.warn(`[server.test] skipping the 500 integration test — ${state.skipReason}`);
}

afterAll(async () => {
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

/**
 * Narrows the setup state for the compiler without an unchecked cast. The
 * `describe.skipIf` below already guarantees it is set.
 */
function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

function deps(): StacksRouterDependencies {
  return {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(parseConfig({})),
  };
}

async function deleteFixtureRows(): Promise<void> {
  await database().execute(
    sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`,
  );
}

describe.skipIf(state.skipReason !== false)("generic 500 wire format", () => {
  beforeEach(deleteFixtureRows);

  /**
   * Forces the known 500: `PATCH` with an explicit `null` name reaches SQL as a
   * NOT NULL violation on `stacks.name`, which the route does not handle. The
   * oracle answers this with a plain-text 500, not a JSON one.
   */
  it("answers text/plain 'Internal Server Error', exactly like the oracle", async () => {
    const app = createApp(deps());
    const fixtureDomain = `${DOMAIN_PREFIX}${Date.now().toString(36)}`;

    const created = await request(app)
      .post("/stacks")
      .send({ name: "500 probe", domain: fixtureDomain });
    expect(created.status).toBe(201);
    const stackId = String(created.body.id);

    const response = await request(app)
      .patch(`/stacks/${stackId}`)
      .send({ name: null });

    expect(response.status).toBe(500);
    // Measured on the oracle: `text/plain; charset=utf-8`, 21 bytes, no JSON.
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.text).toBe("Internal Server Error");
    expect(response.text).toHaveLength(21);
  });

  it("keeps handled client errors as JSON with a detail field", async () => {
    // Only the generic 500 changed shape; 400/404/409/422 stay JSON.
    const app = createApp(deps());

    const notFound = await request(app).get(
      "/stacks/cccccccc-cccc-cccc-cccc-cccccccccccc",
    );
    expect(notFound.status).toBe(404);
    expect(notFound.headers["content-type"]).toMatch(/application\/json/);
    expect(notFound.body).toHaveProperty("detail");
  });
});
