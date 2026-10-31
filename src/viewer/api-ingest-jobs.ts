/**
 * @file src/viewer/api-ingest-jobs.ts
 * @description `GET /api/ingest/jobs` and `GET /api/ingest/jobs/:id` -- the read
 * side of an async ingest job.
 *
 * ## Why these live on the VIEWER and not beside the mutation endpoints
 *
 * `POST /api/ingest` is served by `src/host/api.ts`, which is mounted BEFORE the
 * viewer and therefore never passes `applySecurityHeaders` or
 * `validateOriginHeaders` (`src/host/server.ts`). Mounting the job reads there
 * would publish a project's ingest history with no origin policy and no security
 * headers at all.
 *
 * The viewer applies both before dispatching, so a route registered here inherits
 * them by construction rather than by remembering to call them. That is the whole
 * reason for the split: the mutation route keeps its existing behaviour, and the
 * new reads land on the side where the checks already run.
 *
 * ## Read-only, deliberately
 *
 * Nothing here starts, retries, or cancels a job. A retry is a new POST, and
 * cancelling is not offered at all: the mutation lock is fail-fast, so a job that
 * is running is a process already inside the transaction, and "cancel" would mean
 * killing a half-applied write.
 */

import type { ServerResponse } from "node:http";
import { writeJson, writeJsonError } from "./respond.js";
import type { JobRegistry } from "../services/ingest/jobs/registry.js";
import { stackIdProblem } from "../utils/stack-id.js";

/** How many jobs a durable listing returns. Matches the MCP tool default. */
const DURABLE_LIST_LIMIT = 50;

/** Path of the collection endpoint. */
export const INGEST_JOBS_PATH = "/api/ingest/jobs";

/** Prefix under which a single job is addressed. */
export const INGEST_JOBS_PREFIX = "/api/ingest/jobs/";

/** True when `pathname` addresses the job collection or one job. */
export function isIngestJobsPath(pathname: string): boolean {
  return pathname === INGEST_JOBS_PATH || pathname.startsWith(INGEST_JOBS_PREFIX);
}

/**
 * The durable reader, injected rather than imported.
 *
 * The viewer must not depend on the dimensions database: it runs in hosts that have
 * no Stack at all, and pulling `llmwiki-kg` into this module would make every viewer
 * import pay for a pool it may never open. The host supplies these when it has one,
 * and their absence is the "memory only" configuration, not an error.
 */
export interface DurableJobReads {
  /** Every retained job for the host's Stack, newest transition first. */
  list(limit: number): Promise<readonly unknown[]>;
  /** One job by id, or `undefined` when this Stack never had it. */
  get(jobId: string): Promise<unknown | undefined>;
  /**
   * The same reads for a Stack the caller NAMED.
   *
   * Separate from `list`/`get` because those bake the bound Stack in at
   * construction: they are the host's own view, and a caller naming another Stack
   * must not be served that one by accident. Absent when the host cannot reach a
   * database at all, which is the honest reason the route then answers 503 instead
   * of pretending a Stack does not exist.
   */
  forStack?(stackId: string): {
    list(limit: number): Promise<readonly unknown[]>;
    get(jobId: string): Promise<unknown | undefined>;
    /** True when the Stack exists, so an unknown id can be 404 rather than empty. */
    exists(): Promise<boolean>;
  };
}

/** Resolve the durable reads from the dependency bag, when the host supplied them. */
function durableFrom(deps: Record<string, unknown>): DurableJobReads | undefined {
  const candidate = deps.durableIngestJobs;
  return candidate === undefined ? undefined : (candidate as DurableJobReads);
}

/**
 * Resolve the registry from the viewer's dependency bag.
 *
 * `undefined` is a real, expected case: a viewer started without a project root has
 * no mutation mount, so it has no jobs either. Answering `null` lets the handler
 * decide between 404-on-unknown and 503-on-unavailable instead of conflating them.
 */
function registryFrom(deps: Record<string, unknown>): JobRegistry | undefined {
  const candidate = deps.ingestJobs;
  return candidate === undefined ? undefined : (candidate as JobRegistry);
}

/** The per-Stack reads a caller named, or `undefined` when they named none. */
function namedStackReads(
  durable: DurableJobReads | undefined,
  requestedStackId: string,
): ReturnType<NonNullable<DurableJobReads["forStack"]>> | undefined {
  if (requestedStackId === "" || durable?.forStack === undefined) return undefined;
  return durable.forStack(requestedStackId);
}

/**
 * Jobs for the collection route.
 *
 * ## Why a named Stack does NOT merge the live registry
 *
 * `registry.list()` is stack-agnostic: it returns every job this process holds, with
 * no attribution at all. The existing live+durable merge is coherent only because
 * exactly one Stack is in play. Merging the live view into an answer about a
 * DIFFERENT Stack would attach this host's jobs to that Stack — a wrong answer that
 * looks right, which is worse than the empty list the caller was trying to avoid.
 *
 * A live job for another Stack does not exist in this process, so that Stack's
 * durable rows are the whole truth.
 *
 * @param reads - The sources for this request.
 * @returns Jobs with no duplicate ids.
 */
async function collectionJobs(reads: Reads): Promise<readonly unknown[]> {
  if (reads.named !== undefined) return reads.named.list(DURABLE_LIST_LIMIT);
  return mergedJobs(reads.registry, reads.durable);
}

/**
 * Answer a job read.
 *
 * Answers 503 rather than 404 when no registry is mounted: "this host does not
 * track jobs" and "this host tracks jobs and has never seen that id" are different
 * facts, and a client that treats the second as the first would stop polling a job
 * that exists.
 *
 * @param res - Response to write.
 * @param url - Request URL, already known to address a jobs path.
 * @param deps - Viewer dependencies, carrying the registry when one is mounted.
 */
export async function handleApiIngestJobs(
  res: ServerResponse,
  url: URL,
  deps: Record<string, unknown>,
): Promise<void> {
  const registry = registryFrom(deps);
  if (registry === undefined) {
    writeJsonError(res, 503, "jobs_unavailable", "this host does not track ingest jobs");
    return;
  }
  const durable = durableFrom(deps);
  const request = jobRequest(url, durable);
  if (request === undefined) {
    writeJsonError(res, 400, "invalid_stack_id", stackIdProblem(namedIdOf(url)) ?? "");
    return;
  }
  const reads: Reads = { registry, durable, named: request.named };
  if (request.named !== undefined && !(await request.named.exists())) {
    writeJsonError(res, 404, "stack_not_found", `no Stack '${request.stackId}'`);
    return;
  }
  if (request.jobId === undefined) {
    writeJson(res, 200, { jobs: await collectionJobs(reads) });
    return;
  }
  await writeOneJob(res, request.jobId, reads);
}

/** The two read sources a request works from, resolved once. */
interface Reads {
  readonly registry: JobRegistry;
  readonly durable: DurableJobReads | undefined;
  readonly named: ReturnType<NonNullable<DurableJobReads["forStack"]>> | undefined;
}

/** What the caller asked for: a Stack (maybe), and a job id (maybe). */
interface JobRequest {
  readonly stackId: string;
  readonly named: ReturnType<NonNullable<DurableJobReads["forStack"]>> | undefined;
  readonly jobId: string | undefined;
}

/** The raw `stackId` the caller sent, trimmed; `""` when absent. */
function namedIdOf(url: URL): string {
  return (url.searchParams.get("stackId") ?? "").trim();
}

/**
 * Parse the request, or `undefined` when the Stack id is malformed.
 *
 * A caller may name the Stack explicitly. Absent means the bound one, so the
 * behaviour every existing poller relies on is unchanged.
 *
 * @param url - Request URL.
 * @param durable - The mirrored table, when the host has one.
 * @returns The parsed request, or `undefined` for a malformed Stack id.
 */
function jobRequest(url: URL, durable?: DurableJobReads): JobRequest | undefined {
  const stackId = namedIdOf(url);
  if (stackId !== "" && stackIdProblem(stackId) !== undefined) return undefined;
  const remainder = url.pathname.slice(INGEST_JOBS_PREFIX.length);
  return {
    stackId,
    named: namedStackReads(durable, stackId),
    jobId: url.pathname === INGEST_JOBS_PATH ? undefined : decodeURIComponent(remainder),
  };
}

/**
 * Answer the single-job route.
 *
 * A named Stack skips the LIVE lookup entirely: the registry is stack-agnostic, so a
 * job id belonging to ANOTHER Stack would otherwise be served as if it were this
 * one's. Only the durable rows know which Stack they belong to.
 *
 * @param res - Response to write.
 * @param jobId - The decoded job id.
 * @param reads - The sources for this request.
 */
async function writeOneJob(res: ServerResponse, jobId: string, reads: Reads): Promise<void> {
  if (jobId === "") {
    writeJsonError(res, 404, "job_not_found", "no ingest job ''");
    return;
  }
  const live = reads.named === undefined ? reads.registry.get(jobId) : undefined;
  const source = reads.named ?? reads.durable;
  const job = live ?? (source === undefined ? undefined : await source.get(jobId));
  if (job === undefined) {
    writeJsonError(res, 404, "job_not_found", `no ingest job '${jobId}'`);
    return;
  }
  writeJson(res, 200, job);
}

/**
 * Every job this host can describe, newest transition first.
 *
 * Live entries win over durable ones with the same id: the registry holds the
 * fresher snapshot, and a status endpoint that served a stale copy of a job it is
 * currently running would be worse than not knowing it.
 *
 * @param registry - The live store for this process.
 * @param durable - The mirrored table, when the host has one.
 * @returns Jobs with no duplicate ids.
 */
async function mergedJobs(
  registry: JobRegistry,
  durable: DurableJobReads | undefined,
): Promise<readonly unknown[]> {
  const live = registry.list();
  if (durable === undefined) return live;
  const liveIds = new Set(live.map((job) => job.id));
  const restored = (await durable.list(DURABLE_LIST_LIMIT)).filter((job) => {
    const id = (job as { id?: unknown }).id;
    return typeof id === "string" && !liveIds.has(id);
  });
  const all = [...live, ...restored] as readonly { updatedAt?: string }[];
  return [...all].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}
