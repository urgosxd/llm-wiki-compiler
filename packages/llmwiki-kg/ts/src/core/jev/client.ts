/**
 * @file packages/llmwiki-kg/ts/src/core/jev/client.ts
 * @description The real HTTP adapter for System One, and the boundary that turns
 * one call into a decision outcome.
 *
 * ## Raw `fetch`, no SDK
 *
 * The documented contract is one POST with a JSON body, so an SDK would add a
 * dependency and a second source of truth for a body shape this repository already
 * has the types for. `fetch` is injected so a test can drive the adapter without a
 * socket, and the default suite therefore never touches the network.
 *
 * ## Retries reuse the provider policy that already exists
 *
 * `core/llm/retry.ts` already encodes "which failures deserve a second attempt" for
 * every other provider call, and a second copy here would drift from it. Because
 * {@link JevProviderError} extends `LlmError`, that policy classifies this
 * adapter's failures correctly: a missing status (the request never completed),
 * `429`, and `5xx` are retried up to the shared bound; `401`, `403` and `400` are
 * refusals that an identical retry cannot fix, so they are reported after ONE
 * attempt. A `2xx` whose body is outside the documented shape is likewise not
 * retried — the vendor has already told us what it thinks of the request.
 *
 * ## The one distinction the caller needs
 *
 * {@link requestDecision} never throws for a provider condition. It returns either
 * `answered` (a validated payload) or `provider_failure` (why, and whether to
 * store the candidate as `pending` or `failed`). A bug in this code is NOT a
 * provider condition and is rethrown untouched, so a `TypeError` cannot be
 * laundered into "the provider is down".
 */

import { asRecord, asString } from "../llm/json.js";
import { ProviderUnavailableError, withProviderRetry } from "../llm/retry.js";
import type { ProviderRetryOptions } from "../llm/retry.js";
import { DEFAULT_JEV_TIMEOUT_MS, JevConfigError, parseJevConfig } from "./config.js";
import type { JevEnv } from "./config.js";
import { parseDecisionResponse } from "./payload.js";
import { JEV_SYSTEM_ONE_PATH, JevProviderError, operationalStateFor } from "./types.js";
import type {
  JevAnswered,
  JevDecisionClient,
  JevDecisionOutcome,
  JevDecisionRequest,
  JevDecisionResponse,
  JevFailed,
} from "./types.js";

/** The subset of `fetch` this adapter needs, injectable so no test opens a socket. */
export type JevFetch = (url: string, init: RequestInit) => Promise<Response>;

/** How to reach the vendor. */
export interface JevHttpClientOptions {
  /** System One base URL; the documented path is appended. */
  readonly baseUrl: string;
  /** Bearer credential, from `TYPESAFE_API_KEY`. */
  readonly apiKey: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Replaces global `fetch`; tests pass a recorder. */
  readonly fetchImpl?: JevFetch;
  /** Replaces the retry timer; tests pass a no-op so backoff costs no wall time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Everything one HTTP attempt needs. */
interface Transport {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly fetchImpl: JevFetch;
}

/** The longest error body quoted into a message. */
const MAX_ERROR_BODY_CHARS = 200;

/**
 * Strips trailing slashes so a base URL with one does not produce `//v1/...`.
 *
 * @param baseUrl - Any configured base URL.
 * @returns The base URL without a trailing slash.
 */
function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Parses a body, returning `undefined` when it is not JSON at all.
 *
 * @param text - The raw body.
 * @returns The parsed value, or `undefined`.
 */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Extracts a readable reason from an error body, falling back to raw text.
 *
 * @param body - The parsed body, when it parsed.
 * @param text - The raw body.
 * @returns A short description safe to log.
 */
function describeVendorError(body: unknown, text: string): string {
  const record = asRecord(body);
  const error = record === undefined ? undefined : asRecord(record["error"]);
  return asString(error?.["message"]) ?? text.slice(0, MAX_ERROR_BODY_CHARS);
}

/**
 * Validates a response body, throwing a typed provider error when unusable.
 *
 * @param response - The HTTP response.
 * @param endpoint - The URL that was called, for the error.
 * @returns The validated response.
 * @throws {JevProviderError} On a non-2xx status or an undocumented body.
 */
async function readDecisionBody(response: Response, endpoint: string): Promise<JevDecisionResponse> {
  const text = await response.text();
  const body = parseJsonBody(text);
  if (!response.ok) {
    throw new JevProviderError(
      "provider_answered",
      `${endpoint} answered ${String(response.status)}: ${describeVendorError(body, text)}`,
      endpoint,
      response.status,
    );
  }
  const parsed = parseDecisionResponse(body);
  if (parsed === undefined) {
    throw new JevProviderError(
      "invalid_response",
      `${endpoint} answered a body outside the documented System One shape`,
      endpoint,
      response.status,
    );
  }
  return parsed;
}

/**
 * Sends one request, without retrying.
 *
 * @param transport - How to reach the vendor.
 * @param request - The state and questions to decide.
 * @returns The validated response.
 * @throws {JevProviderError} On any provider condition.
 */
async function postOnce(transport: Transport, request: JevDecisionRequest): Promise<JevDecisionResponse> {
  let response: Response;
  try {
    response = await transport.fetchImpl(transport.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${transport.apiKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(transport.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // No status: the request never completed, which is the most retryable case.
    throw new JevProviderError("provider_failed", `${transport.endpoint} request failed: ${reason}`, transport.endpoint);
  }
  return readDecisionBody(response, transport.endpoint);
}

/**
 * Creates the real System One client.
 *
 * @param options - Endpoint, credential and transport overrides.
 * @returns A client whose failures are {@link JevProviderError}s.
 */
export function createJevHttpClient(options: JevHttpClientOptions): JevDecisionClient {
  const transport: Transport = {
    endpoint: `${trimTrailingSlash(options.baseUrl)}${JEV_SYSTEM_ONE_PATH}`,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
  };
  const retryOptions: ProviderRetryOptions = options.sleep === undefined ? {} : { sleep: options.sleep };
  return {
    async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
      return withProviderRetry(() => postOnce(transport, request), retryOptions);
    },
  };
}

/**
 * Creates the real client from configuration and `TYPESAFE_API_KEY`.
 *
 * A missing credential is a configuration error rather than a provider condition:
 * it is raised here, before any call, instead of being spent as a failed attempt.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @param fetchImpl - Optional transport override.
 * @returns The configured client.
 * @throws {JevConfigError} When the credential or configuration is missing or invalid.
 */
export function createJevHttpClientFromEnv(env: JevEnv = process.env, fetchImpl?: JevFetch): JevDecisionClient {
  const apiKey = env["TYPESAFE_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new JevConfigError("TYPESAFE_API_KEY is required to call Jev; set it or inject a decision client");
  }
  const config = parseJevConfig(env);
  const options: JevHttpClientOptions =
    fetchImpl === undefined
      ? { baseUrl: config.baseUrl, apiKey, timeoutMs: config.timeoutMs }
      : { baseUrl: config.baseUrl, apiKey, timeoutMs: config.timeoutMs, fetchImpl };
  return createJevHttpClient(options);
}

/**
 * Maps a thrown value onto a failure outcome, or rethrows a programming error.
 *
 * @param error - Whatever the client threw.
 * @returns The operational failure to store against the candidate.
 * @throws The original error when it is neither a provider failure nor an exhausted run.
 */
function failureOutcome(error: unknown): JevFailed {
  const failure =
    error instanceof JevProviderError
      ? { kind: error.kind, reason: error.message }
      : error instanceof ProviderUnavailableError
        ? { kind: "provider_failed" as const, reason: error.message }
        : undefined;
  if (failure === undefined) throw error;
  return {
    status: "provider_failure",
    kind: failure.kind,
    state: operationalStateFor(failure.kind),
    reason: failure.reason,
  };
}

/**
 * Describes a payload this adapter refused to interpret.
 *
 * @returns The operational failure for a 2xx body outside the documented shape.
 */
function invalidResponseOutcome(): JevFailed {
  return {
    status: "provider_failure",
    kind: "invalid_response",
    state: operationalStateFor("invalid_response"),
    reason: "the decision payload is outside the documented System One shape",
  };
}

/**
 * Asks a client and reports what actually happened.
 *
 * This is the only supported way to obtain a {@link JevDecisionOutcome}: it applies
 * the payload validator to whatever the client returned — including a double's
 * scripted body — so "the vendor answered something unusable" can never reach
 * interpretation as an abstention.
 *
 * @param client - The decision client, real or a double.
 * @param request - The state and questions to decide.
 * @returns A validated answer, or the operational failure to store.
 * @throws The original error when the client threw a programming error.
 */
export async function requestDecision(
  client: JevDecisionClient,
  request: JevDecisionRequest,
): Promise<JevDecisionOutcome> {
  let raw: JevDecisionResponse;
  try {
    raw = await client.decide(request);
  } catch (error) {
    return failureOutcome(error);
  }
  const response = parseDecisionResponse(raw);
  const answered: JevAnswered | JevFailed = response === undefined ? invalidResponseOutcome() : { status: "answered", response };
  return answered;
}
