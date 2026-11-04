/**
 * @file test/services/ingest/default-stack-ingest.test.ts
 * @description An ingest on a checkout that configured NO Stack reaches its work and
 * writes to the default Stack, instead of refusing before it starts.
 *
 * ## The defect this pins
 *
 * `writeToDimensions` called `resolveStackId(env)` unconditionally, and that helper
 * throws when `AKS_STACK_ID` is blank. So the write path was strictly harder to
 * satisfy than every read seam beside it, which already degrade to the file/`undefined`
 * fallback on an empty variable: a bare checkout could compile a page it could never
 * have ingested.
 *
 * ## Why the environment is passed and not exported into `process.env`
 *
 * `ingestSource` takes the environment it writes with, so the case can hand it a bare
 * one -- a connection string and NO Stack id -- instead of mutating `process.env` and
 * restoring it. The smaller blast radius is the point: nothing else in this worker can
 * observe this case.
 *
 * ## Why this case leaves the default Stack in place
 *
 * `stacks.domain` is unique, so the default Stack is a single global row, and this
 * path COMMITS it (the ingest opens its own connection, so the transaction trick
 * `default-stack.test.ts` uses cannot wrap it). Deleting a row another suite may be
 * writing to at the same time is the more damaging choice, so the case asserts through
 * a unique source identity and leaves the one row behind. `default-stack.test.ts`
 * already tolerates a pre-existing default row: it deletes it inside a transaction it
 * always rolls back.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";

import { DATABASE_URL, createKgPostgresHarness } from "../../fixtures/kg-postgres.js";
import { DEFAULT_STACK_DOMAIN } from "../../../src/dimensions/stack-selection.js";
import { listSourceDocuments } from "../../../src/dimensions/wiki/source-documents-store.js";
import { ingestSource } from "../../../src/services/ingest/service.js";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "A short document ingested by a checkout that never configured a Stack.";

/** The environment a bare checkout has: a connection, and no Stack id. */
const BARE_ENV: NodeJS.ProcessEnv = { AKS_DATABASE_URL: DATABASE_URL };

const harness = await createKgPostgresHarness("ingest-default-stack");
const { reachable } = harness;

afterAll(() => harness.cleanup());

/**
 * The id of the Stack owning the default domain, if one exists.
 *
 * @param db - Handle to read through.
 * @returns The default Stack's id, or undefined when it was never materialized.
 */
async function defaultStackId(db: Database): Promise<string | undefined> {
  const rows = await db.execute<{ id: string }>(
    sql`select id from stacks where domain = ${DEFAULT_STACK_DOMAIN}`,
  );
  return rows[0]?.id;
}

describe.skipIf(!reachable)("ingest with no Stack configured", () => {
  it("writes the document to the default Stack instead of refusing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingest-default-stack-"));
    try {
      const source = path.join(root, "bare-checkout.md");
      await writeFile(source, BODY, "utf-8");

      const result = await ingestSource(root, source, undefined, BARE_ENV);

      expect(result.writeStatus).toBe("created");
      const stackId = await defaultStackId(harness.db);
      expect(stackId).toBeDefined();
      const documents = await listSourceDocuments(harness.db, stackId as string);
      expect(documents.map((document) => document.filename)).toContain(result.filename);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
