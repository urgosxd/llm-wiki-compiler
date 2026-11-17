/**
 * How the viewer's HTTP layer writes a response.
 *
 * Extracted from `server.ts` when the page handlers moved to `api-pages.ts`:
 * both files need the same JSON writers and the same render-failure envelope,
 * and duplicating them is exactly how two routes end up disagreeing about the
 * error shape a client is promised.
 *
 * Every error goes out through {@link writeJsonError}'s single
 * `{ error: { code, message } }` envelope, and {@link tryRenderBody} swallows
 * the thrown text so a render or sanitize failure surfaces as the spec's
 * `render_failed` rather than leaking internals to the client.
 */

import type { ServerResponse } from "http";
import { renderPageHtml } from "./render.js";
import type { ViewerSnapshot } from "./types.js";
import type { StackResolution } from "../services/stacks/stack-store.js";

/** Write a JSON response body with the given status. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Standard `{ error: { code, message } }` envelope. */
export function writeJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(res, status, { error: { code, message } });
}

/**
 * A Stack a request could not use, as every surface's envelope carries it.
 *
 * `code` is the part a client branches on and the part that must not multiply: S10 of
 * `odd/tasks/stack-authority-per-request.md` names exactly these four, and a route that
 * invents a fifth spelling for one of these facts is the drift this type exists to prevent.
 */
export interface StackRefusal {
  readonly status: number;
  readonly code: "stack_unnamed" | "unknown_stack" | "stack_inactive" | "stack_lookup_failed";
  readonly message: string;
}

/**
 * THE `stack_unnamed` refusal (409): one definition, every surface that can produce it.
 *
 * The fact it states is narrow and it says all of it: the REQUEST named no Stack, a database
 * IS configured (so file mode is not the answer), and the remedy is on the request. It must
 * never become "the process named none" — a request inheriting the host's configured Stack is
 * the ambient authority S3 deletes, and a message that offered that as an alternative would
 * teach the mistake.
 *
 * @returns The refusal, ready to write.
 */
export function unnamedStackRefusal(): StackRefusal {
  return {
    status: 409,
    code: "stack_unnamed",
    message: "This request named no Stack, and a database is configured: name one with ?stackId=.",
  };
}

/**
 * The refusal a NAMED Stack deserves, or `undefined` when it may be used.
 *
 * Three answers from the one tri-state lookup (`stackResolution`), because "retired" and
 * "never existed" are different facts for the operator reading the refusal: an inactive Stack
 * keeps its id, its domain and its content and can be reactivated, while an absent one cannot.
 * Collapsing them into `unknown_stack` is what would make a burned domain look free.
 *
 * @param stackId - The id the request named, echoed so the caller can act on it.
 * @param resolution - What the shared lookup found for that id.
 * @returns The refusal to send, or `undefined` when the Stack is active.
 */
export function namedStackRefusal(stackId: string, resolution: StackResolution): StackRefusal | undefined {
  if (resolution === "active") return undefined;
  if (resolution === "inactive") {
    return {
      status: 404,
      code: "stack_inactive",
      message: `Stack '${stackId}' exists but is inactive, so it cannot serve this request.`,
    };
  }
  return { status: 404, code: "unknown_stack", message: `No Stack '${stackId}' exists.` };
}

/**
 * The refusal for a lookup that could not be COMPLETED.
 *
 * Deliberately not a 404: an unreachable database must never read as "no such Stack", which
 * would let a transient outage look like a client's typo and invite it to invent a new one.
 *
 * @param stackId - The id whose lookup failed.
 * @param error - Whatever the lookup threw.
 * @returns The refusal, naming the cause.
 */
export function stackLookupFailedRefusal(stackId: string, error: unknown): StackRefusal {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    status: 503,
    code: "stack_lookup_failed",
    message: `Could not verify Stack '${stackId}': ${detail}`,
  };
}

/** Write a {@link StackRefusal} in the one envelope these surfaces promise. */
export function writeStackRefusal(res: ServerResponse, refusal: StackRefusal): void {
  writeJsonError(res, refusal.status, refusal.code, refusal.message);
}

/** Write the spec's exact `render_failed` 500 envelope. */
export function writeRenderFailed(res: ServerResponse): void {
  writeJsonError(res, 500, "render_failed", "Could not render page.");
}

/**
 * Wrap the renderer in a catch and return null on any thrown error.
 * Render or sanitize failures must emit the spec's `render_failed`
 * envelope rather than leak the raw thrown text — see {@link writeRenderFailed}.
 */
export function tryRenderBody(
  body: string,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): { html: string } | null {
  try {
    return renderPageHtml(body, snapshot, { isLoopback });
  } catch {
    return null;
  }
}
