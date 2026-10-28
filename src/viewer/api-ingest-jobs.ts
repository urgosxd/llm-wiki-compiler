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

/** Path of the collection endpoint. */
export const INGEST_JOBS_PATH = "/api/ingest/jobs";

/** Prefix under which a single job is addressed. */
export const INGEST_JOBS_PREFIX = "/api/ingest/jobs/";

/** True when `pathname` addresses the job collection or one job. */
export function isIngestJobsPath(pathname: string): boolean {
  return pathname === INGEST_JOBS_PATH || pathname.startsWith(INGEST_JOBS_PREFIX);
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
export function handleApiIngestJobs(
  res: ServerResponse,
  pathname: string,
  deps: Record<string, unknown>,
): void {
  const registry = registryFrom(deps);
  if (registry === undefined) {
    writeJsonError(res, 503, "jobs_unavailable", "this host does not track ingest jobs");
    return;
  }
  if (pathname === INGEST_JOBS_PATH) {
    writeJson(res, 200, { jobs: registry.list() });
    return;
  }
  const id = pathname.slice(INGEST_JOBS_PREFIX.length);
  const job = id === "" ? undefined : registry.get(decodeURIComponent(id));
  if (job === undefined) {
    writeJsonError(res, 404, "job_not_found", `no ingest job '${id}'`);
    return;
  }
  writeJson(res, 200, job);
}
