/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-delete.test.ts
 * @description `DELETE /stacks/:stackId` inactivates the Stack instead of destroying it.
 *
 * ## What this file pins, and why it is a defect repair rather than a preference
 *
 * Nine production tables reference `stacks(id)` with `on delete cascade`
 * (`db/schema.sql`, every one of them), so the physical `delete from stacks ... returning
 * id` this route used to run answered 204 while silently destroying the Stack's
 * documents, chunks, entities, pages, candidates and evidence. Nothing refused it and
 * nothing reported what it destroyed. The contract now is:
 *
 *   - the row SURVIVES, with `active = false`;
 *   - everything that referenced it survives too, because nothing is deleted;
 *   - an already-inactive Stack is an idempotent 204 that changes nothing;
 *   - an unknown id is still the 404 it always was;
 *   - `PATCH` with `active: true` brings the Stack back, which it must, because
 *     `domain` is unique and an inactive row keeps its domain forever.
 *
 * ## Why the dependent rows are counted through SQL
 *
 * `stack_documents` has no route on this app, so there is no public read that answers
 * "did the cascade take it". The Stack itself, its `active` flag and its timestamps are
 * all asserted over HTTP; only the dependent row is read directly, because that is the
 * only place it is observable at all.
 *
 * ## Why the cases are module-level functions
 *
 * Each body is a named function handed to `it()` rather than written inline, so the
 * shape of the suite is readable at a glance and every case stays single-purpose.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { RESPONSE_KEYS, buildApp, createBody, currentDomainPrefix, database, deleteFixtureRows, skipReason, tick, uniqueDomain, useDomainPrefix } from "./stacks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("delete");

/**
 * Create one Stack over HTTP and return its id.
 *
 * @param app - The app under test.
 * @param domain - The domain the fixture Stack owns.
 * @returns The created Stack's id.
 */
async function createStack(app: Express, domain: string): Promise<string> {
  const created = await request(app).post("/stacks").send(createBody(domain));
  expect(created.status).toBe(201);
  return String(created.body.id);
}

/**
 * Insert one row into a table that references `stacks(id)` with `on delete cascade`.
 *
 * `stack_documents` is the cheapest of the nine — five required columns and no
 * embedding — and it is exactly what the physical DELETE used to destroy.
 *
 * @param stackId - The Stack the row belongs to.
 */
async function insertDependentDocument(stackId: string): Promise<void> {
  await database().execute(sql`
    insert into stack_documents (stack_id, filename, storage_path, size_bytes, source_hash)
    values (${stackId}, 'source.md', ${`${stackId}/source.md`}, 12, ${`hash-${stackId}`})
  `);
}

/**
 * How many dependent rows the Stack still has.
 *
 * @param stackId - The Stack to count for.
 * @returns The row count, or `-1` when the count query answered nothing.
 */
async function countDependentDocuments(stackId: string): Promise<number> {
  const rows = await database().execute<{ total: number }>(
    sql`select count(*)::int as total from stack_documents where stack_id = ${stackId}`,
  );
  return rows[0]?.total ?? -1;
}

/**
 * This suite's own rows in `GET /stacks`, as `[domain, active]` pairs.
 *
 * Filtered by the file's domain prefix because other suites write to `stacks` in
 * parallel against their own databases, and a global "the list is exactly this" would
 * be an assertion about them rather than about this route.
 *
 * @param app - The app under test.
 * @returns One pair per fixture row.
 */
async function listedFixtures(app: Express): Promise<[string, unknown][]> {
  const listed = await request(app).get("/stacks");
  expect(listed.status).toBe(200);
  return (listed.body as Record<string, unknown>[])
    .filter((row) => String(row["domain"]).startsWith(currentDomainPrefix()))
    .map((row) => [String(row["domain"]), row["active"]]);
}

/** Create a Stack, delete it, and check the status and body are unchanged from before. */
async function answers204WithAnEmptyBodyAndStill404sAnUnknownId(): Promise<void> {
  const app = buildApp();
  const id = await createStack(app, uniqueDomain("delete"));

  const deleted = await request(app).delete(`/stacks/${id}`);
  expect(deleted.status).toBe(204);
  // Not `{}` and not `null`: FastAPI's 204 has no body at all.
  expect(deleted.text).toBe("");
  expect(deleted.body).toEqual({});

  // An id no Stack carries is the one delete that is still a refusal, unchanged from
  // before this route stopped deleting.
  const missingId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const missing = await request(app).delete(`/stacks/${missingId}`);
  expect(missing.status).toBe(404);
  expect(missing.body).toEqual({ detail: `Stack ${missingId} not found` });
}

/** The defect itself: the row, its flag and its dependent rows all survive. */
async function inactivatesAndDestroysNeitherTheRowNorItsDependents(): Promise<void> {
  const app = buildApp();
  const domain = uniqueDomain("inactivate");
  const created = await request(app).post("/stacks").send(createBody(domain));
  expect(created.status).toBe(201);
  const id = String(created.body.id);

  await insertDependentDocument(id);
  expect(await countDependentDocuments(id)).toBe(1);

  const deleted = await request(app).delete(`/stacks/${id}`);
  expect(deleted.status).toBe(204);
  expect(deleted.text).toBe("");

  const read = await request(app).get(`/stacks/${id}`);
  expect(read.status).toBe(200);
  expect(read.body.active).toBe(false);
  expect(read.body.domain).toBe(domain);
  expect(Object.keys(read.body)).toEqual([...RESPONSE_KEYS]);

  // Listing stays COMPLETE: a Stack an operator cannot see is one they cannot reactivate.
  expect(await listedFixtures(app)).toEqual([[domain, false]]);

  expect(
    await countDependentDocuments(id),
    "stack_documents rows must survive DELETE: that cascade is the data loss",
  ).toBe(1);
}

/** A retried DELETE is a no-op: 204, and no write at all. */
async function answersASecondDeleteWithAnIdempotent204(): Promise<void> {
  const app = buildApp();
  const id = await createStack(app, uniqueDomain("twice"));
  await insertDependentDocument(id);

  expect((await request(app).delete(`/stacks/${id}`)).status).toBe(204);
  const once = await request(app).get(`/stacks/${id}`);
  expect(once.body.active).toBe(false);

  // `updated_at` is the observable witness of a write: an idempotent no-op must not touch
  // the row, or a retried delete would reorder the listing.
  await tick();
  const twice = await request(app).delete(`/stacks/${id}`);
  expect(twice.status).toBe(204);
  expect(twice.text).toBe("");

  const after = await request(app).get(`/stacks/${id}`);
  expect(after.body.active).toBe(false);
  expect(after.body.updated_at, "a repeated DELETE must not rewrite the row").toBe(
    once.body.updated_at,
  );
  expect(await countDependentDocuments(id)).toBe(1);
}

/** `domain` is unique and the inactive row keeps it, so PATCH is the only way back. */
async function keepsTheDomainOnTheInactiveRowAndReactivatesThroughPatch(): Promise<void> {
  const app = buildApp();
  const domain = uniqueDomain("reactivate");
  const id = await createStack(app, domain);
  await insertDependentDocument(id);

  expect((await request(app).delete(`/stacks/${id}`)).status).toBe(204);

  const duplicate = await request(app).post("/stacks").send(createBody(domain));
  expect(duplicate.status, "an inactive Stack keeps its unique domain").toBe(409);
  expect(duplicate.body).toEqual({
    detail: `Stack with domain '${domain}' already exists`,
  });

  const reactivated = await request(app).patch(`/stacks/${id}`).send({ active: true });
  expect(reactivated.status).toBe(200);
  expect(reactivated.body.active).toBe(true);
  expect(reactivated.body.domain).toBe(domain);

  // Back in service, with the content it never lost.
  const read = await request(app).get(`/stacks/${id}`);
  expect(read.body.active).toBe(true);
  expect(await countDependentDocuments(id)).toBe(1);
}

const SUITE = "/stacks delete (live database)";

describe.skipIf(skipReason !== false)(SUITE, () => {
  // Start every test from a known state, and clean up even if a test failed before its
  // own assertions ran.
  beforeEach(deleteFixtureRows);

  it("returns 204 with a truly empty body, and an unknown id is still 404", answers204WithAnEmptyBodyAndStill404sAnUnknownId);
  it("marks the Stack inactive and destroys neither the row nor its dependents", inactivatesAndDestroysNeitherTheRowNorItsDependents);
  it("answers a second DELETE with an idempotent 204 that changes nothing", answersASecondDeleteWithAnIdempotent204);
  it("keeps the domain on the inactive row, so PATCH with active: true is the only way back", keepsTheDomainOnTheInactiveRowAndReactivatesThroughPatch);
});
