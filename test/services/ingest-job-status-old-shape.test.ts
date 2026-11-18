/**
 * @file test/services/ingest-job-status-old-shape.test.ts
 * @description A row written BEFORE these fields existed must read back unchanged.
 *
 * THE RISK THIS PINS (item 1, stored job rows). The status answer gained three optional
 * fields — `statusReason`, `stalledSince` and `compile.retryable`. If the read path (or
 * the store's shape guard) needed any of them, every row already in `wiki.ingest_job`
 * would become unreadable the moment this shipped, and an operator would lose the only
 * record of a job that already failed.
 *
 * So the payload is inserted RAW, exactly as the pre-change code stored it: no
 * `statusReason`, no `stalledSince`, and a `compile` with no `retryable`. Reading it back
 * must return the same object, and the public route must add nothing to a row that needs
 * no explanation. Inserting through `saveIngestJob` would prove the write path; the
 * question here is only what an OLD row does.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { readIngestJob } from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { withTenant } from "../../packages/wiki/src/dimensions/wiki/page-store.js";
import { readDurableJob } from "../fixtures/ingest-job-status-surface.js";
import { withStack, wikiReachable } from "../fixtures/stack-harness.js";

/** The job these cases store. Shape `ing_<ULID>`, as the registry mints them. */
const JOB_ID = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FA";

/**
 * A settled, cleanly finished payload EXACTLY as the pre-change code stored it.
 *
 * Deliberately a terminal row: a live one would legitimately gain `stalledSince` once the
 * bound passed, and that is not what this file is asking about.
 */
const OLD_SHAPE: IngestJob = {
  id: JOB_ID,
  source: "note.md",
  createdAt: "2024-05-01T10:00:00.000Z",
  updatedAt: "2024-05-01T10:00:02.000Z",
  ingest: {
    status: "unchanged",
    endedAt: "2024-05-01T10:00:01.000Z",
    attempts: [],
    message: "Content unchanged; nothing was written.",
  },
  compile: { status: "skipped", progress: null, message: "Compile skipped on request." },
};

/** An instant long after {@link OLD_SHAPE} settled, so a bound could not be the excuse. */
const A_YEAR_LATER = new Date("2025-05-01T10:00:00.000Z");

/**
 * The one table this suite cannot run without; the schema replay creates it with `pages`.
 *
 * Probed through the shared helper rather than a second time here, so this file and its
 * siblings cannot disagree about what "reachable" means.
 */
const harnessReachable = await wikiReachable("job-old-shape");

/**
 * Insert `payload` into `wiki.ingest_job` the way the store would, without going through
 * the store's own serializer.
 *
 * @param harness - The Stack this suite owns.
 * @param payload - The row payload, stored whole as `jsonb`.
 */
async function insertRaw(
  harness: { readonly db: Parameters<typeof readIngestJob>[0]; readonly stackId: string },
  payload: IngestJob,
): Promise<void> {
  await withTenant(harness.db, harness.stackId, async (tx) => {
    await tx.execute(sql`
      insert into wiki.ingest_job
        (stack_id, job_id, source, ingest_status, compile_status, payload, created_at, updated_at)
      values (
        ${harness.stackId}::uuid, ${payload.id}, ${payload.source},
        ${payload.ingest.status}, ${payload.compile.status},
        ${JSON.stringify(payload)}::jsonb,
        ${payload.createdAt}::timestamptz, ${payload.updatedAt}::timestamptz
      )
    `);
  });
}

describe.skipIf(!harnessReachable)("a row stored before the status fields existed", () => {
  it("reads back deep-equal through the store", async () => {
    await withStack("job-old-shape-store", async (harness) => {
      await insertRaw(harness, OLD_SHAPE);

      // The store's shape guard checks only `id`/`source`/`ingest`/`compile`, so an old row
      // is still a row. If any new field became required, this is where it would break.
      expect(await readIngestJob(harness.db, harness.stackId, JOB_ID)).toEqual(OLD_SHAPE);
    });
  }, 60_000);

  it("answers the route with exactly the stored payload, adding nothing", async () => {
    await withStack("job-old-shape-route", async (harness) => {
      await insertRaw(harness, OLD_SHAPE);
      const durable = {
        get: (jobId: string) => readIngestJob(harness.db, harness.stackId, jobId),
        list: async () => [],
      };

      const { status, json } = await readDurableJob(durable, JOB_ID, A_YEAR_LATER);

      expect(status).toBe(200);
      // Deep-equality, not "the fields I remembered": a settled row needs no explanation,
      // so a year later this answer must be the row itself.
      expect(json).toEqual(OLD_SHAPE);
      expect(json).not.toHaveProperty("statusReason");
      expect(json).not.toHaveProperty("stalledSince");
      expect(json.compile).not.toHaveProperty("retryable");
    });
  }, 60_000);
});
