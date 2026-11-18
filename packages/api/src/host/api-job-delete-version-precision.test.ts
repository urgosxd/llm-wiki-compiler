/**
 * @file packages/api/src/host/api-job-delete-version-precision.test.ts
 * @description S2: a row whose COLUMN `updated_at` is more precise than its payload must still
 * be deletable, and a row that genuinely changed must still be refused.
 *
 * ## The defect this pins
 *
 * The delete's version guard exists to answer "has the row changed since I read it?". It
 * answered it by comparing the column against `payload.updatedAt` — a string that has been
 * through JSON, and that any writer may have truncated to milliseconds. The verifier measured
 * the consequence: a row whose column carries MICROSECONDS (`now()` on the column, the payload
 * formatted with `MS`) can never be deleted, because every DELETE answers `409 job_changed`.
 * That is the reporter's own complaint — "no hay manera de eliminarlo" — reintroduced by a
 * precision mismatch, which is why it does not ship.
 *
 * ## Why the mismatch row is inserted RAW
 *
 * The store always writes the column from the payload, so `saveIngestJob` cannot produce this
 * shape; only a foreign writer can. The premise is therefore established by SQL, and the case
 * asserts the premise (column has sub-millisecond digits the payload does not) before it
 * asserts the delete — a case that silently inserted a matching row would prove nothing.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteIngestJobAtVersion, readIngestJobVersion, saveIngestJob } from "@repo/wiki/job-store";
import type { IngestJob } from "@repo/wiki/job-types";
import { withTenant } from "../../../wiki/src/dimensions/wiki/page-store.js";
import {
  ingestJobRows,
  recentStamp,
  rowsFor,
  runningJobRow,
  settledJobRow,
  useIngestJobSurface,
} from "../../../../test/fixtures/ingest-job-rows.js";
import type { KgPostgresHarness } from "../../../../test/fixtures/kg-postgres.js";
import { withRecoveryHost } from "./recovery-host.js";
import { wikiReachable } from "../../../../test/fixtures/stack-harness.js";

/** The job these cases store. Shape `ing_<ULID>`, as the registry mints them. */
const JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FH";

/** A one-minute stuck bound, so "inside the bound" is a fact of the stamps. */
const surface = useIngestJobSurface("api-job-version-precision", "60000");

/** Is the wiki schema reachable? A skip names the database rather than looking like a pass. */
const harnessReachable = await wikiReachable("api-job-version-precision");

/**
 * Insert a row exactly as the verifier reproduced the defect.
 *
 * The column takes the payload's instant plus microseconds — the same millisecond, with
 * digits the payload cannot carry — which is what `now()` on the column and a `MS`-formatted
 * payload produce for a writer that does not go through the store.
 *
 * @param harness - The suite's Stack.
 * @param job - The payload to store.
 */
async function insertMismatchedRow(
  harness: KgPostgresHarness,
  job: IngestJob,
): Promise<void> {
  await withTenant(harness.db, harness.stackId, async (tx) => {
    await tx.execute(sql`
      insert into wiki.ingest_job
        (stack_id, job_id, source, ingest_status, compile_status, payload, created_at, updated_at)
      values (
        ${harness.stackId}::uuid, ${job.id}, ${job.source},
        ${job.ingest.status}, ${job.compile.status},
        ${JSON.stringify(job)}::jsonb,
        ${job.createdAt}::timestamptz,
        ${job.updatedAt}::timestamptz + interval '437 microseconds'
      )
    `);
  });
}

/**
 * The column's own version, as the database prints it.
 *
 * @param harness - The suite's Stack.
 * @param jobId - The job to read.
 * @returns The column value in ISO 8601, microseconds included.
 */
async function columnVersionOf(
  harness: KgPostgresHarness,
  jobId: string,
): Promise<string> {
  const rows = await withTenant(harness.db, harness.stackId, async (tx) =>
    tx.execute<{ version: string }>(sql`
      select to_json(updated_at) #>> '{}' as version
      from wiki.ingest_job
      where stack_id = ${harness.stackId} and job_id = ${jobId}
    `),
  );
  return String(rows[0]?.version);
}

describe.skipIf(!harnessReachable)("a row the payload cannot describe exactly", () => {
  it("deletes a row whose column carries microseconds the payload does not", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      const payload = settledJobRow(JOB, recentStamp());
      await insertMismatchedRow(harness, payload);

      // THE PREMISE, asserted: the column holds digits the payload cannot, so this row is the
      // shape that used to be undeletable rather than a row that happens to match.
      const version = await columnVersionOf(harness, JOB);
      expect(version).toContain(".");
      expect(version.split(".")[1]?.slice(0, 6)).toMatch(/^\d{6}/);
      expect(payload.updatedAt.split(".")[1]).toMatch(/^\d{3}Z$/);

      const res = await host.del(JOB);

      // The envelope AND the status: on the defect the body named `job_changed`, which is what
      // makes this row permanently undeletable rather than merely refused once.
      expect(await res.json()).toEqual({ deleted: true, jobId: JOB });
      expect(res.status).toBe(200);
      expect(await rowsFor(harness, JOB)).toEqual([]);
    });
  }, 60_000);

  it("still refuses that shape while it is inside the bound, byte-identically", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      await insertMismatchedRow(harness, runningJobRow(JOB, recentStamp()));
      const before = await ingestJobRows(harness);

      const res = await host.del(JOB);

      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("job_still_working");
      // The refusal that survives the fix: a row this shape is still refused while it may be
      // running, and refused without being touched.
      expect(await ingestJobRows(harness)).toEqual(before);
      expect(before).toHaveLength(1);
    });
  }, 60_000);
});

describe.skipIf(!harnessReachable)("a row that genuinely changed", () => {
  it("refuses the version it was read at and leaves the newer row byte-identical", async () => {
    // The service level is the only place this is deterministic: the comparison under test IS
    // "the row moved between the read and the delete", and a case that raced the route would
    // pass or fail on timing. The route's mapping of this refusal is `409 job_changed`.
    const harness = surface.stack().harness;
    await saveIngestJob(harness.db, harness.stackId, settledJobRow(JOB, recentStamp()));
    const stored = await readIngestJobVersion(harness.db, harness.stackId, JOB);
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    // A GENUINE change between the read and the delete: same id, newer row version.
    const newer = { ...stored.job, updatedAt: new Date(Date.now() + 1_000).toISOString() };
    await saveIngestJob(harness.db, harness.stackId, newer);
    const before = await ingestJobRows(harness);

    expect(
      await deleteIngestJobAtVersion(harness.db, harness.stackId, JOB, stored.version),
    ).toBe(false);
    // The hole the fix must not have opened: a moved row is still refused, and still untouched.
    expect(await ingestJobRows(harness)).toEqual(before);
    expect(before).toHaveLength(1);
  }, 60_000);
});
