/**
 * @file src/host/api.ts
 * @description The official mutation endpoints: `POST /api/ingest` and
 * `POST /api/compile`.
 *
 * ## Why these are the official surface
 *
 * This compiler was merged with a knowledge-graph service, so `ingest` writes
 * across a markdown file and Postgres, which share no transaction manager. The
 * project lock and the dimension coordinator are the only things keeping the two
 * in sync, and the ONLY way a client can preserve that guarantee is to reach the
 * same service the CLI reaches. These endpoints are that path over HTTP; they hold
 * no logic of their own beyond mapping a service outcome onto a status code.
 *
 * ## Why they live beside the viewer rather than in the graph app
 *
 * The graph app carries fail-open authentication because the vendored AKS server
 * had none. These endpoints MUTATE the project, so they belong on the fail-closed
 * side. Mounting them in the graph app would have inherited the wrong trust
 * boundary — the split is per-mount for exactly this reason.
 *
 * ## "Beside" the viewer is NOT "inside" it
 *
 * This mount runs BEFORE the viewer (`src/host/server.ts`), so it does not inherit
 * the origin policy the viewer applies to the paths it dispatches. An earlier
 * revision of this comment claimed the check "already applies" here, and it did
 * not: a cross-origin `POST` with a non-JSON content type reached the mutation
 * unauthenticated. {@link passesOriginPolicy} now applies the same headers and the
 * same Host/Origin/Sec-Fetch-Site rules on this side, which is what makes the claim
 * true rather than merely intended.
 *
 * ## Synchronous by default, busy-answerable, optionally asynchronous
 *
 * A request without `async` runs the work to completion rather than queueing it. A
 * client that triggers a long compile is not a reason to block OTHER clients: the
 * lock makes contention visible instead of hiding it, and a second caller gets 409
 * straight away rather than waiting behind an invisible queue.
 *
 * `{"async": true}` is the opt-in escape from that wait: it answers 202 with a job
 * identity and runs the work detached, so a caller that cannot hold a connection
 * open still gets progress. The synchronous contract is untouched for every
 * existing client.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { writeJson, writeJsonError } from "../viewer/respond.js";
import { ingestSource } from "../services/ingest/service.js";
import { compileAndReport } from "../compiler/index.js";
import { LockBusyError } from "../utils/lock.js";
import { applySecurityHeaders, validateOriginHeaders } from "../viewer/server.js";
import type { ViewerServerConfig } from "../viewer/server.js";
import type { JobRegistry } from "../services/ingest/jobs/registry.js";
import { runIngestJob } from "../services/ingest/jobs/run.js";
import type { IngestJobAccepted } from "../services/ingest/jobs/types.js";
import type { CompileResult, IngestResult } from "../utils/types.js";

/** Largest request body these endpoints accept, in bytes. */
const MAX_BODY_BYTES = 1024 * 64;

/** What the ingest endpoint accepts. */
interface IngestRequest {
  readonly source: string;
  /** Set false to ingest without compiling; defaults to compiling. */
  readonly compile?: boolean;
  /**
   * Answer 202 with a job id immediately, and run the work in the background.
   *
   * Opt-in rather than the default: the synchronous contract is what the MCP
   * server, the SDK and every existing test already rely on, and silently turning
   * a 200 into a 202 would break all of them to serve one new client.
   */
  readonly async?: boolean;
}

/**
 * Read and parse a JSON body, bounded.
 *
 * A cap is not optional here: these endpoints mutate the project and a caller can
 * stream an unbounded body, so the limit is what keeps one request from consuming
 * the process. Rejecting oversized input is a 413, not a silent truncation.
 *
 * @param req - Incoming request.
 * @returns The parsed body, or an error describing why it was refused.
 */
async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      return { ok: false, status: 413, message: `body exceeds ${MAX_BODY_BYTES} bytes` };
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, message: "body is not valid JSON" };
  }
}

/**
 * Handle a service throw by mapping it onto the right status.
 *
 * Lock contention is the one case a caller must distinguish: it is not a failure
 * of the request, it is a retry signal, so it answers 409 rather than 500.
 *
 * @param res - Response to write.
 * @param root - Project root, for the message.
 * @param error - Whatever the service threw.
 */
function respondToThrow(res: ServerResponse, root: string, error: unknown): void {
  if (error instanceof LockBusyError) {
    writeJsonError(res, 409, "busy", `another mutation holds the lock for ${root}; retry`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  writeJsonError(res, 500, "internal_error", message);
}


/**
 * Dependencies the mutation mount may be given.
 *
 * Both optional, and both absent means "behave exactly as before": no job
 * registry means the async route answers 503 and the synchronous one is
 * untouched, and no config means the origin check cannot be evaluated.
 */
export interface ApiDeps {
  /** Registry the async route creates jobs in. */
  readonly ingestJobs?: JobRegistry;
  /**
   * Bind config the origin policy compares against.
   *
   * Supplied by the host, which is the only layer that knows the address it
   * actually bound. Absent means the check is skipped rather than silently
   * guessed, because a wrong config would reject every legitimate request.
   */
  readonly viewerConfig?: ViewerServerConfig;
}

/**
 * Create a job and answer 202, then run it detached from the response.
 *
 * The work is started with `void` on purpose: the response must not wait for it,
 * which is the entire point of the async contract. `runIngestJob` resolves rather
 * than rejecting and records every failure on the job, so there is no unhandled
 * rejection to attach here.
 *
 * If no registry is mounted the request is refused BEFORE any work starts, so a
 * caller that asked to be tracked is never quietly processed untracked.
 *
 * @param root - Project root the job mutates.
 * @param source - Source identity to ingest.
 * @param compile - Whether to compile after ingesting.
 * @param res - Response to answer 202 on.
 * @param deps - Mount dependencies, carrying the registry when one is mounted.
 */
function acceptAsyncIngest(
  root: string,
  source: string,
  compile: boolean,
  res: ServerResponse,
  deps: ApiDeps,
): void {
  const registry = deps.ingestJobs;
  if (registry === undefined) {
    writeJsonError(res, 503, "jobs_unavailable", "this host does not track ingest jobs");
    return;
  }
  const job = registry.create(source, new Date());
  const accepted: IngestJobAccepted = {
    jobId: job.id,
    status: job.ingest.status,
    stage: "queued",
    ingest: job.ingest,
    compile: job.compile,
  };
  writeJson(res, 202, accepted);
  void runIngestJob({ root, registry, job, compile });
}

/**
 * `POST /api/ingest` -- ingest one source AND compile the wiki in one call.
 *
 * The endpoint used to stop after ingesting, leaving the caller to discover that
 * a second request to `/api/compile` was required before the source became a page
 * anything could query. Two commands for one intent is a trap: the source is on
 * disk, `ingest` reported success, and the wiki is still empty.
 *
 * Compilation is reported alongside ingestion rather than replacing it. A compile
 * that fails (no provider, lock contention) still leaves the source ingested, and
 * the caller needs to see BOTH outcomes to decide whether to retry -- collapsing
 * them into one status would hide which half succeeded.
 *
 * `{ "compile": false }` opts out for a caller that wants to batch several ingests
 * and compile once at the end.
 */
async function handleIngest(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const request = await readIngestRequest(req, res);
  if (request === undefined) return;
  if (request.async === true) {
    acceptAsyncIngest(root, request.source, request.compile !== false, res, deps);
    return;
  }
  await runSyncIngest(root, request, res);
}

/**
 * Read and validate the ingest body, answering the request itself on a bad one.
 *
 * Returns `undefined` when it already wrote a response, so the caller has one place
 * to branch on and no second error path to keep in step with this one.
 *
 * @param req - Incoming request.
 * @param res - Response to answer a validation failure on.
 * @returns The valid request, or `undefined` when a response was already sent.
 */
async function readIngestRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<IngestRequest | undefined> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    writeJsonError(res, body.status, "invalid_request", body.message);
    return undefined;
  }
  const request = body.value as IngestRequest | undefined;
  const source = request?.source;
  if (typeof source !== "string" || source.trim() === "") {
    writeJsonError(res, 400, "invalid_request", "body must be {\"source\": \"<url-or-path>\"}");
    return undefined;
  }
  return { ...request, source };
}

/**
 * Run the original synchronous ingest-and-compile and answer 200.
 *
 * Unchanged in behaviour: this is the contract the MCP server, the SDK and every
 * existing test rely on, and the async route is an addition beside it rather than a
 * replacement for it.
 *
 * @param root - Project root to mutate.
 * @param request - A validated ingest request.
 * @param res - Response to answer on.
 */
async function runSyncIngest(
  root: string,
  request: IngestRequest,
  res: ServerResponse,
): Promise<void> {
  try {
    const ingested: IngestResult = await ingestSource(root, request.source);
    if (request.compile === false) {
      writeJson(res, 200, { ...ingested, compiled: null });
      return;
    }
    const compiled: CompileResult = await compileAndReport(root);
    // `busy` means the compile never started (another holds the lock). The source
    // IS ingested, so this is a retryable compile outcome, not a failed request.
    writeJson(res, 200, { ...ingested, compiled, compileBusy: compiled.busy === true });
  } catch (error) {
    respondToThrow(res, root, error);
  }
}

/**
 * Apply the viewer's security headers and origin policy to a mutation request.
 *
 * This mount runs BEFORE the viewer, so it never inherited the checks the viewer
 * performs — which contradicts the assumption its own header used to state. Applying
 * them here is what makes the claim true on the paths this module actually serves.
 *
 * When no config was supplied there is nothing to compare a Host against, so the
 * headers are still stamped and the comparison is skipped. Refusing every request
 * would break callers whose host never passes a config, and guessing a config would
 * reject legitimate ones.
 *
 * @param req - Incoming request.
 * @param res - Response the rejection would be written to.
 * @param deps - Mount dependencies, carrying the config when the host supplied one.
 * @returns False when the request was rejected and a response was already written.
 */
function passesOriginPolicy(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): boolean {
  applySecurityHeaders(res);
  if (deps.viewerConfig === undefined) return true;
  if (validateOriginHeaders(req, deps.viewerConfig)) return true;
  writeJsonError(res, 403, "forbidden", "rejected by origin policy");
  return false;
}

/** `POST /api/compile` — compile sources/ into the wiki. */
async function handleCompile(root: string, res: ServerResponse): Promise<void> {
  try {
    const result: CompileResult = await compileAndReport(root);
    // `busy` means the service returned without doing the work; the request never
    // started rather than failing, so it is a conflict a client can retry.
    if (result.busy === true) {
      writeJsonError(res, 409, "busy", "another compile is in progress");
      return;
    }
    writeJson(res, 200, result);
  } catch (error) {
    respondToThrow(res, root, error);
  }
}

/**
 * Route an API request, or report that this path is not ours.
 *
 * Returning `false` lets the caller fall through to the viewer, so the two mounts
 * stay independent instead of one having to know the other's route table.
 *
 * @param root - Project root the mutations apply to.
 * @param req - Incoming request.
 * @param res - Response to write when handled.
 * @returns True when this module owned the request.
 */
export async function handleApiRequest(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps = {},
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "POST" && pathname === "/api/ingest") {
    if (!passesOriginPolicy(req, res, deps)) return true;
    await handleIngest(root, req, res, deps);
    return true;
  }
  if (req.method === "POST" && pathname === "/api/compile") {
    if (!passesOriginPolicy(req, res, deps)) return true;
    await handleCompile(root, res);
    return true;
  }
  return false;
}
