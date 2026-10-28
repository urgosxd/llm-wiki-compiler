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

/**
 * Answer a job read.
 *
 * Answers 503 rather than 404 when no registry is mounted: "this host does not
 * track jobs" and "this host tracks jobs and has never seen that id" are different
 * facts, and a client that treats the second as the first would stop polling a job
 * that exists.
 *
 * @param res - Response to write.
 * @param pathname - Request path, already known to be a jobs path.
 * @param deps - Viewer dependencies, carrying the registry when one is mounted.
 */
export async function handleApiIngestJobs(
  res: ServerResponse,
  pathname: string,
  deps: Record<string, unknown>,
): Promise<void> {
  const registry = registryFrom(deps);
  if (registry === undefined) {
    writeJsonError(res, 503, "jobs_unavailable", "this host does not track ingest jobs");
    return;
  }

  // MERGE LIVE AND DURABLE, do not prefer one.
  //
  // Both sources know something the other does not, and picking either alone gets a
  // real case wrong:
  //
  //   durable only  -> a job created microseconds ago is invisible, because its
  //                    mirror is fire-and-forget (measured: two jobs created, list
  //                    returned 0) — the write must not block the ingest, so the
  //                    read has to tolerate it not having landed yet.
  //   live only     -> every job is lost on restart, which is the defect that made
  //                    the mirrored table exist in the first place.
  //
  // So the live registry is authoritative for the ids it holds, and the durable
  // record supplies the rest — the jobs from before this process started.
  const durable = durableFrom(deps);
  if (pathname === INGEST_JOBS_PATH) {
    writeJson(res, 200, { jobs: await mergedJobs(registry, durable) });
    return;
  }

  const id = pathname.slice(INGEST_JOBS_PREFIX.length);
  const decoded = id === "" ? "" : decodeURIComponent(id);
  if (decoded === "") {
    writeJsonError(res, 404, "job_not_found", `no ingest job '${id}'`);
    return;
  }
  const live = registry.get(decoded);
  const job = live ?? (durable === undefined ? undefined : await durable.get(decoded));
  if (job === undefined) {
    writeJsonError(res, 404, "job_not_found", `no ingest job '${id}'`);
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
