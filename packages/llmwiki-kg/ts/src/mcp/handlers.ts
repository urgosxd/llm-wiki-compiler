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

/** A single text content block, the only result type these tools return. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const MISSING_STACK_ERROR = "Error: either 'domain' or 'stack_id' must be provided.";

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

/** An absent-or-string tool argument, already stringified for the query. */
function optionalStringParam(
  args: Record<string, unknown>,
  key: string,
): QueryValue {
  const value = args[key];
  return typeof value === "string" ? rawParam(value) : undefined;
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

  // `if "domain" in args: ... elif "stack_id" in args:` — the Python tests key
  // presence, not truthiness, and `domain` wins when both are supplied.
  if ("domain" in args) {
    payload["domain"] = args["domain"];
  } else if ("stack_id" in args) {
    payload["stack_id"] = args["stack_id"];
  } else {
    return textResult(MISSING_STACK_ERROR);
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
  const params: Record<string, QueryValue> = {
    start: rawParam(asText(requiredArg(args, "start"))),
    max_depth: typeof maxDepth === "number" ? intParam(maxDepth) : undefined,
  };

  if ("domain" in args) {
    params["domain"] = optionalStringParam(args, "domain");
  } else if ("stack_id" in args) {
    params["stack_id"] = optionalStringParam(args, "stack_id");
  } else {
    return textResult(MISSING_STACK_ERROR);
  }

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
  const params: Record<string, QueryValue> = {
    min_confidence: typeof minConfidence === "number" ? floatParam(minConfidence) : undefined,
    limit: typeof limit === "number" ? intParam(limit) : undefined,
  };

  if ("domain" in args) {
    params["domain"] = optionalStringParam(args, "domain");
  } else if ("stack_id" in args) {
    params["stack_id"] = optionalStringParam(args, "stack_id");
  } else {
    return textResult(MISSING_STACK_ERROR);
  }

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
