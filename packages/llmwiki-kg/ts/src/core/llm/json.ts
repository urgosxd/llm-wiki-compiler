/**
 * @file packages/llmwiki-kg/ts/src/core/llm/json.ts
 * @description Narrowing an untyped provider payload, and issuing a JSON POST.
 *
 * Split out of `core/llm_clients.ts` as its own unit because every provider call
 * shares it: one place validates the transport, one place refuses a non-2xx
 * answer, and one place decides that a payload is not JSON.
 */

import { LlmError } from "./errors.js";

// ---------------------------------------------------------------------------
// JSON narrowing helpers
//
// Responses are `unknown` until proven otherwise. These three helpers are the
// only places that inspect an untyped payload, and each returns `undefined`
// instead of asserting, so no path relies on an unchecked cast.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Reads a provider response body as JSON.
 *
 * A body that is not JSON is reported with the text truncated to 200 chars —
 * enough to identify a gateway error page, short enough not to flood a log.
 */
export async function readJsonBody(response: Response, endpoint: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmError(
      `${endpoint} returned a non-JSON body: ${JSON.stringify(text.slice(0, 200))}`,
      endpoint,
      response.status,
    );
  }
}

/**
 * Extracts the provider's error message from an error body.
 *
 * OpenAI-compatible gateways put it at `error.message`; Anthropic uses the same
 * path. Both are looked up the same way, and the raw body is the fallback.
 */
export function providerErrorMessage(body: unknown): string {
  const record = asRecord(body);
  const error = record === undefined ? undefined : asRecord(record["error"]);
  return asString(error?.["message"]) ?? JSON.stringify(body).slice(0, 400);
}

/**
 * Issues a POST and fails loudly on a non-2xx answer.
 *
 * The check is here rather than at each call site so no provider path can
 * silently parse an error envelope as if it were a success payload.
 */
export async function postJson(
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Transport failure: DNS, TLS, connection refused, aborted request.
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmError(`${endpoint} request failed: ${reason}`, endpoint);
  }

  const body = await readJsonBody(response, endpoint);
  if (!response.ok) {
    throw new LlmError(
      `${endpoint} answered ${String(response.status)}: ${providerErrorMessage(body)}`,
      endpoint,
      response.status,
    );
  }
  return { response, body };
}
