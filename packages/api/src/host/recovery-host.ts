/**
 * @file packages/api/src/host/recovery-host.ts
 * @description A listening API host with a durable job registry, for the suites that drive
 * `DELETE /api/ingest/jobs/:jobId`, its `/retry`, and the async-ingest route over real HTTP.
 *
 * ## Why this lives beside the host and not in `test/fixtures`
 *
 * The repository's boundary rule forbids any file outside `packages/api` from importing
 * `packages/api/src/host/server.js` (wiki/code must not point at the joiner). A fixture under
 * `test/` that started a host would be exactly that inverted arrow, so the harness lives here —
 * beside `server.ts` and the tests it serves — and the suites import it by a relative path.
 *
 * ## Why one copy
 *
 * Four suites need it now: the recovery-route suite, the version-precision suite, the
 * concurrency suite that reproduces the reported hang, and the refusal-invariance suite. A copy
 * per file is how a harness drifts — one copy would drain a different queue than the route it
 * drives, or serve a Stack the registry does not mirror into, and every case would pass while
 * proving nothing. The host here is the SAME shape everywhere: one registry, ONE queue shared by
 * the registry and by the delete route, one Stack, and that Stack named on every request.
 *
 * NOTHING HERE ASSERTS. It starts a host and binds the requests a case makes; every claim stays
 * in the case that makes it. This module is a test-only seam: it is not exported from the
 * package, and its only importers are `*.test.ts` files beside it.
 */
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import {
  createDurableJobRegistry,
  createIngestJobMirrorQueue,
  type DurableJobRegistry,
  type IngestJobMirrorQueue,
} from "@repo/wiki/job-durable-registry";
import { createJobRegistry } from "@repo/wiki/job-registry";
import type { DatabaseHandle } from "@repo/foundation";
import { startHost, type HostHandle } from "./server.js";

/**
 * What a host needs from the suite that starts one.
 *
 * Structural on purpose: the suites build this with `useIngestJobSurface` from
 * `test/fixtures/ingest-job-rows.ts`, and naming that type here would make this module import a
 * test fixture. These three members are the whole contract.
 */
export interface RecoverySite {
  /** Project root the host serves. */
  root(): string;
  /** The Stack to serve, with the database handle its rows live in. */
  stack(): {
    readonly harness: { readonly db: DatabaseHandle; readonly stackId: string };
  };
}

/** How long a suite waits for the mirror chain to hand its writes to the database. */
const FLUSH_BOUND_MS = 10_000;

/** A running host, the registry it serves jobs from, and the requests a case makes. */
export interface RecoveryHost {
  /** The live registry the host mirrors into Postgres through. */
  readonly registry: DurableJobRegistry;
  /** The queue BOTH the registry writes through and the delete route drains. */
  readonly queue: IngestJobMirrorQueue;
  /** `DELETE /api/ingest/jobs/:jobId` for the Stack this host serves. */
  del(jobId: string): Promise<Response>;
  /** `POST /api/ingest/jobs/:jobId/retry` for the Stack this host serves. */
  retry(jobId: string): Promise<Response>;
  /** The status route a delete must agree with: `GET /api/ingest/jobs/:jobId`. */
  read(jobId: string): Promise<Response>;
  /** `POST /api/ingest`, for the route these changes must not disturb. */
  post(body: unknown): Promise<Response>;
  /** Await every queued mirror write, so a row assertion sees what has landed. */
  flush(): Promise<void>;
}

/**
 * Start a host that serves `stackId`, run `body`, and always close it.
 *
 * The queue is created once and handed to BOTH the registry and the host: a case that holds a
 * write open across a delete only has a hazard to measure because the route drains the queue the
 * registry writes through.
 *
 * @param site - The project root and Stack the host serves.
 * @param body - The case, given the running host.
 */
export async function withRecoveryHost(
  site: RecoverySite,
  body: (host: RecoveryHost) => Promise<void>,
): Promise<void> {
  const root = site.root();
  const { db, stackId } = site.stack().harness;
  const queue = createIngestJobMirrorQueue();
  const registry = createDurableJobRegistry(createJobRegistry(), { db, stackId, queue });
  const snapshot = await buildViewerSnapshot(root);
  const handle = await startHost({
    viewerSnapshot: snapshot,
    port: 0,
    projectRoot: root,
    ingestJobs: registry,
    jobMirrorQueue: queue,
  });
  try {
    await body(requestsFor(handle, stackId, registry, queue));
  } finally {
    await handle.close();
  }
}

/**
 * Bind the fetchers to a listening host.
 *
 * @param handle - The bound host.
 * @param stackId - The Stack it serves, named on every request.
 * @param registry - Its registry.
 * @param queue - Its mirror queue.
 * @returns The seam a case drives.
 */
function requestsFor(
  handle: HostHandle,
  stackId: string,
  registry: DurableJobRegistry,
  queue: IngestJobMirrorQueue,
): RecoveryHost {
  const base = `http://${handle.host}:${handle.port}`;
  const stack = encodeURIComponent(stackId);
  const jobPath = (jobId: string, suffix = ""): string =>
    `/api/ingest/jobs/${jobId}${suffix}?stackId=${stack}`;
  const call = (route: string, init?: RequestInit): Promise<Response> => fetch(`${base}${route}`, init);
  return {
    registry,
    queue,
    del: (jobId) => call(jobPath(jobId), { method: "DELETE" }),
    retry: (jobId) => call(jobPath(jobId, "/retry"), { method: "POST" }),
    read: (jobId) => call(jobPath(jobId)),
    post: (body) =>
      call(`/api/ingest?stackId=${stack}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    flush: async () => {
      await queue.flush(FLUSH_BOUND_MS);
    },
  };
}
