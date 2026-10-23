import { sql } from "drizzle-orm";
import express from "express";
import type { Express } from "express";
import type { Sql } from "postgres";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";

import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
  createTransactionRunner,
  normalizeTimestamptz,
} from "./db.js";
import type { Database, TransactionRunner } from "./db.js";
import * as schema from "./schema.js";

/**
 * Integration tests against the live compose database.
 *
 * The host port is 5434, not 5432: `docker-compose.override.yml` remaps the
 * container's 5432 onto the host. `config.DATABASE_URL` keeps the in-container
 * default (5432) because that is what the api service sees, so these tests
 * build their own client from `AKS_TEST_DATABASE_URL` rather than reaching for
 * the process-wide singleton (which also keeps them from ever touching the
 * oracle's data).
 *
 * Every integration test skips — never fails — when the database is
 * unreachable, so `npm test` works without Docker. The pure-function tests in
 * the first block always run.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Reachability probe.
 *
 * This runs at module load, not in `beforeAll`, because `describe.skipIf` is
 * evaluated during test *collection* — i.e. before any hook executes. Probing
 * in `beforeAll` would leave the gate reading its initial value and the whole
 * block would always run (and fail) without Docker.
 */
const state: {
  client?: Sql;
  database?: Database;
  runner?: TransactionRunner;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  const candidate = createClient(TEST_DATABASE_URL, CONNECT_TIMEOUT_SECONDS);
  try {
    await candidate`select 1`;
    const db = createDatabase(candidate);
    state.client = candidate;
    state.database = db;
    state.runner = createTransactionRunner(db);
    state.skipReason = false;
  } catch (error) {
    state.skipReason = `database unreachable at ${TEST_DATABASE_URL}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    // Release the failed client so no socket or timer keeps the run alive.
    await candidate.end({ timeout: 1 }).catch(() => undefined);
  }
}

/** Reported once in the validation output, not per test. */
if (state.skipReason !== false) {
  console.warn(`[db.test] skipping integration tests — ${state.skipReason}`);
}

afterAll(async () => {
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

/**
 * Narrows the setup state for the compiler.
 *
 * `describe.skipIf` already guarantees these are set, but `noUncheckedIndexedAccess`
 * and union types mean the compiler cannot see that, and the constraints ban
 * unchecked casts. This helper narrows honestly and throws a clear internal
 * error if the invariant is ever broken — the surrounding gate still skips.
 */
function db(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

function txRunner(): TransactionRunner {
  if (state.runner === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.runner;
}

function pool(): Sql {
  if (state.client === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.client;
}

/**
 * Inserts one row in a rolled-back transaction and returns its `created_at`.
 *
 * The rollback is what keeps the assertions from leaving a fixture row behind.
 */
async function probeTimestamp(): Promise<string> {
  const domain = `t04-precision-${Date.now().toString(36)}`;
  let captured = "";

  await expect(
    txRunner()(async (tx) => {
      const inserted = await tx
        .insert(schema.stacks)
        .values({ name: "T0.4 Precision Probe", domain })
        .returning({ createdAt: schema.stacks.createdAt });

      const row = inserted[0];
      if (row === undefined) {
        throw new Error("insert returned no row");
      }
      const createdAt: unknown = row.createdAt;

      // A string, not a Date.
      expect(typeof createdAt).toBe("string");
      expect(createdAt instanceof Date).toBe(false);

      // Narrowing without a cast: `typeof` does not narrow `unknown` here, so
      // assert the runtime type, then re-read through the narrowed value.
      if (typeof createdAt !== "string") {
        throw new Error(`expected string, received ${typeof createdAt}`);
      }
      captured = createdAt;

      // Roll back now that the assertions have run, leaving no fixture row.
      throw new Error("rollback probe");
    }),
  ).rejects.toThrow("rollback probe");

  return captured;
}

/** Asserts the oracle's `timestamptz` text shape: 27 characters, six digits, `Z`. */
function expectTimestampShape(text: string): void {
  expect(text.endsWith("Z")).toBe(true);

  const fraction = /\.(\d+)Z$/.exec(text);
  expect(fraction).not.toBeNull();
  expect(fraction?.[1]).toHaveLength(6);

  expect(text).toHaveLength(27);
  expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
}

/** Counts any leftover probe rows in the precision fixture namespace. */
async function countPrecisionRows(): Promise<number> {
  const leftovers = await db()
    .select({ id: schema.stacks.id })
    .from(schema.stacks)
    .where(sql`${schema.stacks.domain} like ${"t04-precision-%"}`);
  return leftovers.length;
}

describe("normalizeTimestamptz", () => {
  // Pure functions: these run with or without Docker.

  it("converts Postgres text output to the oracle's Z-suffixed form", () => {
    expect(normalizeTimestamptz("2026-10-21 03:28:09.262117+00")).toBe(
      "2026-10-21T03:28:09.262117Z",
    );
  });

  it("pads a trailing-zero-trimmed fraction back to six digits", () => {
    // Postgres sends `.1` for 100000 microseconds.
    expect(normalizeTimestamptz("2026-10-21 03:16:59.1+00")).toBe(
      "2026-10-21T03:16:59.100000Z",
    );
  });

  it("pads a whole-second value to six zero digits", () => {
    // Postgres omits the fraction entirely for zero microseconds.
    expect(normalizeTimestamptz("2026-10-21 03:16:59+00")).toBe(
      "2026-10-21T03:16:59.000000Z",
    );
  });

  it("preserves true microsecond digits that a Date would truncate", () => {
    // 000001 is exactly the remainder Date.toISOString() destroys.
    expect(normalizeTimestamptz("2026-10-21 03:16:59.000001+00")).toBe(
      "2026-10-21T03:16:59.000001Z",
    );
  });

  it("normalizes a space-separated value with no offset", () => {
    // Shape of a plain `timestamp` (OID 1114) column.
    expect(normalizeTimestamptz("2026-10-21 03:16:59.138144")).toBe(
      "2026-10-21T03:16:59.138144Z",
    );
  });

  it("throws on input it cannot represent instead of guessing", () => {
    expect(() => normalizeTimestamptz("not a timestamp")).toThrow(TypeError);
  });
});

describe.skipIf(state.skipReason !== false)("database integration", () => {
  it("connects and runs select 1", async () => {
    const rows = await pool()`select 1 as ok`;
    expect(rows[0]?.["ok"]).toBe(1);
  });

  it("has all 8 tables from db/schema.sql", async () => {
    const expected = [
      "backfeed_queue",
      "document_chunks",
      "entity_pages",
      "entity_source_documents",
      "ontology_entities",
      "ontology_relationships",
      "stack_documents",
      "stacks",
    ];

    const result = await pool()<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    const actual = result.map((row) => row.table_name);

    for (const table of expected) {
      expect(actual).toContain(table);
    }
  });

  /**
   * The guard for `odd/findings/timestamp-precision.md`.
   *
   * Fails loudly if anyone later swaps in Date parsing: a `Date` would give
   * `typeof "object"` with 3 fractional digits instead of a string with 6.
   */
  it("returns timestamptz as a microsecond-precise string, never a Date", async () => {
    expectTimestampShape(await probeTimestamp());
    // The probe's transaction rolled back, so nothing was left behind.
    expect(await countPrecisionRows()).toBe(0);
  });

  it("rolls back a transaction whose body throws", async () => {
    const domain = `t04-rollback-${Date.now().toString(36)}`;

    await expect(
      txRunner()(async (tx) => {
        await tx
          .insert(schema.stacks)
          .values({ name: "Rollback Probe", domain });
        throw new Error("intentional failure");
      }),
    ).rejects.toThrow("intentional failure");

    const survivors = await db()
      .select({ id: schema.stacks.id })
      .from(schema.stacks)
      .where(sql`${schema.stacks.domain} = ${domain}`);
    expect(survivors).toHaveLength(0);
  });

  it("commits a transaction whose body succeeds", async () => {
    const domain = `t04-commit-${Date.now().toString(36)}`;

    const created = await txRunner()(async (tx) => {
      const rows = await tx
        .insert(schema.stacks)
        .values({ name: "Commit Probe", domain })
        .returning({ id: schema.stacks.id, domain: schema.stacks.domain });
      return rows[0];
    });

    expect(created).toBeDefined();
    expect(created?.domain).toBe(domain);

    // Clean up so repeated runs stay idempotent.
    if (created !== undefined) {
      await db()
        .delete(schema.stacks)
        .where(sql`${schema.stacks.id} = ${created.id}`);
    }
  });

  it("keeps the pool usable after many failed transactions", async () => {
    // Regression guard for connection leaks: a leak would exhaust the pool and
    // hang or reject the final query.
    for (let i = 0; i < 20; i += 1) {
      await txRunner()(async (tx) => {
        await tx.execute(sql`select 1`);
        throw new Error("boom");
      }).catch(() => undefined);
    }

    const rows = await pool()`select 1 as ok`;
    expect(rows[0]?.["ok"]).toBe(1);
  });

  /**
   * Locks the Express request-scoped contract.
   *
   * The `/boom` case is the regression guard: a middleware-based
   * implementation would COMMIT here, because `next()` returns void and the
   * middleware never observes the handler's rejection.
   */
  describe("withRequestTransaction", () => {
    function buildApp(): Express {
      const wrap = createRequestTransactionWrapper(db());
      const app = express();

      app.get(
        "/commit",
        wrap(async (_req, res, tx) => {
          await tx
            .insert(schema.stacks)
            .values({ name: "Route Commit", domain: "t04-route-commit" });
          res.json({ ok: true });
        }),
      );

      app.get(
        "/boom",
        wrap(async (_req, _res, tx) => {
          await tx
            .insert(schema.stacks)
            .values({ name: "Route Boom", domain: "t04-route-boom" });
          throw new Error("handler exploded");
        }),
      );

      // A deliberate 404 must still COMMIT, exactly as it would in Python.
      app.get(
        "/not-found",
        wrap(async (_req, res, tx) => {
          await tx
            .insert(schema.stacks)
            .values({ name: "Route 404", domain: "t04-route-404" });
          res.status(404).json({ detail: "Not Found" });
        }),
      );

      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          res.status(500).json({
            detail: errorMessage(err),
          });
        },
      );

      return app;
    }

    function errorMessage(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
    }

    async function countByDomain(domain: string): Promise<number> {
      const rows = await pool()`
        select count(*)::int as total from stacks where domain = ${domain}
      `;
      const total = rows[0]?.["total"];
      return typeof total === "number" ? total : -1;
    }

    afterAll(async () => {
      if (state.skipReason === false) {
        await pool()`delete from stacks where domain like 't04-route-%'`;
      }
    });

    it("commits when the handler resolves", async () => {
      const app = buildApp();
      const response = await request(app).get("/commit");

      expect(response.status).toBe(200);
      expect(await countByDomain("t04-route-commit")).toBe(1);
    });

    it("rolls back and surfaces the error when the handler throws", async () => {
      const app = buildApp();
      const response = await request(app).get("/boom");

      expect(response.status).toBe(500);
      expect(response.body).toStrictEqual({ detail: "handler exploded" });
      expect(await countByDomain("t04-route-boom")).toBe(0);
    });

    it("commits a deliberate 404 instead of treating it as a failure", async () => {
      const app = buildApp();
      const response = await request(app).get("/not-found");

      expect(response.status).toBe(404);
      expect(await countByDomain("t04-route-404")).toBe(1);
    });
  });
});
