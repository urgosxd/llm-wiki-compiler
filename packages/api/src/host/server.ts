/**
 * @file src/host/server.ts
 * @description One HTTP listener hosting two sub-applications with deliberately
 * different security regimes.
 *
 * ## Why this exists
 *
 * The project grew two servers that could never be one server. The viewer and the
 * knowledge graph differ in ways that are decisions, not accidents:
 *
 * | | viewer | knowledge graph |
 * | --- | --- | --- |
 * | Trust boundary | Origin / Sec-Fetch-Site, fail-CLOSED (403) | X-API-Key, fail-OPEN when unset |
 * | `/health` shape | rich counts (`/api/health`) | pinned `{status, service, version}` |
 * | Error envelope | `writeJsonError(code, message)` | FastAPI `{detail}` |
 *
 * So this module does NOT merge them. It shares what can be shared — one
 * listener, one lifecycle, one shutdown path — and mounts each sub-app with its
 * own policy intact. The KG is a fidelity port measured against a live Python
 * oracle; rewriting it inside a unified pipeline would be rewriting the port.
 *
 * ## The trust boundary is per-mount, not per-listener
 *
 * The chosen boundary is fail-open for the graph routes and fail-closed for the
 * viewer. That is expressed by WHERE each policy runs: the viewer handler applies
 * its origin check to every request it receives, and the graph app is mounted
 * under a path prefix that the viewer never sees. A single listener therefore
 * never has to pick one policy for both — the split is by mount, which is the
 * only honest way to hold two answers at once.
 *
 * ## Route ownership
 *
 * The two sub-apps do not collide: the viewer owns `/` and `/api/**`, the graph
 * owns `/health`, `/stacks`, `/aks/v1/**`, `/documents`, and the ingest and
 * synthesize paths it declares absolutely. The host adds `/host/health`, which
 * aggregates both probes, and leaves every other path to the mounted apps.
 *
 * ## What is deliberately NOT here
 *
 * No database connection of its own: the graph app already owns its pool, and a
 * second pool for liveness would double the connections for no information.
 * No snapshot refresh: the frozen snapshot is a security property, not a
 * performance choice — a reloaded snapshot would authorize serving bytes that
 * changed after startup.
 * No ingest-state repair at startup: the coordinator's single transaction is the
 * sole ingest mechanism, so a boot has nothing pending to finish. Startup used to
 * reconcile an `ingest_outbox` row under the mutation lock; both the table and the
 * reconciler are gone, and the returned outcome was discarded anyway.
 *
 * ## Why this module lives in `@repo/api`
 *
 * It mounts the knowledge graph, so it is the one place in the listener stack that
 * names BOTH dimensions: `createApp` comes from `@repo/kg/server` while the viewer,
 * the mutation endpoints and the ingest job machinery come from `@repo/wiki`. While
 * this file sat in `packages/wiki/src/host/`, that join lived inside `@repo/wiki`
 * and the topology said the opposite — `wiki ↔ kg` is forbidden in both directions
 * and only `@repo/api` may hold both. Moving the directory moved the edge, not the
 * behaviour: every line of listener logic is unchanged. `api.ts`, `mcp-http.ts` and
 * `tenants.ts` moved with it because they are parts of the same listener rather than
 * CLI-only surface, and the wiki modules they need are reached through the explicit
 * `@repo/wiki/*` subpaths in that package's `exports` map.
 */
import http from "node:http";
import { listenOn } from "@repo/wiki/http-listen";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "@repo/kg/server";

/** The graph sub-app type, derived so this module needs no direct express import. */
type GraphApp = ReturnType<typeof createApp>;
import { createViewerHandler, type ViewerRequestHandler } from "@repo/wiki/viewer-server";
import { handleApiRequest, type ApiDeps, type IngestDimensionsPort } from "./api.js";
import { createDimensionsPort } from "../dimensions/port.js";
import { handleMcpHttp, isMcpHttpPath } from "./mcp-http.js";
import {
  createJobRegistry,
  type JobRegistry,
  type RecoverableJobRegistry,
} from "@repo/wiki/job-registry";
import { createDurableJobRegistry, createIngestJobMirrorQueue, resolveMirrorFlushTimeoutMs, type DurableJobRegistry, type IngestJobMirrorQueue } from "@repo/wiki/job-durable-registry";
import { listIngestJobs, readIngestJob } from "@repo/wiki/job-store";
import {
  listStackIds,
  settleAbandonedJobs,
  type ReapOptions,
  type ReapOutcome,
} from "@repo/wiki/job-reaper";
import { resolveIngestJobStuckAfterMs } from "@repo/wiki/job-status";
import { stackExists } from "@repo/wiki/stack-store";
import type { DurableJobReads } from "@repo/wiki/viewer-api-ingest-jobs";
import {
  AKS_STACK_ID_ENV_VAR,
  createDimensionsDatabase,
  isDatabaseConfigured,
} from "@repo/wiki/dimensions-activation";
import {
  StackAuthorityError,
  unnamedJobStackRefusal,
} from "@repo/wiki/dimensions-stack-authority";
import { resolveTenant, tenantSlugOf, type TenantEntry } from "./tenants.js";
import { writeJsonError } from "@repo/wiki/viewer-respond";
import type { ViewerSnapshot } from "@repo/wiki/viewer-types";

/** Default port when the caller does not pin one. `0` asks the OS for a free port. */
const DEFAULT_HOST_PORT = 4173;
/** Default bind address: loopback, because a viewer exposes project contents. */
const DEFAULT_HOST_ADDRESS = "127.0.0.1";

/** The dimensions handle the mirror wrappers write through, named once instead of at each call. */
type DimensionsHandle = ReturnType<typeof createDimensionsDatabase>["db"];

/** How the host composes its two sub-apps. */
export interface HostOptions {
  /** Frozen viewer snapshot; built by the caller so startup cost stays explicit. */
  readonly viewerSnapshot: ViewerSnapshot;
  /** Bind host; loopback unless the caller opts into a wider bind. */
  readonly host?: string;
  /** Bind port; `0` lets the OS pick one. */
  readonly port?: number;
  /** Viewer collaborator overrides, passed straight through. */
  readonly viewerDeps?: Record<string, unknown>;
  /**
   * Mount the graph sub-app.
   *
   * Defaults to TRUE: the graph is part of the served surface. A caller that
   * cannot reach a database can still ask for the viewer alone, and does so
   * explicitly rather than by leaving an environment variable unset — an
   * implicit "no database means no mount" would make the served surface depend on
   * ambient state.
   */
  readonly includeGraph?: boolean;
  /**
   * Version reported to MCP clients in the initialize handshake.
   *
   * Supplied by the caller (the CLI passes its own) so this module never reads
   * `package.json` at runtime, which would tie the bundled output to a file that is
   * not next to it. Absent means the MCP surface reports `unknown` rather than a
   * version it made up.
   */
  readonly version?: string;
  /**
   * Builds an MCP server for one HTTP request, or absent to serve no MCP over HTTP.
   *
   * INJECTED rather than imported. `host/server.ts` cannot reach `../mcp/**` without
   * closing a cycle through `compiler-cli.ts`, the public barrel that re-exports
   * `hostCommand` — measured with `fallow`, which reported three cycles (one per
   * tools barrel) the moment such an import existed. The CLI entry builds it, since
   * nothing imports the entry back.
   */
  readonly mcpServerFactory?: () => {
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  };
  /**
   * Project root whose mutation endpoints are mounted.
   *
   * Startup does NOT touch ingest state: the coordinator's transaction is the sole
   * ingest mechanism, so there is no pending work for a boot to finish. Omitted
   * means the mutation mount is absent.
   */
  readonly projectRoot?: string;
  /**
   * The configured dimensions every ingest on this host writes through.
   *
   * COMPOSED HERE when the caller omits it, which is the difference between this
   * entry point and the ingest routes themselves: a host therefore cannot serve a
   * dimension-less ingest, because `createDimensionsPort()` is the real
   * implementation and never an empty set. The loud refusal lives at the seams that
   * take an injected port -- the mutation mount and the stdio MCP server -- where a
   * wiring mistake is actually possible. Callers that need a shared instance (the
   * container entry, which also hands one to the MCP-over-HTTP factory) pass theirs.
   */
  readonly dimensionsPort?: IngestDimensionsPort;
  /**
   * Additional projects served under `/p/<slug>/...`.
   *
   * The single `viewerSnapshot` above remains the DEFAULT surface: a host with no
   * tenants behaves exactly as before. Tenants exist because one frozen snapshot
   * cannot describe two projects — serving it to a second one returns 200 with the
   * first project's content, which fails silently rather than loudly.
   *
   * Snapshots are built lazily per tenant, so boot cost does not scale with tenant
   * count and one unreadable project does not prevent the others from serving.
   */
  readonly tenants?: readonly TenantEntry[];
  /**
   * Job registry the async ingest route creates jobs in.
   *
   * Defaults to a fresh per-host registry, deliberately NOT a module singleton: a
   * shared one would mix two hosts' jobs in one process, and two projects would
   * read each other's ingest history.
   */
  readonly ingestJobs?: JobRegistry;
  /**
   * Mirror write queue this host's `close` flushes.
   *
   * Defaults to a fresh queue, which is what the registry built for this host uses. Injectable
   * so a test can drive the shutdown bound through the queue's timer seam instead of waiting on
   * a real clock — the property being proved is "close awaits the writes", not "the machine was
   * fast enough".
   */
  readonly jobMirrorQueue?: IngestJobMirrorQueue;
}

/** What the durable reads need a bound Stack for, named in a refusal. */
const DURABLE_READS_CONTEXT = "The host's durable ingest-job reads";

/** What the durable registry needs a bound Stack for, named in a refusal. */
const DURABLE_REGISTRY_CONTEXT = "The host's durable ingest-job registry";

/**
 * The Stack the PROCESS named for this host, when it named one.
 *
 * The environment is a boot input and never a request input: it can answer for a deployment
 * that serves exactly ONE Stack, which is why it is read here and nowhere on a request path.
 * A blank id is no Stack — `AKS_STACK_ID=""` is how the suite states "no Stack named" — and
 * treating it as one would rebuild the empty-string guard the authority module deleted.
 *
 * Since the launcher's boot stopped resolving a Stack (S6 of
 * `odd/tasks/stack-authority-per-request.md`) this is `undefined` on the deployment shape S6
 * requires: a database configured with `public.stacks` still empty. The two entries below then
 * settle the Stack per JOB, which is where a request's Stack now arrives.
 *
 * @param env - The environment this host was started with.
 * @returns The named Stack id, or `undefined` when the process named none.
 */
function boundJobStackId(env: NodeJS.ProcessEnv): string | undefined {
  const named = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  return named === "" ? undefined : named;
}

/** The message an unexpected value carries, for a line an operator has to read. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write one line to the sink every ingest-job report uses. */
function writeIngestJobLine(line: string): void {
  process.stderr.write(`[ingest-job] ${line}\n`);
}

/**
 * Report a mirror write failure without failing the job it describes.
 *
 * Durability exists for a LATER reader, so it is never on the path of the work: a status row
 * that cannot be written must not turn a working ingest into a failed one.
 *
 * @param error - What the mirror write threw.
 */
function reportMirrorFailure(error: unknown): void {
  writeIngestJobLine(`durable mirror failed: ${detailOf(error)}`);
}

/** Longest delay a platform timer accepts; anything above it fires immediately. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Await `work`, and stop waiting for it after `timeoutMs`.
 *
 * `undefined` is the answer for "still running when the bound expired", which a caller reports
 * and then moves past. Without it the boot would inherit the lifespan of a database round trip
 * it cannot control.
 *
 * @param work - What to wait for.
 * @param timeoutMs - How long the caller is willing to wait.
 * @returns The value, or `undefined` when the bound expired first.
 */
function waitAtMost<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
    // Unreferenced: a bound that has not expired is never a reason to keep a process alive.
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Report what a boot reap did.
 *
 * Named ids, not a count: an operator who saw a row stop saying `running` needs to be able to
 * find WHICH rows this process settled. Silent when there was nothing to say, so an ordinary
 * boot stays quiet.
 *
 * @param outcome - What the reap settled and skipped.
 */
function reportBootReap(outcome: ReapOutcome): void {
  if (outcome.settled.length === 0 && outcome.skipped === 0) return;
  const ids = outcome.settled.map((row) => row.jobId).join(", ");
  const left = outcome.skipped === 0 ? "" : `; left ${outcome.skipped} live job(s) alone`;
  writeIngestJobLine(`boot reaper settled ${outcome.settled.length} abandoned job(s): ${ids}${left}`);
}

/**
 * Settle the `wiki.ingest_job` rows a previous process left behind, once, at boot.
 *
 * THE case the reaper exists for: a restart kills the process that owned a job, and its row
 * would otherwise say `running` forever. It runs here rather than on a read because a status
 * read must never mutate a row, and rather than on a route because a `DELETE` is what an
 * operator already has for a row they can see.
 *
 * Three properties this function owes its caller, in order of importance:
 *
 *  - it can never prevent the host from starting. Every failure — a database that is gone, a
 *    schema that is not applied yet, a bound that expires — is REPORTED and swallowed, because
 *    a reaper that blocks boot is a worse outage than the stale row it was clearing;
 *  - it can never HANG the host from starting, which is what the bound is for: it waits at most
 *    `LLMWIKI_INGEST_JOB_FLUSH_TIMEOUT_MS`, the same "how long we wait on a database that may be
 *    gone" number a shutdown uses;
 *  - it names what it settled, on the sink every ingest-job report uses.
 *
 * @param env - Environment this host was started with; defaults to `process.env`.
 * @param registry - This host's live registry, so a job this process is still running is never
 *   settled. Absent only for a caller that holds no live jobs.
 * @returns What was settled, or `undefined` when there is no database or the bound expired.
 */
export async function reapAbandonedJobsAtBoot(
  env: NodeJS.ProcessEnv = process.env,
  registry?: Pick<JobRegistry, "get">,
): Promise<ReapOutcome | undefined> {
  // The explicit file mode: no database, so there is nowhere durable to reap from.
  if (!isDatabaseConfigured(env)) return undefined;
  const dimensionsDb = createDimensionsDatabase(env);
  // `now` is taken BEFORE the scan, so every transition that lands afterwards carries a later
  // stamp and the store's `updated_at` guard refuses THIS run instead of the other way round.
  const options: ReapOptions = {
    now: new Date(),
    stuckAfterMs: resolveIngestJobStuckAfterMs(env),
    ...(registry === undefined ? {} : { registry }),
  };
  try {
    const outcome = await waitAtMost(
      listStackIds(dimensionsDb.db).then((stackIds) =>
        settleAbandonedJobs(dimensionsDb.db, stackIds, options),
      ),
      resolveMirrorFlushTimeoutMs(env),
    );
    if (outcome === undefined) {
      writeIngestJobLine("boot reaper did not finish inside its bound; the next boot retries");
      return undefined;
    }
    reportBootReap(outcome);
    return outcome;
  } catch (error) {
    // Deliberate: see this function's header. A stale row is reported, never fatal to boot.
    writeIngestJobLine(`boot reaper failed: ${detailOf(error)}`);
    return undefined;
  } finally {
    // The pool is this call's own and nothing waits for it again: ending it is best-effort, and
    // awaiting it here would hand the boot back the unbounded wait the bound just removed.
    void dimensionsDb.close().catch(() => undefined);
  }
}

/**
 * The durable job reads the viewer needs, or nothing in the explicit file mode.
 *
 * `undefined` is the honest answer rather than a stub, and it is reached ONLY in the named
 * file mode: no database configured at all, where the viewer has nothing durable to read and
 * an in-memory registry is all such a deployment ever had.
 *
 * With a database but NO Stack bound by the process, the reads still exist and still serve the
 * per-request path — `forStack` reads the rows of the Stack a caller NAMED, straight from the
 * table, with no cache — while the host's own `list`/`get` REFUSE. Those two answer "every job
 * THIS HOST has", and a host that bound no Stack has no such set: this process's memory view
 * mixes every Stack a request named, so serving it would hand one Stack's job to a request that
 * named another. Refusing is the only answer that cannot be wrong.
 *
 * @param env - Environment this host was started with; defaults to `process.env`.
 * @returns Readers bound to this host's Stack, per-Stack readers, or `undefined` in file mode.
 */
export function durableJobReadsFor(env: NodeJS.ProcessEnv = process.env): DurableJobReads | undefined {
  // The explicit file mode: no database, so there is nowhere durable to read and `undefined`
  // tells the viewer to answer from memory.
  if (!isDatabaseConfigured(env)) return undefined;
  const dimensionsDb = createDimensionsDatabase(env);
  const bound = boundJobStackId(env);
  /** The host's own view, which exists only for a host that bound a Stack. */
  const hostOwnViewRefusal = (): Promise<never> =>
    Promise.reject(new StackAuthorityError(unnamedJobStackRefusal(DURABLE_READS_CONTEXT)));
  return {
    list: (limit: number) =>
      bound === undefined ? hostOwnViewRefusal() : listIngestJobs(dimensionsDb.db, bound, limit),
    get: (jobId: string) =>
      bound === undefined ? hostOwnViewRefusal() : readIngestJob(dimensionsDb.db, bound, jobId),
    // Only present when there IS a database, which is what makes the route able to
    // distinguish "no such Stack" (404) from "this host cannot check" (503). A
    // Stack-less host returns undefined here and keeps answering 503, because
    // claiming a Stack does not exist when the truth is "I cannot look" would be a
    // fabricated answer.
    forStack: (requested: string) => ({
      list: (limit: number) => listIngestJobs(dimensionsDb.db, requested, limit),
      get: (jobId: string) => readIngestJob(dimensionsDb.db, requested, jobId),
      exists: () => stackExists(dimensionsDb.db, requested),
    }),
  };
}

/**
 * The registry a host with a database and a bound Stack mirrors into.
 *
 * Every transition is written to `wiki.ingest_job`, which is what lets the MCP server — a
 * separate process over stdio — answer job questions the host is running; the memory view is
 * invisible outside this process. The handle is opened lazily by postgres-js (constructing a
 * client does not connect), so a host that never runs an async ingest never opens a socket.
 *
 * @param env - Environment this host was started with.
 * @param stackId - The Stack the process named, used for a job that names none.
 * @param queue - Write queue the host's close flushes; a private one when omitted.
 * @returns The mirrored registry.
 */
function stackBoundRegistry(
  env: NodeJS.ProcessEnv,
  stackId: string,
  queue: IngestJobMirrorQueue | undefined,
): DurableJobRegistry {
  const dimensionsDb = createDimensionsDatabase(env);
  return createDurableJobRegistry(createJobRegistry(), {
    db: dimensionsDb.db,
    stackId,
    onError: reportMirrorFailure,
    queue,
  });
}

/**
 * Create one job through a mirror wrapper bound to the Stack the JOB named.
 *
 * Split from {@link unboundStackRegistry} so each piece stays readable, and because this is where
 * the two rules actually live: the unnamed job is refused BEFORE any state changes (so rejected
 * input leaves the registry and the table exactly as they were), and the named one is mirrored
 * under ITS Stack. Evicted wrappers are dropped on the way through, which is what keeps the map
 * bounded by the registry's own retention instead of growing with every job ever accepted.
 *
 * @param live - The host's live registry, shared by every wrapper.
 * @param owners - Wrapper index, keyed by job id.
 * @param db - Handle every wrapper mirrors through.
 * @param source - Source identity of the job being created.
 * @param now - Creation timestamp.
 * @param stackId - The Stack the request named, when it named one.
 * @param queue - Write queue every wrapper shares, so one close flushes them all.
 * @returns The created job.
 * @throws {StackAuthorityError} when the job names no Stack.
 */
function createNamedJob(
  live: JobRegistry,
  owners: Map<string, RecoverableJobRegistry>,
  db: DimensionsHandle,
  source: string,
  now: Date,
  stackId: string | undefined,
  queue: IngestJobMirrorQueue | undefined,
): ReturnType<JobRegistry["create"]> {
  if (stackId === undefined || stackId.trim() === "") {
    throw new StackAuthorityError(unnamedJobStackRefusal(DURABLE_REGISTRY_CONTEXT));
  }
  const owner = createDurableJobRegistry(live, { db, stackId, onError: reportMirrorFailure, queue });
  const job = owner.create(source, now, stackId);
  for (const id of [...owners.keys()]) if (live.get(id) === undefined) owners.delete(id);
  owners.set(job.id, owner);
  return job;
}

/**
 * The registry a host with a database and NO bound Stack serves.
 *
 * The boot no longer binds a Stack (S6), so this is the ordinary shape of a fresh deployment: a
 * database with `public.stacks` empty, waiting for the first `POST /stacks`. A job that names no
 * Stack is refused by name; a job that names one is mirrored under THAT Stack, because the request
 * is the authority. No new storage shape is needed — `createDurableJobRegistry` already takes the
 * Stack from the creation call and remembers it per job id — and no cache is involved: the Stack
 * comes with each job. Keying the host's own READS by Stack is what T6 defers.
 *
 * @param env - Environment this host was started with.
 * @param queue - Write queue every per-job wrapper shares, and the one close flushes.
 * @returns The per-job registry.
 */
function unboundStackRegistry(
  env: NodeJS.ProcessEnv,
  queue: IngestJobMirrorQueue | undefined,
): RecoverableJobRegistry {
  const dimensionsDb = createDimensionsDatabase(env);
  const live = createJobRegistry();
  const owners = new Map<string, RecoverableJobRegistry>();
  /** The wrapper that owns `id`, falling back to the live store for a job nothing created here. */
  const ownerOf = (id: string): RecoverableJobRegistry => owners.get(id) ?? live;
  return {
    create: (source, now, stackId) =>
      createNamedJob(live, owners, dimensionsDb.db, source, now, stackId, queue),
    get: (id) => live.get(id),
    list: () => live.list(),
    patchIngest: (id, patch, now) => ownerOf(id).patchIngest(id, patch, now),
    patchCompile: (id, patch, now) => ownerOf(id).patchCompile(id, patch, now),
    patchAttempts: (id, attempts, now) => ownerOf(id).patchAttempts(id, attempts, now),
    /**
     * Drop the live entry, through the wrapper that owns it.
     *
     * This literal DELEGATES, so a missing `delete` was not a missing behaviour but a missing
     * contract: the recovery path in `api.ts` would have removed the durable row and left the
     * live entry behind, which is the status route answering for a job that no longer exists.
     * The entry is dropped from the index too, so a deleted job cannot keep its wrapper alive.
     */
    delete: (id) => {
      ownerOf(id).delete(id);
      owners.delete(id);
    },
    clear: () => {
      live.clear();
      owners.clear();
    },
  };
}

/**
 * Build the job registry this host should use.
 *
 * Three answers, and the middle one is what this feature changed. With NO database there is
 * nowhere durable to write, so the plain in-memory registry is returned: the explicit file mode
 * the authority names, not an empty variable. With a database and a Stack the PROCESS named, the
 * durable registry is bound to it, exactly as before. With a database and no Stack bound — the
 * fresh-deployment shape S6 requires — a registry is returned that refuses each job without one
 * and mirrors each job with one, instead of refusing to BUILD: a refusal at construction is what
 * made a host with an empty `public.stacks` unable to listen, and therefore unable to receive
 * the `POST /stacks` that would fix it.
 *
 * @param env - Environment this host was started with; defaults to `process.env`.
 * @param queue - Write queue every wrapper uses, so one close flushes every Stack's writes.
 * @returns The registry the host should use.
 */
export function durableRegistryFor(
  env: NodeJS.ProcessEnv = process.env,
  queue?: IngestJobMirrorQueue,
): RecoverableJobRegistry {
  if (!isDatabaseConfigured(env)) return createJobRegistry();
  const bound = boundJobStackId(env);
  return bound === undefined ? unboundStackRegistry(env, queue) : stackBoundRegistry(env, bound, queue);
}

/** A running host: both sub-apps behind one listener with one close path. */
export interface HostHandle {
  /** Actual bound port; resolves a `port: 0` request. */
  readonly port: number;
  /** Actual bound host. */
  readonly host: string;
  /** Graceful shutdown; resolves once the listener drains. */
  close(): Promise<void>;
}

/**
 * The graph sub-app, mounted as an Express instance.
 *
 * `createApp()` builds without binding a port and keeps the router factories'
 * dependency injection, so the fidelity-tested internals are reused unchanged.
 */
function createGraphApp(): GraphApp {
  return createApp();
}

/**
 * Dispatch one request to whichever sub-app owns it.
 *
 * The viewer receives everything the graph does not claim. That is what makes the
 * viewer's origin policy apply to the paths the viewer actually serves, while the
 * graph keeps its own fail-open authentication on its own paths.
 *
 * @param graph - Mounted graph app, or undefined when the caller omitted it.
 * @param viewer - Viewer handler, already bound to snapshot and config.
 */
function createDispatcher(
  graph: GraphApp | undefined,
  viewer: ViewerRequestHandler,
  projectRoot: string | undefined,
  tenants: ReadonlyMap<string, TenantEntry>,
  tenantViewer: (snapshot: ViewerSnapshot) => ViewerRequestHandler,
  apiDeps: ApiDeps,
  mcp: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    // A tenant-scoped path is resolved BEFORE anything else: the whole point is
    // that its request must never be served from the default project's snapshot.
    const slug = tenantSlugOf(new URL(req.url ?? "/", "http://localhost").pathname);
    if (slug !== undefined) {
      const entry = tenants.get(slug);
      if (entry === undefined) {
        writeJsonError(res, 404, "unknown_tenant", `no tenant '${slug}'`);
        return;
      }
      void resolveTenant(entry)
        .then((resolved) => {
          if (!resolved.ok) {
            writeJsonError(res, 503, "tenant_unavailable", resolved.error.slug);
            return;
          }
          // The viewer's route table knows nothing about the tenant prefix, so the
          // request is REWRITTEN to the unprefixed path before dispatch. Without
          // this every tenant path 404s: the prefix is routing, not content.
          req.url = stripTenantPrefix(req.url, slug);
          return tenantViewer(resolved.tenant.snapshot)(req, res).catch(() => writeFallbackError(res));
        })
        .catch(() => writeFallbackError(res));
      return;
    }
    // MCP over HTTP is claimed BEFORE the viewer, which registers no `/mcp` and
    // would answer its own 404 for a path this listener genuinely serves.
    if (mcp !== undefined && isMcpHttpPath(req.url)) {
      void mcp(req, res).catch(() => writeFallbackError(res));
      return;
    }
    if (graph !== undefined && isGraphPath(req.url)) {
      // The graph app is a full Express app; handing it the request keeps its
      // middleware order (cors, 405 shim, json parser) exactly as tested.
      graph(req, res);
      return;
    }
    // The mutation endpoints are tried BEFORE the viewer: they are POST, and the
    // viewer registers GET only, so a fall-through would answer 404 and the request
    // would silently never run. Without a project root there is nothing to mutate,
    // so the mount is simply absent rather than failing at request time.
    if (projectRoot !== undefined) {
      handleApiRequest(projectRoot, req, res, apiDeps)
        .then((handled) => {
          if (handled) return;
          viewer(req, res).catch(() => writeFallbackError(res));
        })
        .catch(() => writeFallbackError(res));
      return;
    }
    viewer(req, res).catch(() => writeFallbackError(res));
  };
}

/**
 * Build a viewer handler for a tenant snapshot, on demand.
 *
 * The port is read from the holder because binding resolves it: a `port: 0` request
 * only becomes a number after `listen`, and the viewer compares the incoming Host
 * against that number. Building tenants before binding would bake in `0` and reject
 * every tenant request with 403.
 *
 * @param host - Bound host.
 * @param portHolder - Filled in once the listener is bound.
 */
function tenantViewerFactory(
  host: string,
  portHolder: { port?: number },
  deps: Record<string, unknown>,
) {
  // `deps` is threaded through for the same reason as the default viewer: a product
  // operator injects one, and a tenant silently losing it would serve a different
  // surface than the default project.
  return (snapshot: ViewerSnapshot): ViewerRequestHandler =>
    createViewerHandler(snapshot, { host, port: portHolder.port ?? 0 }, deps);
}

/**
 * Remove a `/p/<slug>` prefix, keeping the query string.
 *
 * `req.url` is rewritten in place because every downstream handler reads it: the
 * viewer routes on the path, and passing the prefixed form through would make a
 * registered tenant 404 on its own content.
 *
 * @param url - Original request URL, possibly with a query string.
 * @param slug - Tenant segment already extracted from it.
 * @returns The same request without the tenant prefix.
 */
function stripTenantPrefix(url: string | undefined, slug: string): string {
  const raw = url ?? "/";
  const queryIndex = raw.indexOf("?");
  const pathname = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : raw.slice(queryIndex);
  const remainder = pathname.slice(`/p/${slug}`.length);
  return `${remainder === "" ? "/" : remainder}${query}`;
}

/** The socket may be half-written by the time an unexpected error surfaces. */
function writeFallbackError(res: ServerResponse): void {
  if (!res.headersSent) res.statusCode = 500;
  res.end();
}

/**
 * Paths the graph owns.
 *
 * A prefix test, not a regex per route: the graph mounts routers at several
 * depths including absolute root paths, so enumerating them here would duplicate
 * knowledge the graph itself already encodes. Prefixes are matched on segment
 * boundaries so `/healthz` is not mistaken for `/health`.
 *
 * `/domain` is first because it is the newest namespace and the only one that is
 * deliberately NOT oracle parity: `GET /domain/kg/stacks/{stack_id}/graph` reads
 * one Stack's graph as node-link JSON, a payload the AKS contract has no shape
 * for. It lives under its own prefix so the oracle paths above stay untouched —
 * a coordinator-side test pins that `/stacks` still reports the oracle's 405
 * `Allow`, and this entry is what keeps the endpoint reachable in the host at all:
 * without it the request falls through to the viewer and 404s, even though a
 * package-level test mounting `createApp()` directly would pass.
 */
const GRAPH_PATH_PREFIXES = [
  "/domain",
  "/health",
  "/stacks",
  "/aks",
  "/documents",
  "/ingest",
  "/synthesize",
] as const;

/** Does the graph sub-app own this URL? */
function isGraphPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  const pathname = url.split("?")[0] ?? "/";
  return GRAPH_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Start the host and its listener.
 *
 * @param options - Snapshot, bind address, and sub-app selection.
 */
export async function startHost(options: HostOptions): Promise<HostHandle> {
  const host = options.host ?? DEFAULT_HOST_ADDRESS;
  const port = options.port ?? DEFAULT_HOST_PORT;

  const graph = options.includeGraph === false ? undefined : createGraphApp();
  // The viewer validates the incoming `Host` header against this exact value, so it
  // must carry the port the listener ACTUALLY bound. Passing the requested port
  // would leave `port: 0` in the config and reject every request with a 403 for a
  // host it considers unacceptable — a bind-time detail leaking into an
  // authentication decision, which is why the config is built after binding.
  const viewerHolder: { handler?: ViewerRequestHandler } = {};
  // The viewer validates the incoming Host against the port the listener ACTUALLY
  // bound, so a tenant viewer cannot be built before binding resolves `port: 0`.
  const boundPortHolder: { port?: number } = {};
  const tenantMap = new Map((options.tenants ?? []).map((entry) => [entry.slug, entry]));
  // One registry per host, built before the listener so the deps object is stable
  // for every request. The viewer reads it through `viewerDeps` (the GET routes) and
  // the mutation mount through `apiDeps` (the 202 route): one store, two readers.
  //
  // The live registry is mirrored into Postgres when a Stack is configured, because
  // the memory view is readable only by THIS process and the MCP server is a
  // different one. Without the mirror an agent polling over MCP could never see a
  // job the host is running. A host with NO database keeps the plain in-memory
  // registry, which is the authority's explicit file mode; a host WITH a database and
  // no Stack bound now SERVES from a per-job registry that refuses the jobs it cannot
  // attribute, because refusing to build it is what stopped such a host from binding
  // and therefore from ever receiving the `POST /stacks` that creates the first Stack.
  // One write queue for every wrapper this host builds, and the thing `close` flushes. A queue
  // per wrapper would leave the shutdown walking wrappers that may already have been evicted
  // from the live registry — and the terminal write it is looking for is exactly the one that
  // would be missed.
  const jobMirrorQueue = options.jobMirrorQueue ?? createIngestJobMirrorQueue();
  const ingestJobs = options.ingestJobs ?? durableRegistryFor(process.env, jobMirrorQueue);
  // The read routes are mounted ONLY when this host serves a project to mutate:
  // a viewer without a project root has no jobs, and answering an empty list would
  // claim it looked. Omitting the registry makes the read answer 503 instead.
  const jobDeps = options.projectRoot === undefined ? {} : { ingestJobs };
  // Give the HTTP job reads the durable store when there is one, so
  // `GET /api/ingest/jobs` and the MCP `ingest_jobs_list` tool answer the same
  // question the same way. Without this the HTTP path kept reading process memory
  // and an external consumer lost every job on restart, while the MCP path — reading
  // the mirrored table — did not.
  const durableJobDeps = options.projectRoot === undefined
    ? {}
    : { durableIngestJobs: durableJobReadsFor(process.env) };
  // The viewer receives the registry and the durable reads, and NO resolved authority: the
  // Stack is a REQUEST input now, so `/api/reviews` resolves and validates the one a caller
  // names on each request. Passing a boot value here is what made the review list read a Stack
  // the boot had provisioned, which no longer exists.
  const viewerDeps = {
    ...jobDeps,
    ...durableJobDeps,
    ...(options.viewerDeps ?? {}),
  };
  // Mutable holder: the origin policy needs the ACTUALLY bound port, which only
  // exists after `listen`, so this record is filled in below rather than at
  // construction.
  const apiDeps: {
    ingestJobs?: JobRegistry;
    viewerConfig?: ApiDeps["viewerConfig"];
    dimensionsPort: IngestDimensionsPort;
    jobMirrorQueue: ApiDeps["jobMirrorQueue"];
  } = {
    ingestJobs,
    // The SAME queue the registry mirrors through, so a delete waits for that job's own
    // pending write. A route draining a different queue would order nothing at all.
    jobMirrorQueue,
    // Composed, never omitted: see `HostOptions.dimensionsPort`. A host always holds
    // a real port, so the mutation mount's required-port refusal is unreachable from
    // here and the container cannot ship dimension-less.
    dimensionsPort: options.dimensionsPort ?? createDimensionsPort(),
  };
  // MCP over HTTP, on the same listener. Mounted only when this host serves a
  // project: the tools operate on a root, and a host with none would accept MCP
  // calls it cannot answer. Version comes from the caller so this module never
  // reads package.json at runtime.
  const mcpHandler = options.projectRoot === undefined || options.mcpServerFactory === undefined
    ? undefined
    : (req: IncomingMessage, res: ServerResponse) =>
        handleMcpHttp(req, res, options.mcpServerFactory as Parameters<typeof handleMcpHttp>[2]);
  const server = http.createServer((req, res) => {
    const handler = viewerHolder.handler;
    if (handler === undefined) {
      res.statusCode = 503;
      res.end();
      return;
    }
    const dispatch = createDispatcher(
      graph, handler, options.projectRoot, tenantMap,
      tenantViewerFactory(host, boundPortHolder, options.viewerDeps ?? {}),
      apiDeps,
      mcpHandler,
    );
    dispatch(req, res);
  });

  // The rows a previous process left behind are settled HERE: after the registry exists (so a
  // job this process already holds is never settled) and before the listener accepts work, so a
  // restart cannot leave a row that every surface reads as work in progress. Bounded and
  // non-fatal by construction: see `reapAbandonedJobsAtBoot`.
  await reapAbandonedJobsAtBoot(process.env, ingestJobs);

  await listenOn(server, port, host);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("host bound but address is null");
  boundPortHolder.port = address.port;
  const boundConfig = { host, port: address.port };
  viewerHolder.handler = createViewerHandler(options.viewerSnapshot, boundConfig, viewerDeps);
  // The origin policy compares against the address ACTUALLY bound, which is why it
  // is captured here rather than at construction: `port: 0` is only resolved after
  // `listen`, and a stale `0` would reject every legitimate request.
  apiDeps.viewerConfig = boundConfig;

  /**
   * Close the listener and flush the job mirror, once.
   *
   * Memoised because `close()` is the ONE close path: the signal handler registers it
   * (`main.ts` → `registerShutdown(handle.close)`) and tests call it directly, and a second
   * `server.close()` throws on an already-closed listener. One close, one flush, one drain.
   *
   * The listener stops accepting first and the flush runs after, bounded by
   * `LLMWIKI_INGEST_JOB_FLUSH_TIMEOUT_MS`: a database that is already gone must not hold the
   * process open, and the job ids it left unwritten are reported rather than forgotten.
   */
  const closeOnce = async (): Promise<void> => {
    // Resolved with the error rather than rejected: this promise may not be awaited until
    // the bounded flush returns, and a rejection nobody has attached a handler to is an
    // unhandled rejection for a purely cosmetic reason.
    const drained = new Promise<Error | undefined>((resolve) => {
      server.close((error) => resolve(error));
    });
    const unwritten = await jobMirrorQueue.flush(resolveMirrorFlushTimeoutMs(process.env));
    if (unwritten.length > 0) {
      reportMirrorFailure(
        new Error(`shutdown left ${unwritten.length} mirror write(s) unwritten: ${unwritten.join(", ")}`),
      );
    }
    const drainError = await drained;
    if (drainError !== undefined) throw drainError;
  };
  let closing: Promise<void> | undefined;

  return {
    host,
    port: address.port,
    close: () => (closing ??= closeOnce()),
  };
}

