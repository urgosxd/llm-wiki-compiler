/**
 * @file test/services/ingest-job-status-derived-reason.test.ts
 * @description S3 over the public read: a row that stopped moving reports a DERIVED reason,
 * and a row that failed reports the OBSERVED one.
 *
 * ## Why the `kind` is the assertion
 *
 * "la informacion que da es muy pobre" is not answered by any explanation; it is answered by an
 * explanation an operator can act on. "The upload failed" and "the owning process may have
 * stopped" send them to two completely different places, and a single reason string would let a
 * client render both the same way. So each case pins `kind` alongside the text, and pins that a
 * stalled row also carries the instant it stopped (`stalledSince`) — the fact a reader needs to
 * decide whether waiting is still reasonable.
 *
 * ## Why both rows live in one case
 *
 * The distinction IS the requirement. Two separate cases could both pass with a reader that
 * labelled everything `derived`, or nothing at all; asserting the pair together is what makes
 * the answer discriminating rather than merely non-empty.
 */
import { describe, expect, it } from "vitest";
import type { IngestJob } from "@repo/wiki/job-types";
import {
  runningJobRow,
  settledJobRow,
  silentStamp,
  storeRow,
  useIngestJobSurface,
} from "../../../../test/fixtures/ingest-job-rows.js";
import { withRecoveryHost } from "./recovery-host.js";
import { wikiReachable } from "../../../../test/fixtures/stack-harness.js";

/** A row left mid-ingest, silent well past the bound. */
const STALLED_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FJ";

/** A row whose ingest reported its own error. */
const FAILED_JOB = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FK";

/** The error text the failed row recorded, which is what the read must hand back. */
const ERROR_TEXT = "ENOENT: no such file or directory, open 'note.md'";

/** A one-minute stuck bound, so ten minutes of silence is past it by construction. */
const surface = useIngestJobSurface("job-status-derived-reason", "60000");

/** Is the wiki schema reachable? A skip names the database rather than looking like a pass. */
const harnessReachable = await wikiReachable("job-status-derived-reason");

/** A settled row that failed, carrying the error text a reader has to be handed. */
function failedRow(id: string): IngestJob {
  const stamp = silentStamp();
  return {
    ...settledJobRow(id, stamp),
    ingest: { status: "failed", endedAt: stamp, attempts: [], error: ERROR_TEXT },
  };
}

/** What the status route answered, narrowed to the two fields under test. */
interface StatusAnswer {
  statusReason?: { reason: string; kind: string };
  stalledSince?: string;
}

/**
 * Read one job through the public status route.
 *
 * @param read - The route the case drives, bound to its Stack.
 * @param jobId - The job to read.
 * @returns The fields these cases assert on, asserting the 200 on the way.
 */
async function answerFor(
  read: (jobId: string) => Promise<Response>,
  jobId: string,
): Promise<StatusAnswer> {
  const res = await read(jobId);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusAnswer;
}

describe.skipIf(!harnessReachable)("the reason a job's status carries", () => {
  it("derives a stall for a silent row and observes a recorded failure", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      const stalled = runningJobRow(STALLED_JOB, silentStamp());
      await storeRow(harness, stalled);
      await storeRow(harness, failedRow(FAILED_JOB));

      const derived = await answerFor(host.read, STALLED_JOB);
      expect(derived.statusReason).toEqual({
        reason: `no progress since ${stalled.updatedAt}; the owning process may have stopped`,
        kind: "derived",
      });
      // The instant it stopped is a separate fact, not folded into the sentence: a reader
      // deciding whether to wait needs the timestamp itself.
      expect(derived.stalledSince).toBe(stalled.updatedAt);

      const observed = await answerFor(host.read, FAILED_JOB);
      // The row's OWN error text, not an inference about silence — even though that row is
      // silent too, and a reader that preferred the inference would lose the actual cause.
      expect(observed.statusReason).toEqual({ reason: ERROR_TEXT, kind: "observed" });
    });
  }, 60_000);
});
