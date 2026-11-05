/**
 * @file packages/llmwiki-kg/ts/src/routes/harness-database-isolation.test.ts
 * @description The route harnesses must bind this process to a database of its own.
 *
 * ## The class this pins
 *
 * Measured before the change: two concurrent processes running
 * `routes/stacks-read.test.ts` interfered, because both harnesses resolved the ONE
 * shared DSN (`postgresql://aks:aks@localhost:5434/aks`) and each one's
 * `beforeEach(deleteFixtureRows)` deletes by domain prefix. The second process read
 * `['B','C','A','B','C','A']` where it expected its own three rows: another suite's
 * rows were visible to it, and its own teardown looked like a vanishing Stack.
 *
 * No suite could express that invariant before, because "which database am I on" was
 * not a thing the harness could answer. These assertions are the ones it can answer
 * now: the suite is on a per-run database, and a sibling database's creation and
 * teardown cannot move this suite's rows.
 *
 * The Stack is written through the app's public `POST /stacks`, never by SQL, so the
 * routing and the database binding are proven together.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createClient, createDatabase } from "../db.js";
import {
  isPerRunDatabaseName,
  listPerRunDatabases,
} from "../testing/per-run-database.js";
import { createSuiteDatabase } from "../testing/per-run-database.js";
import {
  TEST_DATABASE_URL,
  buildApp,
  createBody,
  currentDomainPrefix,
  skipReason,
  useDomainPrefix,
} from "./stacks-harness.js";

// The harness cleans up by domain prefix, so this file needs its own namespace.
useDomainPrefix("isolation");

/** The database a connection string names. */
function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
}

/** A domain inside this file's cleanup namespace. */
function uniqueDomain(label: string): string {
  return `${currentDomainPrefix()}${label}-${randomUUID().slice(0, 8)}`;
}

describe.skipIf(skipReason !== false)("route harness database isolation (live database)", () => {
  it("binds the harness to a per-run database this process owns", async () => {
    const name = databaseName(TEST_DATABASE_URL);

    expect(isPerRunDatabaseName(name)).toBe(true);
    // On the same server, so the identity being checked is the database, not the host.
    expect(await listPerRunDatabases(TEST_DATABASE_URL)).toContain(name);
  });

  it("keeps its rows when a sibling per-run database is created and dropped", async () => {
    const domain = uniqueDomain("sibling");
    const created = await request(buildApp()).post("/stacks").send(createBody(domain));
    expect(created.status).toBe(201);

    // `createSuiteDatabase` retargets any connection string on the server, so the
    // harness's own URL names the server without naming the database.
    const sibling = await createSuiteDatabase(TEST_DATABASE_URL, "harness-isolation-sibling");
    try {
      expect(sibling.name).not.toBe(databaseName(TEST_DATABASE_URL));
      expect(await stacksIn(sibling.url, domain)).toBe(0);
      await sibling.drop();
    } finally {
      await sibling.drop();
    }

    expect(await listPerRunDatabases(TEST_DATABASE_URL)).not.toContain(sibling.name);
    const listed = await request(buildApp()).get("/stacks");
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { domain?: unknown }[]).filter((row) => row.domain === domain),
    ).toHaveLength(1);
    // Provisioning a whole sibling database is DDL; the default 5s is enough for the
    // assertions and not for a loaded server, and a timeout here would read as an
    // isolation failure when it is only a slow machine.
  }, 60_000);
});

/** How many Stacks carry `domain` in the database `url` points at. */
async function stacksIn(url: string, domain: string): Promise<number> {
  const client = createClient(url, 3);
  try {
    const rows = await createDatabase(client).execute<{ total: number }>(
      sql`select count(*)::int as total from stacks where domain = ${domain}`,
    );
    return rows[0]?.total ?? -1;
  } finally {
    await client.end({ timeout: 5 });
  }
}
