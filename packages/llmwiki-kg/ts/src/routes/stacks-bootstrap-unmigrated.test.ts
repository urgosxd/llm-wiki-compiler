/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-bootstrap-unmigrated.test.ts
 * @description What the BOOTSTRAP routes say when the database predates
 * `db/migration_stack_active.sql`.
 *
 * ## Why the bootstrap routes, and not the Stack-scoped ones
 *
 * `POST /stacks` and `GET /stacks` are the two routes that name no Stack, so they are
 * the two an operator still has on the day an upgrade misbehaves: the listing is where
 * they go to find out what the deployment thinks it has, and the create is where they
 * go to declare the Stack they meant to exist. The Stack-scoped paths were guarded
 * first (`stackResolution` in `@repo/wiki`'s stack store), which left exactly these
 * routes answering a driver error — the worst possible place for one, because it reads
 * as a broken query rather than as a missing migration the reader can apply.
 *
 * ## Why the column is really dropped instead of mocked
 *
 * The scenario is built the way an operator meets it. `createSuiteDatabase` provisions a
 * fully migrated database, so the column is dropped here with
 * `alter table stacks drop column active` and restored afterwards. A mocked driver error
 * would pin the guard against a guess about the error's shape; this pins it against the
 * one Postgres actually emits, twice over: the SQLSTATE `42703` and the text
 * `column "active" does not exist`.
 *
 * ## Why a private database instead of the shared route harness
 *
 * Dropping a column is a whole-database fixture, and the other `stacks-*` suites read
 * the same table. This file provisions its own suite database and drops it in
 * `afterAll`, so the dropped column cannot be observed by a concurrent suite and the
 * restore cannot race one.
 *
 * ## What is deliberately NOT here
 *
 * `{"detail": "<string>"}` and nothing else. These routes are the byte-faithful port of
 * the FastAPI original, so the repair puts the named sentence in the envelope's one
 * field rather than adding a field a client has never seen.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import express from "express";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missingActiveColumnRefusal } from "@repo/foundation/stack-migration";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "../db.js";
import type { Database } from "../db.js";
import { createSuiteDatabase } from "../testing/per-run-database.js";
import { noDatabase } from "../testing/no-database.js";

import { createStacksRouter } from "./stacks.js";

/** The server, from the shared harness; the database itself is this file's own. */
const SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** This file's private suite database, or the error that stopped it from being created. */
const SUITE = await createSuiteDatabase(SERVER_URL, "stacks-bootstrap-unmigrated").catch(
  (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
);

/** Why this file cannot run, or `false` when it can. */
const skipReason =
  SUITE instanceof Error
    ? noDatabase(
        "The bootstrap-route suites need a Postgres database and none could be obtained.",
        `database unreachable at ${SERVER_URL}: could not create a suite database (${SUITE.message})`,
      )
    : false;

/** This file's connection pool, once the database exists. */
const client = SUITE instanceof Error ? undefined : createClient(SUITE.url, 3);

afterAll(async () => {
  if (client !== undefined) {
    await client.end({ timeout: 5 });
  }
  if (SUITE instanceof Error) {
    return;
  }
  await SUITE.drop();
});

/** The handle this file's app and its own assertions share. */
function database(): Database {
  if (client === undefined) {
    throw new Error("suite setup did not complete");
  }
  return createDatabase(client);
}

/** The app under test, bound to this file's own database. */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/stacks",
    createStacksRouter({
      wrap: createRequestTransactionWrapper(database()),
      apiKey: createRequireApiKey(parseConfig({})),
    }),
  );
  return app;
}

/** How many rows carry `domain` — asked directly, so no route can hide the answer. */
async function rowsWithDomain(domain: string): Promise<number> {
  const rows = await database().execute<{ total: number }>(
    sql`select count(*)::int as total from stacks where domain = ${domain}`,
  );
  return rows[0]?.total ?? -1;
}

/** The exact term an operator has to be able to act on. */
const NAMES_THE_MIGRATION = /migration_stack_active\.sql/;

/**
 * What the caller actually met, in one line, for an assertion message.
 *
 * Attached to the status assertion so a failure shows the body or text the server really
 * answered — `status 500: Failed query: select …` — instead of only `500 is not 503`,
 * which is the same sentence for every possible cause.
 *
 * @param response - The supertest response to summarise.
 * @returns The status and the response payload, truncated.
 */
function met(response: request.Response): string {
  const body: unknown = response.body;
  const payload =
    typeof body === "object" && body !== null && Object.keys(body).length > 0
      ? JSON.stringify(body)
      : response.text;
  return `status ${response.status}: ${payload.slice(0, 400)}`;
}

/**
 * Assert the response is the named refusal, in the graph surface's own envelope.
 *
 * Three things together, because any one alone can be satisfied by a wrong answer: the
 * status says the service cannot answer, `detail` names the file to apply, and the body
 * has that ONE key — a repair that added a `code` or `migration` field would be a
 * contract change to a port whose error envelope is measured.
 *
 * @param response - The supertest response to inspect.
 */
function expectNamedRefusal(response: request.Response): void {
  expect(response.status, met(response)).toBe(503);
  expect(Object.keys(response.body as object)).toEqual(["detail"]);
  const detail = (response.body as { detail?: unknown }).detail;
  expect(typeof detail).toBe("string");
  expect(detail).toMatch(NAMES_THE_MIGRATION);
  expect(detail).toContain("stacks.active");
  // The failure this replaced: drizzle's `Failed query: select active from stacks …`,
  // which reads as a broken SELECT and names neither the file nor the step.
  expect(String(detail).startsWith("Failed query:")).toBe(false);
  // One sentence, one home: what the routes answer is what the shared module says.
  expect(detail).toBe(missingActiveColumnRefusal());
}

describe.skipIf(skipReason !== false)(
  "/stacks bootstrap routes on a database that never ran the migration",
  () => {
    beforeAll(async () => {
      await database().execute("alter table stacks drop column active");
    });

    afterAll(async () => {
      await database().execute(
        "alter table stacks add column if not exists active boolean not null default true",
      );
    });

    it("GET /stacks names the migration instead of surfacing the driver error", async () => {
      expectNamedRefusal(await request(buildApp()).get("/stacks"));
    });

    it("GET /stacks/:stackId names the migration instead of surfacing the driver error", async () => {
      expectNamedRefusal(await request(buildApp()).get(`/stacks/${randomUUID()}`));
    });

    it("POST /stacks names the migration and writes no row", async () => {
      const domain = `t07-stacks-bootstrap-${randomUUID().slice(0, 8)}`;

      expectNamedRefusal(await request(buildApp()).post("/stacks").send({ name: "Bootstrap", domain }));

      // The refusal is a refusal: the insert's `returning` is what fails, and the
      // transaction it ran in rolled back, so nothing was written. A guard that
      // answered 503 while committing an unreadable row would be worse than the raw
      // driver error it replaced, because the operator would believe the Stack exists.
      expect(await rowsWithDomain(domain)).toBe(0);
    });
  },
);

describe.skipIf(skipReason !== false)(
  "an undefined column that is NOT the stack-active migration",
  () => {
    beforeAll(async () => {
      await database().execute("alter table stacks drop column description");
    });

    afterAll(async () => {
      await database().execute(
        "alter table stacks add column if not exists description text",
      );
    });

    it("is not reported as this migration, so the operator is not sent to the wrong file", async () => {
      const response = await request(buildApp()).get("/stacks");

      // Still broken, and still the caller's problem to see — but the repair must not
      // tell an operator to apply a migration that is already applied. The shared
      // matcher keys on `stacks.active` specifically for this reason.
      expect(response.status).not.toBe(503);
      expect(JSON.stringify(response.body ?? "")).not.toMatch(NAMES_THE_MIGRATION);
      expect(response.text).not.toMatch(NAMES_THE_MIGRATION);
    });
  },
);
