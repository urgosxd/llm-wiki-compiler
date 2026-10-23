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
 * had none. These endpoints MUTATE the project, so they belong on the viewer's
 * fail-closed side, where the origin check already applies. Mounting them in the
 * graph app would have inherited the wrong trust boundary — the split is per-mount
 * for exactly this reason.
 *
 * ## Synchronous, busy-answerable
 *
 * Both endpoints run the work to completion rather than queueing it. A client that
 * triggers a long compile is not a reason to block OTHER clients: the lock makes
 * contention visible instead of hiding it, and a second caller gets 409 straight
 * away rather than waiting behind an invisible queue.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { writeJson, writeJsonError } from "../viewer/respond.js";
import { ingestSource } from "../services/ingest/service.js";
import { compileAndReport } from "../compiler/index.js";
import { LockBusyError } from "../utils/lock.js";
import type { CompileResult, IngestResult } from "../utils/types.js";

/** Largest request body these endpoints accept, in bytes. */
const MAX_BODY_BYTES = 1024 * 64;

/** What the ingest endpoint accepts. */
interface IngestRequest {
  readonly source: string;
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

/** `POST /api/ingest` — ingest one source into the project. */
async function handleIngest(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    writeJsonError(res, body.status, "invalid_request", body.message);
    return;
  }
  const source = (body.value as IngestRequest | undefined)?.source;
  if (typeof source !== "string" || source.trim() === "") {
    writeJsonError(res, 400, "invalid_request", "body must be {\"source\": \"<url-or-path>\"}");
    return;
  }
  try {
    const result: IngestResult = await ingestSource(root, source);
    writeJson(res, 200, result);
  } catch (error) {
    respondToThrow(res, root, error);
  }
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
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "POST" && pathname === "/api/ingest") {
    await handleIngest(root, req, res);
    return true;
  }
  if (req.method === "POST" && pathname === "/api/compile") {
    await handleCompile(root, res);
    return true;
  }
  return false;
}
