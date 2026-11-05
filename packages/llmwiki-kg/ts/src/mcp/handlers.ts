/**
 * @file packages/llmwiki-kg/ts/src/mcp/handlers.ts
 * @description The tool implementations: argument validation, request, format.
 *
 * Each handler validates its own arguments before calling the API, because an
 * MCP client is a model and a model will pass a string where a number belongs.
 * The error strings here are user-facing text, so they are asserted by tests.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AKS_API_KEY, AKS_BASE_URL, authHeaders } from "./config.js";
import { formatContextResponse, formatEntitiesResponse, formatStacksResponse, formatTraverseResponse } from "./format.js";
import type { QueryValue } from "./query-string.js";
import { encodeQuery, floatParam, intParam, rawParam } from "./query-string.js";
import { asText } from "./narrow.js";

// ============================================================
// Tool implementations
// ============================================================

/** A single text content block, the shape of an answer. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * A refusal: the same text block, flagged `isError` so a client can tell it
 * apart from an answer.
 *
 * The text alone cannot carry that distinction — a client that only branches on
 * `isError` would otherwise read "Error: 'stack_id' must be provided." as a
 * successful answer. Nothing else changes: the message still names the
 * argument, and no request has been issued by the time it is built.
 */
export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * What every graph tool answers when the client names no Stack.
 *
 * The Stack is the tool argument and nothing else: there is no default Stack to
 * fall back to and nothing in the environment to resolve one from, so an absent
 * `stack_id` is a refusal rather than a request for "some" Stack. It is answered
 * with {@link errorResult}, so the envelope itself marks the call as failed.
 */
const MISSING_STACK_ERROR = "Error: 'stack_id' must be provided.";

/** Narrow the tool-call `arguments` payload to a plain record. */
export function asArguments(value: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  return value === undefined ? {} : { ...value };
}

/** `args.get(key, fallback)` honors an explicit `null` as a value, like Python. */
function argOr<T>(args: Record<string, unknown>, key: string, fallback: T): unknown {
  return key in args ? args[key] : fallback;
}

/**
 * `args[key]` for a *required* argument — the Python writes `args["query"]` and
 * `args["start"]`, which raise `KeyError` when the client omits them.
 *
 * Reproducing the raise is the point: a client that advertises `query` as
 * required in the schema and then omits it has a bug, and a 422/`KeyError`
 * surfaces it, whereas sending `{"query": null}` would push a junk payload to
 * the AKS API and turn a client error into a confusing 422 from downstream.
 * The throwing branch is unreachable through a spec-compliant MCP client, but
 * `callTool` is exported and can be called directly.
 */
function requiredArg(args: Record<string, unknown>, key: string): unknown {
  if (!(key in args)) {
    throw new Error(`KeyError: '${key}'`);
  }
  return args[key];
}

/** An absent-or-string value, already stringified for the query. */
function stringParam(value: unknown): QueryValue {
  return typeof value === "string" ? rawParam(value) : undefined;
}

/** An absent-or-string tool argument, already stringified for the query. */
function optionalStringParam(
  args: Record<string, unknown>,
  key: string,
): QueryValue {
  return stringParam(args[key]);
}

/** The Stack a graph tool names, and the domain filter it may add to it. */
interface StackSelection {
  readonly stackId: unknown;
  readonly domain: unknown;
  readonly hasDomain: boolean;
}

/**
 * `stack_id`, which every graph tool requires, plus the optional `domain` filter.
 *
 * `stack_id` is the only way these tools name a Stack: it is forwarded as given,
 * with no default and no fallback. `domain` used to be an alternative selector,
 * and that either/or is gone — `domain` alone is refused, exactly like no
 * argument at all, and when both are supplied `domain` is forwarded only as an
 * additional narrowing filter. Returns `undefined` when `stack_id` is absent,
 * which the handler must answer with {@link MISSING_STACK_ERROR}.
 */
function stackSelection(
  args: Record<string, unknown>,
): StackSelection | undefined {
  if (!("stack_id" in args)) {
    return undefined;
  }
  return {
    stackId: args["stack_id"],
    domain: args["domain"],
    hasDomain: "domain" in args,
  };
}

/**
 * The HTTP boundary, injectable so tests can record the exact request.
 *
 * The Python builds a fresh `httpx.AsyncClient` per call with a per-tool
 * timeout; this port passes the same timeout to `AbortSignal.timeout`.
 */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

export interface McpDependencies {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: FetchLike;
}

interface ResolvedDependencies {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl: FetchLike;
}

/** Default fetch adapter, mapping the platform Response onto `FetchLike`. */
const defaultFetch: FetchLike = async (input, init) => {
  const response = await globalThis.fetch(input, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: init.signal,
  });
  return {
    status: response.status,
    text: () => response.text(),
    json: () => response.json() as Promise<unknown>,
  };
};

export function resolveDependencies(deps: McpDependencies): ResolvedDependencies {
  return {
    baseUrl: deps.baseUrl ?? AKS_BASE_URL,
    apiKey: deps.apiKey ?? AKS_API_KEY,
    fetchImpl: deps.fetchImpl ?? defaultFetch,
  };
}

/**
 * Turn a non-200 response into the Python's error text.
 *
 * `f"AKS server returned {status}: {response.text}"` — the raw body, not a
 * re-serialized JSON error.
 */
async function statusErrorText(
  response: { status: number; text: () => Promise<string> },
): Promise<string> {
  return `AKS server returned ${response.status}: ${await response.text()}`;
}

export async function queryStack(
  args: Record<string, unknown>,
  deps: ResolvedDependencies,
): Promise<CallToolResult> {
  const payload: Record<string, unknown> = {
    query: requiredArg(args, "query"),
    max_entities: argOr(args, "max_entities", 8),
  };

  const stack = stackSelection(args);
  if (stack === undefined) {
    return errorResult(MISSING_STACK_ERROR);
  }
  payload["stack_id"] = stack.stackId;
  if (stack.hasDomain) {
    payload["domain"] = stack.domain;
  }

  const response = await deps.fetchImpl(`${deps.baseUrl}/aks/v1/context`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(deps.apiKey) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status !== 200) {
    return textResult(await statusErrorText(response));
  }

  return textResult(formatContextResponse(await response.json()));
}

export async function traverseStack(
  args: Record<string, unknown>,
  deps: ResolvedDependencies,
): Promise<CallToolResult> {
  // `max_depth` is declared `"type": "integer"` in the advertised schema.
  const maxDepth = argOr(args, "max_depth", 2);
  // `start` is read before the Stack is: that is the order the Python's
  // `args["start"]` ran in, and a client error there must still be a KeyError.
  const start = rawParam(asText(requiredArg(args, "start")));
  const stack = stackSelection(args);
  if (stack === undefined) {
    return errorResult(MISSING_STACK_ERROR);
  }

  const params: Record<string, QueryValue> = {
    start,
    max_depth: typeof maxDepth === "number" ? intParam(maxDepth) : undefined,
    stack_id: stringParam(stack.stackId),
    domain: stack.hasDomain ? stringParam(stack.domain) : undefined,
  };

  if ("relationship_types" in args) {
    params["relationship_types"] = optionalStringParam(args, "relationship_types");
  }

  const query = encodeQuery(params);
  const response = await deps.fetchImpl(
    `${deps.baseUrl}/aks/v1/traverse?${query}`,
    {
      method: "GET",
      headers: authHeaders(deps.apiKey),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (response.status !== 200) {
    return textResult(await statusErrorText(response));
  }

  return textResult(formatTraverseResponse(await response.json()));
}

export async function getEntities(
  args: Record<string, unknown>,
  deps: ResolvedDependencies,
): Promise<CallToolResult> {
  // `min_confidence` is declared `"type": "number"` (a Pydantic float, so
  // `str(0.0)` is "0.0"); `limit` is declared `"type": "integer"`.
  const minConfidence = argOr(args, "min_confidence", 0.0);
  const limit = argOr(args, "limit", 100);
  const stack = stackSelection(args);
  if (stack === undefined) {
    return errorResult(MISSING_STACK_ERROR);
  }

  const params: Record<string, QueryValue> = {
    min_confidence: typeof minConfidence === "number" ? floatParam(minConfidence) : undefined,
    limit: typeof limit === "number" ? intParam(limit) : undefined,
    stack_id: stringParam(stack.stackId),
    domain: stack.hasDomain ? stringParam(stack.domain) : undefined,
  };

  if ("type" in args) {
    params["type"] = optionalStringParam(args, "type");
  }

  const query = encodeQuery(params);
  const response = await deps.fetchImpl(
    `${deps.baseUrl}/aks/v1/entities?${query}`,
    {
      method: "GET",
      headers: authHeaders(deps.apiKey),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (response.status !== 200) {
    return textResult(await statusErrorText(response));
  }

  return textResult(formatEntitiesResponse(await response.json()));
}

/**
 * List all Stacks on the AKS server.
 *
 * Note the path: `GET /stacks`, **not** `/aks/v1/stacks`. The Python calls
 * `f"{AKS_BASE_URL}/stacks"`, and `/stacks` is the one Stack endpoint that sits
 * outside the `/aks/v1` prefix (see the recorded OpenAPI contract).
 */
export async function listStacks(
  _args: Record<string, unknown>,
  deps: ResolvedDependencies,
): Promise<CallToolResult> {
  const response = await deps.fetchImpl(`${deps.baseUrl}/stacks`, {
    method: "GET",
    headers: authHeaders(deps.apiKey),
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status !== 200) {
    return textResult(await statusErrorText(response));
  }

  return textResult(formatStacksResponse(await response.json()));
}
