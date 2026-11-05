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
import { formatContextResponse, formatEntitiesResponse, formatTraverseResponse } from "./format.js";
import type { QueryValue } from "./query-string.js";
import { encodeQuery, floatParam, intParam, rawParam } from "./query-string.js";
import { asArray, asRecord, asText, requireField } from "./narrow.js";
import { stackIdProblem } from "../stack-id.js";

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
 * `isError` would otherwise read "Error: 'stackId' must be provided." as a
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
 * `stackId` is a refusal rather than a request for "some" Stack. It is answered
 * with {@link errorResult}, so the envelope itself marks the call as failed.
 */
const MISSING_STACK_ERROR = "Error: 'stackId' must be provided.";

/**
 * The HTTP wire key for the Stack.
 *
 * The MCP tools, the HTTP body, the HTTP query string and the path-parameter
 * labels all carry one name for this concept, so this is not a translation point
 * but the same name stated once: `stackId`. The DTO field, the route schemas and
 * the core parameters were renamed together with it.
 *
 * Response models still emit `stack_id`, because those keys come from the
 * oracle's own models and renaming an outbound field is a separate decision.
 */
const HTTP_STACK_FIELD = "stackId";

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
 * `stackId`, which every graph tool requires, plus the optional `domain` filter.
 *
 * `stackId` is the only way these tools name a Stack: it is forwarded as given,
 * with no default and no fallback. `domain` used to be an alternative selector,
 * and that either/or is gone — `domain` alone is refused, exactly like no
 * argument at all, and when both are supplied `domain` is forwarded only as an
 * additional narrowing filter. Returns `undefined` when `stackId` is absent,
 * which the handler must answer with {@link MISSING_STACK_ERROR}.
 */
function stackSelection(
  args: Record<string, unknown>,
): StackSelection | undefined {
  if (!("stackId" in args)) {
    return undefined;
  }
  return {
    stackId: args["stackId"],
    domain: args["domain"],
    hasDomain: "domain" in args,
  };
}

/**
 * The refusal for a Stack argument that is not a Stack id.
 *
 * The rule is imported, never restated: `stackIdProblem` is the ONE Stack-id
 * explanation both dimensions give (S1), so the only thing added here is the
 * `Error: ` prefix that marks the text as a refusal. An earlier version also
 * prefixed "'stackId' must be a UUID.", which stated the rule twice from two
 * sources; the shared explanation is now the only place it is worded. A
 * malformed id is refused before the request is built, so nothing unusable can
 * reach the backend.
 *
 * @param value - The value the call carried under `stackId`.
 * @returns The refusal text, or `undefined` when the id is well formed.
 */
function malformedStackIdRefusal(value: unknown): string | undefined {
  const problem = stackIdProblem(typeof value === "string" ? value : asText(value));
  return problem === undefined ? undefined : `Error: ${problem}`;
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
  const malformed = malformedStackIdRefusal(stack.stackId);
  if (malformed !== undefined) {
    return errorResult(malformed);
  }
  payload[HTTP_STACK_FIELD] = stack.stackId;
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
  const malformed = malformedStackIdRefusal(stack.stackId);
  if (malformed !== undefined) {
    return errorResult(malformed);
  }

  const params: Record<string, QueryValue> = {
    start,
    max_depth: typeof maxDepth === "number" ? intParam(maxDepth) : undefined,
    [HTTP_STACK_FIELD]: stringParam(stack.stackId),
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
  const malformed = malformedStackIdRefusal(stack.stackId);
  if (malformed !== undefined) {
    return errorResult(malformed);
  }

  const params: Record<string, QueryValue> = {
    min_confidence: typeof minConfidence === "number" ? floatParam(minConfidence) : undefined,
    limit: typeof limit === "number" ? intParam(limit) : undefined,
    [HTTP_STACK_FIELD]: stringParam(stack.stackId),
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
 * List the Stacks on the AKS server, as the shared JSON contract (S3).
 *
 * Note the path: `GET /stacks`, **not** `/aks/v1/stacks`. The Python calls
 * `f"{AKS_BASE_URL}/stacks"`, and `/stacks` is the one Stack endpoint that sits
 * outside the `/aks/v1` prefix (see the recorded OpenAPI contract).
 *
 * The answer is the same document the wiki dimension answers with — `{stacks,
 * count}` and a ten-field entry — because one tool name should mean one contract
 * even when two servers implement it. Prose was the previous shape and is gone: a
 * listing a client has to parse back out of sentences cannot be compared field by
 * field with anything.
 *
 * `stackId` does not filter. This dimension reads no Stack from its environment, so
 * it marks nothing when the argument is absent and marks the named entry when it is
 * present; an omission is allowed, because `list_stacks` is exempt from the
 * required-Stack rule in both dimensions.
 */
export async function listStacks(
  args: Record<string, unknown>,
  deps: ResolvedDependencies,
): Promise<CallToolResult> {
  const named = "stackId" in args ? args["stackId"] : undefined;
  if ("stackId" in args) {
    const malformed = malformedStackIdRefusal(named);
    if (malformed !== undefined) {
      return errorResult(malformed);
    }
  }

  const response = await deps.fetchImpl(`${deps.baseUrl}/stacks`, {
    method: "GET",
    headers: authHeaders(deps.apiKey),
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status !== 200) {
    return textResult(await statusErrorText(response));
  }

  const current = typeof named === "string" ? named : undefined;
  const listed = asArray(await response.json()).map((entry) => contractStack(entry, current));
  const stacks = orderAndBound(listed, args["limit"]);
  return textResult(JSON.stringify({ stacks, count: stacks.length }));
}

/** One entry of the shared `list_stacks` contract, in the contract's key order. */
interface ContractStack {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly description: string | null;
  readonly scope: string;
  readonly compilationStrategy: string | null;
  readonly synthesizeDescriptions: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly isCurrent: boolean;
}

/** What a `list_stacks` call returns when it names no limit. */
const DEFAULT_LIST_LIMIT = 50;

/** The largest listing a `list_stacks` call may ask for. */
const MAX_LIST_LIMIT = 200;

/** A string field, or `null` where the contract allows it and the API sent nothing. */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Project one `GET /stacks` entry onto the contract.
 *
 * The API answers in the DTO's snake_case; the contract is camelCase, so this is a
 * rename and not a reshape. `isCurrent` is the ONLY field this dimension decides
 * for itself: no Stack is bound here, so it is true exactly when the caller named
 * this entry's id.
 *
 * @param entry - One element of the `GET /stacks` array.
 * @param currentStackId - The Stack the caller named, if it named one.
 * @returns The contract entry, keys in contract order.
 */
function contractStack(entry: unknown, currentStackId: string | undefined): ContractStack {
  const stack = asRecord(entry);
  if (stack === null) throw new Error("Stack is not an object");
  const id = asText(requireField(stack, "id"));
  return {
    id,
    name: asText(requireField(stack, "name")),
    domain: textOrNull(stack["domain"]),
    description: textOrNull(stack["description"]),
    scope: asText(requireField(stack, "scope")),
    compilationStrategy: textOrNull(stack["compilation_strategy"]),
    synthesizeDescriptions: stack["synthesize_descriptions"] === true,
    createdAt: asText(requireField(stack, "created_at")),
    updatedAt: asText(requireField(stack, "updated_at")),
    isCurrent: currentStackId !== undefined && id === currentStackId,
  };
}

/** Most recently updated first, with the current entry ahead of every other. */
function byRecencyWithCurrentFirst(left: ContractStack, right: ContractStack): number {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  // The timestamps are ISO-8601 in UTC, so their lexicographic order IS their
  // chronological order; no parsing and no locale can change the answer.
  return right.updatedAt.localeCompare(left.updatedAt);
}

/**
 * Order the listing and cut it to the requested size.
 *
 * Ordering runs before the cut, for the reason the wiki dimension sorted the current
 * Stack first: in a deployment with thousands of Stacks a named entry can sit far
 * past any sane limit, and a limit applied first would hide exactly the Stack the
 * caller asked about. An absent or non-numeric `limit` falls back to the default
 * rather than refusing, because the schema declares a bound, not a requirement.
 *
 * @param stacks - The contract entries, in the order the API sent them.
 * @param limit - The caller's requested size, if any.
 * @returns At most `limit` entries, in contract order.
 */
function orderAndBound(stacks: readonly ContractStack[], limit: unknown): ContractStack[] {
  const requested =
    typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIST_LIMIT;
  const bounded = Math.min(Math.max(1, requested), MAX_LIST_LIMIT);
  return [...stacks].sort(byRecencyWithCurrentFirst).slice(0, bounded);
}
