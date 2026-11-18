/**
 * @file test/api-ingest-jobs-concurrent-settle.test.ts
 * @description S1, the headline regression: two CONCURRENT ingests of one resource must BOTH
 * reach a terminal state — in Postgres as well as in the live registry.
 *
 * ## What this reproduces
 *
 * The report is "al ingestar 2 veces un recurso se colgo el job". The measured cause was not a
 * lock leak: the loser of the pair failed on lock contention and its TERMINAL snapshot never
 * reached `wiki.ingest_job`, so the durable row kept the `queued` creation snapshot with a
 * frozen `updated_at` and the operator's status read never changed again. Five concurrent
 * pairs on a real database produced four such rows, and sixty seconds of polling moved none
 * of them.
 *
 * ## Why the pair is concurrent and the assertion is not
 *
 * The pair is fired with `Promise.all` so the two requests really do contend. The assertion is
 * a POLL to a terminal state rather than a fixed order, because which request wins the lock is
 * the machine's business — the requirement is that neither job is left behind. The bound is
 * explicit (`SETTLE_BOUND_MS`), so a job that never settles fails this case instead of hanging
 * it.
 *
 * ## Why terminality is asked of `isSettled`
 *
 * A hand-written list of status strings is the copy that drifts. The predicate the registry
 * itself uses is the only honest answer to "will this job move again", and it counts
 * `compile: busy` as settled — the state the loser of a contended pair ends in.
 */
import { describe, expect, it } from "vitest";
import { readIngestJob } from "@repo/wiki/job-store";
import { isSettled } from "@repo/wiki/job-registry";
import type { IngestJob } from "@repo/wiki/job-types";
import { pause, useIngestJobSurface } from "../../../../test/fixtures/ingest-job-rows.js";
import { withRecoveryHost, type RecoveryHost } from "./recovery-host.js";
import type { KgPostgresHarness } from "../../../../test/fixtures/kg-postgres.js";
import { wikiReachable } from "../../../../test/fixtures/stack-harness.js";

/** How many concurrent pairs this case reproduces. */
const PAIRS = 5;

/** How long ONE job may take to reach a terminal state before the case fails. */
const SETTLE_BOUND_MS = 60_000;

/** How often a poll re-reads the job it is waiting on. */
const POLL_MS = 250;

/** The one resource both requests of a pair ingest. */
const SOURCE = "note.md";

/** A one-minute stuck bound, so nothing here depends on the environment's default. */
const surface = useIngestJobSurface("concurrent-settle", "60000");

/** Is the wiki schema reachable? A skip names the database rather than looking like a pass. */
const harnessReachable = await wikiReachable("concurrent-settle");

/**
 * Accept one async ingest and hand back the id it answered with.
 *
 * @param host - The running host.
 * @returns The new job's id, asserting the 202 contract on the way.
 */
async function acceptOne(host: RecoveryHost): Promise<string> {
  const res = await host.post({ source: SOURCE, async: true });
  expect(res.status).toBe(202);
  const accepted = (await res.json()) as { jobId: string };
  return accepted.jobId;
}

/**
 * Poll one job until `isSettled` accepts it, or the bound expires.
 *
 * @param host - The running host.
 * @param jobId - The job to watch.
 * @returns The settled snapshot, or `undefined` when the bound expired first.
 */
async function settleWithin(host: RecoveryHost, jobId: string): Promise<IngestJob | undefined> {
  const deadline = Date.now() + SETTLE_BOUND_MS;
  let last: IngestJob | undefined;
  while (Date.now() < deadline) {
    const res = await host.read(jobId);
    if (res.status === 200) {
      last = (await res.json()) as IngestJob;
      if (isSettled(last)) return last;
    }
    await pause(POLL_MS);
  }
  // Reported rather than swallowed: the state it stuck in is the evidence.
  expect(last, `ingest job '${jobId}' never answered a status read`).toBeDefined();
  return undefined;
}

/**
 * Run one pair and report everything that was left behind.
 *
 * @param host - The running host.
 * @param harness - The Stack the host mirrors into.
 * @param pair - Pair number, for a readable failure.
 * @returns One entry per job that did not settle, in either view.
 */
async function pairProblems(
  host: RecoveryHost,
  harness: KgPostgresHarness,
  pair: number,
): Promise<string[]> {
  const ids = await Promise.all([acceptOne(host), acceptOne(host)]);
  const problems: string[] = [];
  if (new Set(ids).size !== 2) problems.push(`pair ${pair}: both requests answered the same job id`);
  for (const id of ids) {
    const settled = await settleWithin(host, id);
    if (settled === undefined) {
      problems.push(`pair ${pair}: ${id} never reached a terminal state over the API`);
      continue;
    }
    // The durable half of S1: the live view settling is not the requirement. The row another
    // process reads must be terminal too, which is what a frozen `queued` snapshot defeated.
    const row = await readIngestJob(harness.db, harness.stackId, id);
    if (row === undefined) problems.push(`pair ${pair}: ${id} settled in memory and has no row`);
    else if (!isSettled(row)) {
      problems.push(`pair ${pair}: ${id} durable row stayed ${row.ingest.status}/${row.compile.status}`);
    }
  }
  return problems;
}

describe.skipIf(!harnessReachable)("two concurrent ingests of one resource", () => {
  it("settles BOTH jobs of every pair, in memory and in Postgres", async () => {
    await withRecoveryHost(surface, async (host) => {
      const harness = surface.stack().harness;
      const problems: string[] = [];
      for (let pair = 1; pair <= PAIRS; pair += 1) {
        problems.push(...(await pairProblems(host, harness, pair)));
      }
      expect(problems, "S1: a job was left where it will never move again").toEqual([]);
    });
  }, 300_000);
});
