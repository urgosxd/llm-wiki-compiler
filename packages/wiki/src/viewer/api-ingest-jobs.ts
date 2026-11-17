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
import {
  namedStackRefusal,
  stackLookupFailedRefusal,
  unnamedStackRefusal,
  writeStackRefusal,
} from "./respond.js";
import type { StackRefusal } from "./respond.js";
import type { JobRegistry } from "../services/ingest/jobs/registry.js";
import { stackIdProblem } from "@repo/foundation";
import { createDimensionsDatabase, isDatabaseConfigured } from "../dimensions/activation.js";
import { stackResolution } from "../services/stacks/stack-store.js";
import { StackAuthorityError } from "../dimensions/stack-authority.js";

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
 * no Stack at all, and a pool is the one thing such a host can neither open nor
 * need. The host supplies these when it has one, and their absence is the "memory
 * only" configuration, not an error.
 *
 * Injection is about the pool, not about keeping the KG package out — this module is
 * already inside its import graph. It imports `stackIdProblem` from
 * `@repo/foundation`, which is the pure Stack-id rule and imports nothing at all, so
 * the `llmwiki-kg` barrel is no longer on this path. Measured, the viewer bundle was
 * unchanged by the move: it already carried those modules through other importers.
 *
 * The boundary that does matter is the MCP SDK — nothing on the viewer side may link
 * `@modelcontextprotocol/sdk`. The barrel's closure contains none of it, which is
 * what makes this import safe, and no test in the suite enforces that today.
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
    /**
     * True when the Stack exists, so an unknown id can be 404 rather than empty.
     *
     * No longer consulted by the route below: a boolean cannot tell a retired Stack from an
     * absent one, and S10 of `odd/tasks/stack-authority-per-request.md` requires those two to
     * stay different answers. The route classifies through the shared tri-state lookup
     * ({@link resolveNamedStack}) and this member stays as the host's own capability.
     */
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
 * Refuse a named Stack this request cannot read, or `undefined` when it may.
 *
 * The same tri-state lookup the mutation mount and `/api/reviews` use, deliberately: one id must
 * get one answer per fact on every surface, and a retired Stack must be told apart from an
 * absent one so an operator learns the domain is still taken (S10). Skipped with no database
 * configured, where a `stackId` names nothing because there is no table to check it against.
 *
 * @param stackId - The id the request named, already shape-validated.
 * @returns The refusal to send, or `undefined` when the reads may proceed.
 */
async function resolveNamedStack(stackId: string): Promise<StackRefusal | undefined> {
  if (!isDatabaseConfigured(process.env)) return undefined;
  const dimensionsDb = createDimensionsDatabase(process.env);
  try {
    return namedStackRefusal(stackId, await stackResolution(dimensionsDb.db, stackId));
  } catch (error) {
    return stackLookupFailedRefusal(stackId, error);
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Answer a job read.
 *
 * Answers 503 rather than 404 when no registry is mounted: "this host does not
 * track jobs" and "this host tracks jobs and has never seen that id" are different
 * facts, and a client that treats the second as the first would stop polling a job
 * that exists.
 *
 * A named Stack is settled BEFORE any read, and an unnamed one is served from the host's own
 * view — which exists only for a host whose process named a Stack. When it does not, the
 * durable reads reject with a `StackAuthorityError`; that rejection used to escape this module
 * and become a bodiless 500 through the dispatcher's catch. It is a client mistake with a
 * remedy, so it now answers the same `stack_unnamed` envelope every other surface does.
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
  const request = jobRequest(url, durableFrom(deps));
  if (request === undefined) {
    writeJsonError(res, 400, "invalid_stack_id", stackIdProblem(namedIdOf(url)) ?? "");
    return;
  }
  if (request.named !== undefined) {
    const refusal = await resolveNamedStack(request.stackId);
    if (refusal !== undefined) {
      writeStackRefusal(res, refusal);
      return;
    }
  }
  await answerJobRead(res, request.jobId, { registry, durable: durableFrom(deps), named: request.named });
}

/**
 * Answer the read, mapping the host's unnamed-Stack refusal onto the shared envelope.
 *
 * Only the host's OWN view can raise it: a named Stack's reads never resolve an authority. So
 * any other throw keeps travelling, and a genuine fault still reads as a server fault.
 *
 * @param res - Response to write.
 * @param jobId - The job asked for, or `undefined` for the collection.
 * @param reads - The sources for this request.
 * @returns Nothing; the response is written here.
 */
async function answerJobRead(
  res: ServerResponse,
  jobId: string | undefined,
  reads: Reads,
): Promise<void> {
  try {
    if (jobId === undefined) {
      writeJson(res, 200, { jobs: await collectionJobs(reads) });
      return;
    }
    await writeOneJob(res, jobId, reads);
  } catch (error) {
    if (reads.named !== undefined || !(error instanceof StackAuthorityError)) throw error;
    writeStackRefusal(res, unnamedStackRefusal());
  }
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
