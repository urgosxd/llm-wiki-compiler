/**
 * @file test/fixtures/ingest-job-status-surface.ts
 * @description The doubles a job status read needs in order to go THROUGH the route
 * without a database, defined once.
 *
 * WHY THEY EXIST. The status surfaces read a durable row, so the honest way to test them
 * is with a row. Rather than requiring Postgres, the write side is given a handle that
 * captures the payload `saveIngestJob` hands the driver, and that captured payload is
 * then served to the route as the row. What is asserted is therefore the bytes that would
 * be committed — not a member re-implemented by the test.
 *
 * NO ASSERTIONS LIVE HERE. These helpers only put the code under test into the state a
 * case wants and hand back what the route wrote; every claim stays in the case that makes
 * it, so a reader can see which test proves what.
 */
import type { ServerResponse } from "node:http";
import type { DatabaseHandle } from "@repo/foundation";
import { createJobRegistry, type JobRegistry } from "../../packages/wiki/src/services/ingest/jobs/registry.js";
import type { IngestJob } from "../../packages/wiki/src/services/ingest/jobs/types.js";
import { handleApiIngestJobs, INGEST_JOBS_PATH } from "../../packages/wiki/src/viewer/api-ingest-jobs.js";

/** What the route wrote, without a socket. */
export interface Recorded {
  readonly res: ServerResponse;
  /** The status the route set. */
  statusCode(): number;
  /** The raw body text the route wrote. */
  body(): string;
}

/**
 * Build the minimum `ServerResponse` the viewer's JSON writers need.
 *
 * @returns The fake response and its captured status and body.
 */
export function recordingResponse(): Recorded {
  let status = 0;
  let body = "";
  const fake = {
    set statusCode(value: number) {
      status = value;
    },
    get statusCode(): number {
      return status;
    },
    setHeader: (): void => undefined,
    end: (chunk: string): void => {
      body = chunk;
    },
  };
  return {
    res: fake as unknown as ServerResponse,
    statusCode: () => status,
    body: () => body,
  };
}

/**
 * Every string parameter of `statement` that parses as a job snapshot.
 *
 * Drizzle inlines a primitive parameter as the chunk itself and keeps a `value`-carrying
 * chunk for the rest, so both shapes are collected. Only the payload is JSON, so parsing
 * is what identifies it: this stays correct if the statement gains a parameter, and it
 * never guesses at an index.
 *
 * @param statement - The fragment `withTenant`'s work handed to `execute`.
 * @returns The job snapshots the statement would have written.
 */
function payloadsIn(statement: unknown): IngestJob[] {
  const values: unknown[] = [];
  const walk = (chunk: unknown): void => {
    if (chunk === null || chunk === undefined) return;
    if (typeof chunk !== "object") {
      values.push(chunk);
      return;
    }
    const nested = (chunk as { queryChunks?: unknown }).queryChunks;
    if (Array.isArray(nested)) {
      for (const inner of nested) walk(inner);
      return;
    }
    if ("value" in chunk) values.push((chunk as { value: unknown }).value);
  };
  walk(statement);
  return values.flatMap((value) => {
    if (typeof value !== "string" || !value.startsWith("{")) return [];
    const candidate = JSON.parse(value) as
      | { id?: unknown; ingest?: unknown; compile?: unknown }
      | null;
    return candidate !== null && typeof candidate === "object"
      && candidate.id !== undefined && candidate.ingest !== undefined
      && candidate.compile !== undefined
      ? [JSON.parse(value) as IngestJob]
      : [];
  });
}

/** A handle that records every job payload the store hands to the driver. */
export interface CapturingHandle {
  readonly db: DatabaseHandle;
  /** Every captured payload, in the order the driver was asked to commit it. */
  all(): readonly unknown[];
  /** The payload the row would hold after a chain and an `updated_at` guard. */
  last(): IngestJob | undefined;
}

/**
 * Build the capturing handle.
 *
 * `withTenant` opens one transaction per write and runs the statement inside it, so the
 * handle only has to provide that transaction and an `execute` that keeps the payloads.
 *
 * @returns The handle, plus the payloads it captured.
 */
export function capturingHandle(): CapturingHandle {
  const captured: IngestJob[] = [];
  const execute = async (statement: unknown): Promise<unknown[]> => {
    captured.push(...payloadsIn(statement));
    return [];
  };
  const tx = { execute, transaction: async (run: (inner: unknown) => Promise<unknown>) => run(tx) };
  return {
    db: { execute, transaction: tx.transaction } as unknown as DatabaseHandle,
    all: () => [...captured],
    last: () => captured[captured.length - 1],
  };
}

/** The durable reads a host injects, served from captured row payloads. */
export function durableReadsOf(rows: () => readonly unknown[]) {
  return {
    list: async (): Promise<readonly unknown[]> => rows(),
    get: async (jobId: string): Promise<unknown | undefined> =>
      rows().find((row) => (row as { id?: unknown }).id === jobId),
  };
}

/** A job read as the route answered it. */
export interface JobRead {
  /** The status the route set. */
  readonly status: number;
  /** The parsed body. */
  readonly json: Record<string, unknown>;
}

/** The durable reads a host injects, as one Stack's store provides them. */
export interface DurableRows {
  /** One job by id, or `undefined` when this Stack never had it. */
  get(jobId: string): Promise<unknown | undefined>;
  /** Every retained job for this Stack. */
  list(limit: number): Promise<readonly unknown[]>;
}

/** Answer one job read through the route, from the host's LIVE registry. */
export async function readLiveJob(
  registry: JobRegistry,
  jobId: string,
  now: Date,
): Promise<JobRead> {
  const recorded = recordingResponse();
  await handleApiIngestJobs(recorded.res, new URL(`http://viewer.test${INGEST_JOBS_PATH}/${jobId}`), {
    ingestJobs: registry,
    now: () => now,
  });
  return { status: recorded.statusCode(), json: JSON.parse(recorded.body()) };
}

/**
 * Answer one job read through the route, from a DURABLE store.
 *
 * The live registry is left empty, so the store — not process memory — is what answers,
 * which is the only way a case can prove what a STORED row reads back as.
 *
 * @param durable - The store the route reads from.
 * @param jobId - The job asked for.
 * @param now - The instant the read pretends it is.
 * @returns The status and parsed body the route wrote.
 */
export async function readDurableJob(
  durable: DurableRows,
  jobId: string,
  now: Date,
): Promise<JobRead> {
  const recorded = recordingResponse();
  await handleApiIngestJobs(recorded.res, new URL(`http://viewer.test${INGEST_JOBS_PATH}/${jobId}`), {
    ingestJobs: createJobRegistry(),
    durableIngestJobs: durable,
    now: () => now,
  });
  return { status: recorded.statusCode(), json: JSON.parse(recorded.body()) };
}

/** Answer one job read through the route, from a row the case already holds. */
export async function readStoredJob(row: unknown, jobId: string, now: Date): Promise<JobRead> {
  return readDurableJob(durableReadsOf(() => [row]), jobId, now);
}
