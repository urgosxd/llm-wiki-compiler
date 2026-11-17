/**
 * Local read-only HTTP server for the llmwiki viewer.
 *
 * Built on Node's `http` module (no framework). The spec's mandatory
 * security headers (CSP, CORP, nosniff, Referrer-Policy) and the
 * Host / Origin / Sec-Fetch-Site rejection rules from
 * §Non-Negotiable Security Requirements apply to **every response**,
 * including 404s for unregistered paths and 403s for bad origin — see
 * `handleRequest` for the ordering rationale.
 *
 * Page and graph data come from the frozen `ViewerSnapshot`. Health, reviews,
 * and workflow receipts have their existing live read contracts. Resource
 * endpoints re-verify confined source/artifact bytes per request: a successful
 * startup snapshot must never authorize serving bytes changed afterwards.
 *
 * The two page endpoints live in `api-pages.ts` and the shared response
 * writers in `respond.ts`, so this file stays about transport: bind,
 * headers, origin policy, and route dispatch.
 */

import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { buildHealthResponse } from "./health.js";
import { handleApiPage, handleApiPages } from "./api-pages.js";
import { handleApiSource } from "./api-sources.js";
import { loadShellTemplate } from "./shell.js";
import { ASSETS_DIR, handleAsset } from "./static-assets.js";
import { searchPages } from "./search.js";
import { listCandidatePage } from "../compiler/candidates.js";
import { buildReviewsEnvelope, REVIEW_LIST_LIMIT } from "./reviews.js";
import { handleApiIngestJobs, isIngestJobsPath, INGEST_JOBS_PREFIX, INGEST_JOBS_PATH } from "./api-ingest-jobs.js";
import { tryRenderBody, writeJson, writeJsonError, writeRenderFailed } from "./respond.js";
import {
  namedStackRefusal,
  stackLookupFailedRefusal,
  unnamedStackRefusal,
  writeStackRefusal,
} from "./respond.js";
import type { ViewerSnapshot } from "./types.js";
// Type-only: the viewer must not DEPEND on the dimensions database (see
// `api-ingest-jobs.ts`), it only carries the authority a host already resolved.
import type { StackAuthority } from "../dimensions/stack-authority.js";
import { isDatabaseConfigured } from "../dimensions/activation.js";
import { createDimensionsDatabase } from "../dimensions/activation.js";
import { stackResolution } from "../services/stacks/stack-store.js";
import { stackIdProblem } from "@repo/foundation";
import { listenOn } from "../utils/http-listen.js";

/** Host-supplied viewer dependencies. */
type ViewerDeps = Record<string, unknown>;
import { buildViewerSnapshot } from "./snapshot.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

/** Exact CSP string the spec mandates. Pinned here to keep the test contract obvious. */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";

/** Configuration knobs accepted by `startViewerServer`. */
export interface ViewerServerConfig {
  /** Opt-in journey navigation; never advertised on a non-loopback bind. */
  workflowJourneys?: boolean;
  /** Listening host. `--allow-lan` callers set this to a non-loopback bind address. */
  host: string;
  /** Listening port. `0` lets the OS pick a free port. */
  port: number;
  /** Optional fixed live-provider deadline; omitted uses the run-proportionate default. */
  providerTimeoutMs?: number;
}

/** Handle returned by `startViewerServer`. */
interface ViewerServerHandle {
  /** Actual port the server bound to (resolves `port: 0`). */
  port: number;
  /** Actual host the server bound to. */
  host: string;
  /** Graceful shutdown — closes the listener and resolves when all sockets drain. */
  close(): Promise<void>;
}

/**
 * Bind the configured server to its host/port and resolve once `listen`
 * fires. Errors during bind (occupied port, invalid host) reject so the
 * CLI surfaces a clean failure instead of hanging. The internal config
 * the request handler uses is the actually-bound port — not the one the
 * caller passed in — so `--port 0` correctly accepts Host headers that
 * carry the OS-assigned port.
 */
export async function startViewerServer(
  snapshot: ViewerSnapshot,
  config: ViewerServerConfig,
  deps: ViewerDeps = {},
): Promise<ViewerServerHandle> {
  const boundConfig: ViewerServerConfig = { ...config };
  const server = http.createServer((req, res) => {
    handleRequest(req, res, snapshot, boundConfig, deps).catch((err) => {
      // Per spec: never return raw thrown error text to the client.
      // The per-route handlers catch render/sanitize failures locally
      // and emit `render_failed`; reaching here means a genuinely
      // unexpected bug, so surface a generic envelope.
      void err;
      if (!res.headersSent) {
        writeJsonError(res, 500, "internal_error", "Unexpected server error.");
      }
    });
  });
  await listenOn(server, config.port, config.host);
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("server bound but address is null");
  boundConfig.port = address.port;
  return {
    host: config.host,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Options for the public {@link startViewer} constructor. */
export interface StartViewerOptions {
  /** Show journey links on loopback; enabled by default for this new SDK constructor. */
  workflowJourneys?: boolean;
  /** Absolute project root the viewer reads from. */
  root: string;
  /** Listening host. */
  host: string;
  /** Listening port (`0` lets the OS pick). */
  port: number;
  /** Override the live stage-projection provider deadline in milliseconds. */
  providerTimeoutMs?: number;
}

/**
 * The GENERIC public viewer entry: build the frozen snapshot from `root` and start the
 * server, threading optional construction-time `deps` (e.g. a product's live
 * verified-stage projection provider). CORE owns snapshot construction here, so a
 * product operator entry injects a provider WITHOUT deep-importing `buildViewerSnapshot`
 * or reproducing snapshot building. The core viewer entry (`startViewer`, called
 * by a product's host process) passes no deps.
 */
export async function startViewer(
  options: StartViewerOptions,
  deps: ViewerDeps = {},
): Promise<ViewerServerHandle> {
  const snapshot = await buildViewerSnapshot(options.root);
  const timeout = options.providerTimeoutMs;
  const config = { host: options.host, port: options.port, workflowJourneys: options.workflowJourneys ?? true,
    ...(timeout === undefined ? {} : { providerTimeoutMs: timeout }) };
  return startViewerServer(snapshot, config, deps);
}

/**
 * Dispatch a single request. The order matters:
 *   1. Set the mandatory security headers — every response carries them,
 *      including 404s for unknown paths and 403s for bad Host/Origin.
 *   2. Validate Host / Origin / Sec-Fetch-Site. Hostile-origin requests
 *      to unknown paths must still return 403, not a header-less 404.
 *   3. Dispatch to a registered route, or surface a JSON 404 envelope
 *      for anything else.
 * That ordering closes the DNS-rebind / cross-site leakage gap the
 * naive "404 first, then security" flow would leave behind.
 */
/** Mount point signature for a host that owns the listener. */
export type ViewerRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

/**
 * Build the request handler without binding a listener.
 *
 * `startViewerServer` owns its own `http.Server`, which makes the viewer
 * impossible to mount inside a larger host. Splitting the handler out lets a
 * host share one listener and one lifecycle while this module keeps ownership
 * of headers, origin policy and route dispatch.
 *
 * @param snapshot - Frozen startup snapshot the routes read from.
 * @param config - Bound server config; `port` is unused by the handler itself.
 * @param deps - Injected collaborators for tests and the workflow projection.
 */
export function createViewerHandler(
  snapshot: ViewerSnapshot,
  config: ViewerServerConfig,
  deps: ViewerDeps = {},
): ViewerRequestHandler {
  const boundConfig: ViewerServerConfig = { ...config };
  return (req, res) => handleRequest(req, res, snapshot, boundConfig, deps);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  snapshot: ViewerSnapshot,
  config: ViewerServerConfig,
  deps: ViewerDeps,
): Promise<void> {
  applySecurityHeaders(res);
  if (!validateOriginHeaders(req, config)) {
    writeJsonError(res, 403, "forbidden", "rejected by origin policy");
    return;
  }
  const url = new URL(req.url ?? "/", buildOriginBase(config));
  if (!isRouteRegistered(req.method, url.pathname)) {
    writeJsonError(res, 404, "not_found", `${req.method ?? "?"} ${url.pathname}`);
    return;
  }
  await routeRegistered(req, res, url, snapshot, config, deps);
}

/**
 * Dispatch the request to whichever registered handler owns this path.
 * `isLoopback` controls whether the rendered citation chips include
 * `absolutePath` / editor-link payloads — non-loopback binds suppress
 * both per spec §Support Rail.
 */
async function routeRegistered(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  snapshot: ViewerSnapshot,
  config: ViewerServerConfig,
  deps: ViewerDeps,
): Promise<void> {
  if (parsedUrl.pathname === "/") return handleShell(res);
  if (parsedUrl.pathname.startsWith("/assets/")) return handleAsset(res, parsedUrl.pathname);
  const snapshotOnly = SNAPSHOT_ONLY_HANDLERS.get(parsedUrl.pathname);
  if (snapshotOnly) return snapshotOnly(res, snapshot, parsedUrl);
  return routeLiveResources(res, parsedUrl, snapshot, config, deps);
}

/** Route request-time resource reads without mixing them with static shell dispatch. */
async function routeLiveResources(
  res: ServerResponse, parsedUrl: URL, snapshot: ViewerSnapshot,
  config: ViewerServerConfig, deps: ViewerDeps,
): Promise<void> {
  const isLoopback = LOOPBACK_HOSTS.has(config.host);
  if (parsedUrl.pathname === "/api/index") return handleApiIndex(res, snapshot, isLoopback);
  if (parsedUrl.pathname === "/api/search") return handleApiSearch(res, parsedUrl, snapshot);
  if (parsedUrl.pathname.startsWith("/api/source/")) return handleApiSource(res, snapshot, parsedUrl.pathname, isLoopback);
  if (parsedUrl.pathname.startsWith("/api/page/")) {
    return handleApiPage(res, parsedUrl.pathname, snapshot, isLoopback);
  }
  if (isIngestJobsPath(parsedUrl.pathname)) {
    return await handleApiIngestJobs(res, parsedUrl, deps);
  }
  // Unreachable: `isRouteRegistered` is the gate, and every branch
  // there has a matching dispatch above. If it ever fires, the two
  // functions have drifted — fail loudly rather than silently 404.
  throw new Error(`route registration drift: no handler for ${parsedUrl.pathname}`);
}

/** Enable journey navigation only for loopback with an explicit opt-in or provider. */
function workflowJourneysEnabled(config: ViewerServerConfig, deps: ViewerDeps): boolean {
  return LOOPBACK_HOSTS.has(config.host) &&
    (config.workflowJourneys === true || deps.liveStageProjectionProvider !== undefined);
}


/**
 * Exact-path API routes that need only `(res, snapshot)` — collapsed into one
 * lookup table so adding such a route is a single map entry rather than another
 * `if` in `routeRegistered` (which keeps that dispatcher's branching, and thus its
 * complexity, flat). `/api/workflow-runs` and `/api/reviews` both read from
 * `snapshot.root` at request time. Routes with extra params (`/api/index`,
 * `/api/search`) and the prefix routes stay as explicit branches.
 *
 * The parsed URL is handed to every entry because `/api/reviews` resolves the Stack the REQUEST
 * names (`?stackId=`), and a handler that needs no query simply declares fewer parameters. It is
 * the request's own URL rather than a resolved dependency: authority is a request input now, so
 * there is no boot value left to pass and nothing here may fall back to one.
 */
const SNAPSHOT_ONLY_HANDLERS: ReadonlyMap<
  string,
  (res: ServerResponse, snapshot: ViewerSnapshot, url: URL) => void | Promise<void>
> = new Map<string, (res: ServerResponse, snapshot: ViewerSnapshot, url: URL) => void | Promise<void>>([
  ["/api/pages", handleApiPages],
  ["/api/health", handleApiHealth],
  ["/api/graph", handleApiGraph],
  ["/api/reviews", (res, snapshot, url) => handleApiReviews(res, snapshot.root, url)],
]);

/**
 * Exact-path registered routes for v1. Kept as a Set so additions are
 * just a string in one place and the membership test stays O(1).
 */
const REGISTERED_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/api/pages",
  "/api/index",
  "/api/health",
  "/api/search",
  "/api/graph",
  "/api/reviews",
  INGEST_JOBS_PATH,
]);

/**
 * Prefix routes that actually have a dispatch branch in `routeLiveResources`.
 *
 * `/api/workflows/` sat here after the workflow subsystem was buried, so
 * `isRouteRegistered` called it a v1 route while no branch existed -- and
 * `routeLiveResources` threw its drift error, surfacing as a 500 where the origin
 * policy's 403 belonged.
 */
const REGISTERED_PATH_PREFIXES: readonly string[] = [
  "/assets/", "/api/page/", "/api/source/", INGEST_JOBS_PREFIX,
];

/**
 * Every exact path must have a dispatch branch. Checked at module load so a route
 * cannot be registered without a handler -- the alternative is a 500 that reads as
 * a server fault when the real fault is a stale registry.
 */
const DISPATCHED_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/",
  ...SNAPSHOT_ONLY_HANDLERS.keys(),
  "/api/index",
  "/api/search",
  INGEST_JOBS_PATH,
]);
for (const path of REGISTERED_EXACT_PATHS) {
  if (!DISPATCHED_EXACT_PATHS.has(path)) {
    throw new Error(`registered route without a handler: ${path}`);
  }
}

/** True when (method, path) is one of the v1 registered routes. */
function isRouteRegistered(method: string | undefined, pathname: string): boolean {
  if (method !== "GET") return false;
  if (REGISTERED_EXACT_PATHS.has(pathname)) return true;
  return REGISTERED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Stamp every response with the mandatory security headers. Called
 * first in `handleRequest` so unregistered-route 404s and bad-origin
 * 403s carry the same hardening as the v1 API responses.
 */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Apply the Host / Origin / Sec-Fetch-Site rejection rules from
 * §Non-Negotiable Security Requirements. Returns false when a request
 * should be rejected with 403; the caller writes the error envelope.
 */
export function validateOriginHeaders(req: IncomingMessage, config: ViewerServerConfig): boolean {
  const host = req.headers.host;
  if (!host || !isAcceptableHost(host, config)) return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    if (!isSameOrigin(origin, config)) return false;
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return false;
  return true;
}

/**
 * True when the incoming `Host` header matches the configured bind.
 * Handles IPv4 (`127.0.0.1:PORT`), IPv6 (`[::1]:PORT` — clients always
 * bracket the host portion when the Host header carries a literal IPv6
 * address per RFC 3986/7230), and the `localhost` alias on both
 * loopback families.
 */
function isAcceptableHost(hostHeader: string, config: ViewerServerConfig): boolean {
  for (const acceptable of buildAcceptableHostHeaders(config)) {
    if (hostHeader === acceptable) return true;
  }
  return false;
}

/** Every Host header value we accept for the current bind. */
function buildAcceptableHostHeaders(config: ViewerServerConfig): string[] {
  const formattedBind = formatHostHeader(config.host, config.port);
  const accepted = [formattedBind];
  if (config.host === "127.0.0.1" || config.host === "::1") {
    accepted.push(`localhost:${config.port}`);
  }
  return accepted;
}

/** True when the incoming `Origin` resolves to our own host:port. */
function isSameOrigin(origin: string, config: ViewerServerConfig): boolean {
  try {
    const parsed = new URL(origin);
    const expectedHostname = normalizeHostnameForOrigin(config.host);
    const originHostname = normalizeHostnameForOrigin(parsed.hostname);
    return originHostname === expectedHostname && Number(parsed.port) === config.port;
  } catch {
    return false;
  }
}

/**
 * Format a Host header value for the given bind. IPv6 addresses must
 * be bracketed (`[::1]:54391`); IPv4 and named hosts go in bare. The
 * heuristic for "literal IPv6" is a colon in the host portion — domain
 * names and IPv4 dotted-quads never contain `:`.
 */
function formatHostHeader(host: string, port: number): string {
  if (host.includes(":")) return `[${host}]:${port}`;
  return `${host}:${port}`;
}

/**
 * Build a URL base suitable for the `new URL(req.url, base)` resolver.
 * IPv6 literal hosts must be bracketed inside a URL — `http://::1:PORT/`
 * is malformed and `new URL` throws. The bracketed form is the only
 * legal way to express a literal IPv6 host in a URL.
 */
function buildOriginBase(config: ViewerServerConfig): string {
  if (config.host.includes(":")) return `http://[${config.host}]:${config.port}`;
  return `http://${config.host}:${config.port}`;
}

/**
 * `URL.hostname` strips the brackets from a parsed IPv6 origin
 * (`new URL("http://[::1]/").hostname === "::1"`), so compare against
 * the bare form. Lowercased for case-insensitive equality (RFC 3986
 * says the host is case-insensitive).
 */
function normalizeHostnameForOrigin(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/**
 * Serve the viewer shell. Reads `index.html` lazily through `loadShellTemplate`
 * (process-cached) and returns it verbatim with `Content-Type: text/html` — the
 * shell carries no per-request data, so the client's own `/api/pages` fetch is
 * the single source of the page list (see `shell.ts`). A missing template
 * surfaces as a 500 `shell_missing` so the rest of the routes stay usable when
 * the asset bundle is incomplete.
 */
async function handleShell(res: ServerResponse): Promise<void> {
  const template = await loadShellTemplate(ASSETS_DIR);
  if (template === null) {
    writeJsonError(res, 500, "shell_missing", "Viewer shell template not found on disk.");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(template);
}

/** `/api/index` — rendered `wiki/index.md` with resolved outgoing links. */
function handleApiIndex(
  res: ServerResponse,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): void {
  if (!snapshot.index.available) {
    writeJsonError(res, 404, "index_unavailable", "wiki/index.md is not present.");
    return;
  }
  const rendered = tryRenderBody(snapshot.index.body, snapshot, isLoopback);
  if (rendered === null) {
    writeRenderFailed(res);
    return;
  }
  writeJson(res, 200, {
    html: rendered.html,
    outgoingLinks: snapshot.index.outgoingLinks,
    generatedAt: snapshot.generatedAt,
  });
}

/** Serve the frozen graph adjacency data for the `#/graph` route. */
function handleApiGraph(res: ServerResponse, snapshot: ViewerSnapshot): void {
  writeJson(res, 200, snapshot.graph);
}

/**
 * `/api/workflow-runs` — read-only projection of every workflow run's
 * status/classification. Runs live under `.llmwiki/workflows/runs/` (NOT in
 * the frozen snapshot), so this reads them at REQUEST time via the shared
 * `workflowStatus(root)` classifier — which already surfaces an
 * unavailable/corrupt store as a fail-visible `problem` row rather than an
 * empty list. Strictly read-only: no run-state mutation, status fields only
 * (no machine-local paths).
 */

/**
 * The Stack `/api/reviews` reads for one request, or the refusal already written.
 *
 * A result rather than a bare authority because `undefined` is a real answer — the named FILE
 * backend — and a refusal is not an authority at all. Conflating them is how a refused request
 * would answer 200 from the checkout.
 */
type ReviewsStack =
  | { readonly ok: true; readonly authority: StackAuthority | undefined }
  | { readonly ok: false };

/**
 * `/api/reviews` — read-only projection of the pending review queue, for the Stack THIS request
 * names.
 *
 * Candidates live under `.llmwiki/candidates/` (NOT in the frozen snapshot), so this reads them
 * at REQUEST time. It reads a BOUNDED page rather than the whole queue: `listCandidatePage` opens
 * only the candidates it serves, so a corpus held wholesale by `heldReasons: "all"` costs the
 * same per request as a handful. `total` still reports the real queue depth, which the client
 * renders as "showing N of M". Deliberately NOT folded into `/api/health`: that payload is
 * fetched by every route at bootstrap and must stay cheap. Strictly read-only — no approve/reject,
 * and the projection drops the candidate `body` and every absolute path (see
 * `buildReviewsEnvelope`).
 *
 * ## Why this resolves per request, and what it refuses
 *
 * The boot no longer resolves a Stack (S6 of `odd/tasks/stack-authority-per-request.md`), so a
 * value captured at startup cannot describe the Stack this request is about — the exact staleness
 * this surface was the evidence for. `?stackId=` names it, and the name is checked against the
 * database on every request (`stackResolution` issues one query; nothing is cached), which is what
 * makes a Stack created by `POST /stacks` usable by the very next request with no restart.
 *
 * A request that names NONE is refused as `stack_unnamed` (409) when a database is configured:
 * falling through would answer from whichever Stack the environment names, or from the checkout's
 * `.llmwiki/candidates`, and both are the silent substitution S3 forbids. The envelope is
 * {@link unnamedStackRefusal}'s — the ONE definition of that code, shared with the two ingest
 * routes rather than restated here, so a client branching on it sees one wording on every
 * surface.
 *
 * A NAMED id is settled by the shared tri-state lookup, which keeps two different answers
 * separate: absent is `unknown_stack`, retired is `stack_inactive` (S10), and only an active
 * Stack is read from.
 *
 * With NO database configured the named file backend answers exactly as before, and a `stackId`
 * names nothing there because there is no Stack table to check it against.
 *
 * @param res - Response to write, including any refusal.
 * @param root - Project root the file backend reads from.
 * @param url - This request's URL, carrying the Stack the caller named.
 */
async function handleApiReviews(res: ServerResponse, root: string, url: URL): Promise<void> {
  const stack = await reviewsStackFor(res, (url.searchParams.get("stackId") ?? "").trim());
  if (!stack.ok) return;
  const page = await listCandidatePage(root, process.env, REVIEW_LIST_LIMIT, stack.authority);
  writeJson(res, 200, buildReviewsEnvelope(page));
}

/**
 * Settle, and VALIDATE, the Stack one `/api/reviews` request is about.
 *
 * Validation is the same shared lookup the mutation mount uses, deliberately: a Stack id a
 * client invents must be refused the same way on every surface, and a Stack that was created (or
 * deactivated) a moment ago must be visible to the next request rather than to the next restart.
 *
 * @param res - Response to write the refusal on.
 * @param named - The trimmed `stackId` query value; empty when the request named none.
 * @returns The backend to read, or `{ ok: false }` after the refusal was written.
 */
async function reviewsStackFor(res: ServerResponse, named: string): Promise<ReviewsStack> {
  if (named === "") {
    // No database: the file backend is this deployment's backend, not a fallback, and the
    // environment decides exactly as it always has (S7).
    if (!isDatabaseConfigured(process.env)) return { ok: true, authority: undefined };
    writeStackRefusal(res, unnamedStackRefusal());
    return { ok: false };
  }
  const problem = stackIdProblem(named);
  if (problem !== undefined) {
    writeJsonError(res, 400, "invalid_stack_id", problem);
    return { ok: false };
  }
  const dimensionsDb = createDimensionsDatabase(process.env);
  try {
    const refusal = namedStackRefusal(named, await stackResolution(dimensionsDb.db, named));
    if (refusal !== undefined) {
      writeStackRefusal(res, refusal);
      return { ok: false };
    }
    return { ok: true, authority: { kind: "stack", stackId: named } };
  } catch (error) {
    writeStackRefusal(res, stackLookupFailedRefusal(named, error));
    return { ok: false };
  } finally {
    await dimensionsDb.close();
  }
}

/** `/api/health` — cheap status summary. */
async function handleApiHealth(res: ServerResponse, snapshot: ViewerSnapshot): Promise<void> {
  const health = await buildHealthResponse(snapshot);
  writeJson(res, 200, health);
}

/**
 * `/api/search?q=...` — substring search over the startup snapshot. The
 * query string is read directly from the parsed URL (Node's URL parser
 * has already percent-decoded it); `searchPages` does its own length
 * cap and tokenization. An empty or missing `q` returns an empty
 * results array, consistent with the no-tokens case.
 */
function handleApiSearch(
  res: ServerResponse,
  parsedUrl: URL,
  snapshot: ViewerSnapshot,
): void {
  const query = parsedUrl.searchParams.get("q") ?? "";
  writeJson(res, 200, searchPages(snapshot, query));
}
