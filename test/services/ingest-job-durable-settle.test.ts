/**
 * @file test/services/ingest-job-durable-settle.test.ts
 * @description A job that settles in memory must settle in `wiki.ingest_job` as well.
 *
 * THE DEFECT THESE CASES PIN. The measured hang was not a job that failed to finish:
 * the in-memory job settled `failed`, the terminal record reached
 * `.llmwiki/ingest-failures.jsonl`, and the durable row kept reporting
 * `ingest_status=running` / `compile_status=queued` with a frozen `updated_at`. The
 * mirror wrote every transition fire-and-forget, so an OLDER snapshot could commit
 * after a newer one and win.
 *
 * Two halves fix it, and each case below is aimed at one of them:
 *
 *  - the `updated_at` guard in `saveIngestJob`'s upsert, which refuses a snapshot that
 *    is strictly older than the stored row (case A, and case C for the refusal's
 *    footprint) — a chain alone cannot make these pass;
 *  - the per-job write chain in `createDurableJobRegistry`, which keeps the ordinary
 *    path in patch order (case B), so the guard is a backstop rather than the routine.
 *
 * Terminality is read from the registry's own `isSettled` predicate, never from a list
 * of status strings copied here: a copy would keep passing after the predicate changed.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  createDurableJobRegistry,
  type DurableRegistryOptions,
} from "../../packages/wiki/src/services/ingest/jobs/durable-registry.js";
import { readIngestJob, saveIngestJob } from "../../packages/wiki/src/services/ingest/jobs/job-store.js";
import { createJobRegistry, isSettled } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { TERMINAL_ERROR } from "../fixtures/ingest-job-mirror-suite.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { withStack, wikiReachable } from "../fixtures/stack-harness.js";

/** The job these cases store. Shape `ing_<ULID>`, as the registry mints them. */
const JOB_ID = "ing_01J8ZQK4N7Q9V0R2T4X6B8D0FA";

/**
 * Clock-relative base for every stamp in this file, computed ONCE.
 *
 * `registry.ts` evicts a SETTLED job whose last transition is older than `JOB_TTL_MS`
 * (one hour), and the mirror reads the snapshot back from that same registry. Fixed
 * 2026-01-01 stamps therefore made the job vanish before the third write, which starved
 * the chain rather than testing it. Relative stamps keep the job live whatever the wall
 * clock says, and nothing here depends on how much time the assertions take.
 */
const BASE_MS = Date.now();

/**
 * An ISO-8601 instant `seconds` after the base above.
 *
 * @param seconds - Offset from {@link BASE_MS}.
 * @returns The stamp, as the registry and the store both write them.
 */
const at = (seconds: number): string => new Date(BASE_MS + seconds * 1000).toISOString();

/** Long enough for three sequenced round trips; fail rather than hang. */
const SETTLE_TIMEOUT_MS = 10_000;

/**
 * The one table this suite cannot run without.
 *
 * The shared `wikiReachable` probes `wiki.pages`, which the same schema replay creates
 * in the same pass, so a reachable wiki schema is a reachable job table. Probing here
 * anyway would be a third copy of that helper for no extra answer.
 */
const harnessReachable = await wikiReachable("job-settle");

/**
 * Build a job snapshot.
 *
 * @param updatedAt - The transition timestamp the guard compares.
 * @param ingest - Ingest dimension status.
 * @param compile - Compile dimension status.
 * @returns A complete, immutable snapshot.
 */
function snapshot(
  updatedAt: string,
  ingest: IngestJob["ingest"]["status"],
  compile: IngestJob["compile"]["status"],
): IngestJob {
  return {
    id: JOB_ID,
    source: "note.md",
    createdAt: at(0),
    updatedAt,
    ingest: { status: ingest, attempts: [] },
    compile: { status: compile, progress: null },
  };
}

/**
 * The whole stored row, as canonical text: EVERY column, not the ones a case names.
 *
 * @param harness - Handle on the database the Stack lives in.
 * @param jobId - The row's job id.
 * @returns The serialized row, or `undefined` when this Stack has no such row.
 */
async function storedRow(harness: KgPostgresHarness, jobId: string): Promise<string | undefined> {
  const rows = await harness.db.execute<{ row: string }>(sql`
    select to_jsonb(t)::text as row from wiki.ingest_job t
    where t.stack_id = ${harness.stackId}::uuid and t.job_id = ${jobId}
  `);
  return rows[0]?.row;
}

/**
 * How many durable job rows this Stack owns.
 *
 * @param harness - Handle on the database the Stack lives in.
 * @returns The row count.
 */
async function storedCount(harness: KgPostgresHarness): Promise<number> {
  const rows = await harness.db.execute<{ total: number }>(sql`
    select count(*)::int as total from wiki.ingest_job
    where stack_id = ${harness.stackId}::uuid
  `);
  return rows[0]?.total ?? 0;
}

/**
 * Wrap a handle so its FIRST write becomes durable last, plus the finish order.
 *
 * The delay is keyed to the entry number, not to a race, so "the older snapshot commits
 * last" is guaranteed by construction rather than hoped for.
 *
 * @param inner - The real handle every write goes through.
 * @returns The wrapped handle and the order its writes finished in.
 */
function outOfOrderWrites(inner: DurableRegistryOptions["db"]): {
  db: DurableRegistryOptions["db"];
  finished: number[];
} {
  const finished: number[] = [];
  let entered = 0;
  const db = {
    execute: (...args: Parameters<DurableRegistryOptions["db"]["execute"]>) => inner.execute(...args),
    transaction: async (run: Parameters<DurableRegistryOptions["db"]["transaction"]>[0]) => {
      entered += 1;
      const entry = entered;
      if (entry === 1) await new Promise((resolve) => setTimeout(resolve, 75));
      try {
        return await inner.transaction(run);
      } finally {
        finished.push(entry);
      }
    },
  };
  return { db: db as unknown as DurableRegistryOptions["db"], finished };
}

/** Case A: a strictly older snapshot is refused once a terminal one has landed. */
async function guardRefusesOlderSnapshot(): Promise<void> {
  await withStack("job-settle-guard", async (harness) => {
    const terminal = snapshot(at(2), "failed", "skipped");
    const stale = snapshot(at(1), "running", "queued");
    // Terminality comes from the registry's predicate, so this case cannot disagree
    // with the code that decides when a job is finished.
    expect(isSettled(terminal)).toBe(true);
    expect(isSettled(stale)).toBe(false);

    await saveIngestJob(harness.db, harness.stackId, terminal);
    // The older snapshot arrives LAST, which is what a delayed commit looks like.
    await saveIngestJob(harness.db, harness.stackId, stale);

    // `readIngestJob` answers with the stored snapshot whole, so this one assertion
    // covers ingest_status, compile_status, payload and updated_at together.
    expect(await readIngestJob(harness.db, harness.stackId, JOB_ID)).toEqual(terminal);
  });
}

/** Case B: the chain, with a handle whose first write lands last by construction. */
async function chainSettlesOnLastSnapshot(): Promise<void> {
  await withStack("job-settle-chain", async (harness) => {
    const handle = outOfOrderWrites(harness.db);
    const registry = createDurableJobRegistry(createJobRegistry(), {
      db: handle.db,
      stackId: harness.stackId,
    });
    const job = registry.create("note.md", new Date(at(0)));
    registry.patchIngest(
      job.id,
      { status: "failed", error: TERMINAL_ERROR },
      new Date(at(1)),
    );
    registry.patchCompile(job.id, { status: "skipped" }, new Date(at(2)));

    await vi.waitFor(() => expect(handle.finished).toHaveLength(3), {
      timeout: SETTLE_TIMEOUT_MS,
    });
    const stored = await readIngestJob(harness.db, harness.stackId, job.id);
    // The row equals the LIVE snapshot, which is the last one any patch produced.
    expect(stored).toEqual(registry.get(job.id));
    expect(stored !== undefined && isSettled(stored)).toBe(true);
  });
}

/** Case C: a refused write has no footprint on the row or on the counts. */
async function refusalLeavesRowUntouched(): Promise<void> {
  await withStack("job-settle-refusal", async (harness) => {
    const terminal = snapshot(at(2), "succeeded", "succeeded");
    const stale = snapshot(at(1), "running", "queued");
    await saveIngestJob(harness.db, harness.stackId, terminal);
    const before = await storedRow(harness, JOB_ID);
    const countBefore = await storedCount(harness);

    await saveIngestJob(harness.db, harness.stackId, stale);

    // Whole-row equality, not one column: a refusal that rewrote any column, bumped
    // updated_at, or inserted a second row would show up here.
    expect(await storedRow(harness, JOB_ID)).toBe(before);
    expect(await storedCount(harness)).toBe(countBefore);
  });
}

/** Case D: an EQUAL timestamp APPLIES — the guard must not over-reject. */
async function equalTimestampApplies(): Promise<void> {
  await withStack("job-settle-equal", async (harness) => {
    const queued = snapshot(at(5), "running", "queued");
    const settled = snapshot(at(5), "failed", "skipped");
    await saveIngestJob(harness.db, harness.stackId, queued);
    // Two patches stamped in the same millisecond: rejecting the second would hand the
    // row to whichever write arrived FIRST, which is the older patch.
    await saveIngestJob(harness.db, harness.stackId, settled);

    expect(await readIngestJob(harness.db, harness.stackId, JOB_ID)).toEqual(settled);
  });
}

/** Case E: an older NON-terminal write is refused and leaves the row byte-identical. */
async function olderNonTerminalIsRefused(): Promise<void> {
  await withStack("job-settle-nonterm", async (harness) => {
    await saveIngestJob(harness.db, harness.stackId, snapshot(at(9), "running", "running"));
    const before = await storedRow(harness, JOB_ID);

    await saveIngestJob(harness.db, harness.stackId, snapshot(at(2), "queued", "queued"));

    // A live row can be regressed too, not only a terminal one, and the refusal must
    // touch no column at all.
    expect(await storedRow(harness, JOB_ID)).toBe(before);
  });
}

describe.skipIf(!harnessReachable)("the durable job mirror", () => {
  it("refuses an older snapshot once a terminal one has landed", guardRefusesOlderSnapshot);
  it("settles on the LAST snapshot the registry produced", chainSettlesOnLastSnapshot);
  it("leaves the row and its count untouched when a write is refused", refusalLeavesRowUntouched);
  it("applies a write whose timestamp EQUALS the stored row's", equalTimestampApplies);
  it("refuses an older NON-terminal write, leaving the row byte-identical", olderNonTerminalIsRefused);
});
