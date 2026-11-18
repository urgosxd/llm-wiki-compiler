/**
 * @file test/services/ingest-job-delete-refusal-invariant.test.ts
 * @description S2: a recovery verb refused by the stuck bound writes NOTHING.
 *
 * ## Why this is a whole-row assertion on both verbs
 *
 * The reporter asks for two verbs, "eliminarlo" and "que reintente", and the danger of adding
 * them badly is asymmetric: a refuse that still writes is worse than no verb at all, because
 * the operator is told nothing happened while the record has moved. A counter alone cannot see
 * an UPDATE — a rewritten `updated_at`, a status flip or a replaced `jsonb` payload all leave
 * `count(*)` unchanged — so every row is compared as its own canonical text
 * (`to_jsonb(t)::text`, through `test/fixtures/tenant-snapshot.ts`) and the count is compared
 * beside it.
 *
 * ## Why the row is inside the bound
 *
 * `isStalled === false` means the job may be running right now: exactly the row neither verb
 * may touch. A backdated row is refused by the same policy but for a different reason, so it
 * would prove less.
 *
 * ## Why BOTH verbs share one assertion
 *
 * They answer the same envelope for the same fact, and two hand-written copies of the
 * comparison could drift apart — one of them silently gaining a tolerance the other kept. The
 * assertion is written once and pointed at each verb.
 */
import { describe, expect, it } from "vitest";
import {
  ingestJobRows,
  recentStamp,
  runningJobRow,
  storeRow,
  useIngestJobSurface,
} from "../../../../test/fixtures/ingest-job-rows.js";
import { withRecoveryHost, type RecoveryHost } from "./recovery-host.js";
import { wikiReachable } from "../../../../test/fixtures/stack-harness.js";

/** The job these cases store. Shape `ing_<ULID>`, as the registry mints them. */
const JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FI";

/** A one-minute stuck bound, so "inside the bound" is a fact of the stamps. */
const surface = useIngestJobSurface("job-delete-refusal-invariant", "60000");

/** Is the wiki schema reachable? A skip names the database rather than looking like a pass. */
const harnessReachable = await wikiReachable("job-delete-refusal-invariant");

/**
 * Drive one refused verb over a live row and assert the Stack's rows are byte-identical.
 *
 * @param verb - The request to make against the job inside the bound.
 */
async function refusedAndInert(verb: (host: RecoveryHost) => Promise<Response>): Promise<void> {
  const harness = surface.stack().harness;
  await withRecoveryHost(surface, async (host) => {
    await storeRow(harness, runningJobRow(JOB, recentStamp()));
    const before = await ingestJobRows(harness);
    expect(before).toHaveLength(1);

    const res = await verb(host);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("job_still_working");
    // Whole rows, in the same order, one-to-one: state, `updated_at` and payload together.
    expect(await ingestJobRows(harness)).toEqual(before);
    expect((await ingestJobRows(harness)).length).toBe(before.length);
  });
}

describe.skipIf(!harnessReachable)("a recovery verb refused while the job may be running", () => {
  it("DELETE answers 409 and leaves every row byte-identical", async () => {
    await refusedAndInert((host) => host.del(JOB));
  }, 60_000);

  it("RETRY answers 409 and leaves every row byte-identical", async () => {
    await refusedAndInert((host) => host.retry(JOB));
  }, 60_000);
});
