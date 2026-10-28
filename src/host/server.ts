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
 */
import http from "node:http";
import { listenOn } from "../utils/http-listen.js";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "llmwiki-kg/server";

/** The graph sub-app type, derived so this module needs no direct express import. */
type GraphApp = ReturnType<typeof createApp>;
import { createViewerHandler, type ViewerRequestHandler } from "../viewer/server.js";
import { handleApiRequest, type ApiDeps } from "./api.js";
import { handleMcpHttp, isMcpHttpPath } from "./mcp-http.js";
import { createJobRegistry, type JobRegistry } from "../services/ingest/jobs/registry.js";
import { createDurableJobRegistry } from "../services/ingest/jobs/durable-registry.js";
import { listIngestJobs, readIngestJob } from "../services/ingest/jobs/job-store.js";
import type { DurableJobReads } from "../viewer/api-ingest-jobs.js";
import {
  AKS_STACK_ID_ENV_VAR,
  createDimensionsDatabase,
} from "../dimensions/activation.js";
import { resolveTenant, tenantSlugOf, type TenantEntry } from "./tenants.js";
import { writeJsonError } from "../viewer/respond.js";
import type { ViewerSnapshot } from "../viewer/types.js";

/** Default port when the caller does not pin one. `0` asks the OS for a free port. */
const DEFAULT_HOST_PORT = 4173;
/** Default bind address: loopback, because a viewer exposes project contents. */
const DEFAULT_HOST_ADDRESS = "127.0.0.1";

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
}

/**
 * The durable job reads the viewer needs, or nothing when no Stack is configured.
 *
 * `undefined` is the honest answer rather than a stub: the viewer then falls back to
 * the in-memory registry, which is all a Stack-less host ever had.
 *
 * @param env - Environment carrying the Stack id; defaults to `process.env`.
 * @returns Readers bound to this host's Stack, or `undefined`.
 */
function durableJobReadsFor(env: NodeJS.ProcessEnv = process.env): DurableJobReads | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  const dimensionsDb = createDimensionsDatabase(env);
  return {
    list: (limit: number) => listIngestJobs(dimensionsDb.db, stackId, limit),
    get: (jobId: string) => readIngestJob(dimensionsDb.db, stackId, jobId),
  };
}

/**
 * Build the job registry this host should use.
 *
 * With a Stack configured, the live registry is wrapped so every transition is
 * also written to `wiki.ingest_job`. That is what lets `llmwiki serve` — a separate
 * process over stdio — answer job questions the host is running; the memory view is
 * invisible outside this process.
 *
 * The database handle is opened lazily by postgres-js (constructing a client does
 * not connect), so a host that never runs an async ingest never opens a socket.
 * A write failure is logged and swallowed: durability serves a later reader and must
 * never fail the ingest it is describing.
 *
 * Without a Stack there is nowhere durable to write, so the plain in-memory registry
 * is returned and the durable reader answers 503 rather than pretending.
 *
 * @param env - Environment carrying the Stack id; defaults to `process.env`.
 * @returns The registry the host should use.
 */
function durableRegistryFor(env: NodeJS.ProcessEnv = process.env): JobRegistry {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return createJobRegistry();
  const dimensionsDb = createDimensionsDatabase(env);
  return createDurableJobRegistry(createJobRegistry(), {
    db: dimensionsDb.db,
    stackId,
    onError: (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ingest-job] durable mirror failed: ${detail}\n`);
    },
  });
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
  // the memory view is readable only by THIS process and `llmwiki serve` (MCP) is a
  // different one. Without the mirror an agent polling over MCP could never see a
  // job the host is running. A host with no Stack keeps the plain in-memory
  // registry: there is nowhere durable to write, and the read side already answers
  // 503 in that configuration rather than pretending.
  const ingestJobs = options.ingestJobs ?? durableRegistryFor();
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
    : { durableIngestJobs: durableJobReadsFor() };
  const viewerDeps = { ...jobDeps, ...durableJobDeps, ...(options.viewerDeps ?? {}) };
  // Mutable holder: the origin policy needs the ACTUALLY bound port, which only
  // exists after `listen`, so this record is filled in below rather than at
  // construction.
  const apiDeps: { ingestJobs?: JobRegistry; viewerConfig?: ApiDeps["viewerConfig"] } = { ingestJobs };
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

  return {
    host,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

