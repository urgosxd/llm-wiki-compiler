import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP server wrapping the AKS query endpoints as tools.
 *
 * TypeScript mirror of `app/mcp_server.py` (472 lines). Same four tools, same
 * routing, same request shapes, same response text.
 *
 * ## The Python reference MCP server cannot run — read this before "fixing"
 *
 * There is **no working Python oracle for MCP**. `app/mcp_server.py` does not
 * import under the dependency set the repo actually installs, so it has never
 * served a request here. Two independent defects, both reproduced against the
 * running container (`aks-reference-server-api-1`):
 *
 * ### Bug 1 — the module cannot even import (SDK version drift)
 *
 * Line 29 does `from mcp.server import Server`, which resolves to
 * `mcp.server.lowlevel.server.Server`. `requirements.txt` pins `mcp` with no
 * version, so the image ships **mcp 2.3.0**, and that class carries neither of
 * the decorator-style registration methods the file is written against:
 *
 *     >>> from mcp.server import Server
 *     >>> Server.__module__
 *     'mcp.server.lowlevel.server'
 *     >>> hasattr(Server, 'list_tools'), hasattr(Server, 'call_tool')
 *     (False, False)
 *     >>> import app.mcp_server
 *     AttributeError: 'Server' object has no attribute 'list_tools'
 *
 * Execution dies at the `@server.list_tools()` decorator, before any transport
 * is created. The file targets the pre-2.x API surface (`@server.list_tools()`
 * / `@server.call_tool()`); 2.3.0 replaced it. A bare `mcp` pin makes the
 * installed version non-reproducible, which is why this surfaced only in the
 * container and not in review.
 *
 * ### Bug 2 — `list_stacks` would raise even if Bug 1 were fixed
 *
 * `call_tool` dispatches `list_stacks` as `await _list_stacks()`, but the
 * handler is declared `async def _list_stacks(args: dict)`. Every call raises:
 *
 *     TypeError: _list_stacks() missing 1 required positional argument: 'args'
 *
 * ### What that means for this port
 *
 * Because Bug 1 blocks import, **no tool's behavior can be observed from the
 * Python server** — not just `list_stacks`. The only verifiable oracle for this
 * slice is CPython executing the module's pure functions directly: the
 * formatters are loaded out of `app/mcp_server.py` with `ast`, without
 * importing the module, and called on the same JSON this port consumes. That is
 * exactly how `mcp.test.ts` obtains every `EXPECTED_*` constant, and it is what
 * makes this slice verifiable at all. The HTTP calls themselves were verified
 * against the live AKS API on `localhost:8000` (a separate, working process).
 *
 * Both defects are therefore **not** reproduced here. A faithful port of a
 * module that cannot import would be a module that cannot import, and of a
 * handler that always raises a call that always raises — neither is a payload
 * any client could use. The behavior that carries meaning (routing, request
 * shapes, formatters) is ported exactly instead. `list_stacks` passes the
 * call's arguments through and returns the formatted Stack list.
 *
 * ## Four tools, not three — the docstring is stale
 *
 * The module docstring says "Three tools exposed" and lists only `query_stack`,
 * `traverse_stack` and `get_entities`. The code advertises **four**:
 * `list_tools()` contains four `Tool(...)` calls, and `call_tool` has four
 * dispatch branches, the fourth being `list_stacks`. Verified by parsing the
 * source with `ast`: 4 `Tool(...)` calls, names
 * `['query_stack', 'traverse_stack', 'get_entities', 'list_stacks']`, and 4
 * handler defs (`_query_stack`, `_traverse_stack`, `_get_entities`,
 * `_list_stacks`).
 *
 * So the docstring is stale and the registry is the contract. This port ships
 * four. **Do not "repair" it back to three** to match the docstring: that would
 * silently drop a tool the reference code advertises. `mcp.test.ts` pins the
 * full advertisement against the Python literals, extracted mechanically, so
 * the docstring cannot win by accident.
 *
 * ## Transport
 *
 * stdio, like the Python (`run_stdio`). This module never opens a listening
 * socket, so it cannot collide with the reference server on 8000.
 *
 * ## Base URL
 *
 * `AKS_BASE_URL`, default `http://localhost:8000`, read once at module load
 * exactly as the Python reads it at import time. `AKS_API_KEY` is stripped and
 * only sent when non-empty, reproducing `_auth_headers()`.
 *
 * Note this is the **AKS HTTP API** endpoint, not the MCP endpoint: the MCP
 * surface is stdio-only, and the only HTTP traffic a tool call produces is an
 * outbound request to this base URL.
 *
 * ## Query-string encoding
 *
 * The Python builds params as a `dict` and hands them to httpx, which encodes
 * with `quote_plus` semantics. `URLSearchParams` is *not* byte-identical: it
 * leaves `*` and `!` unescaped where httpx escapes them (`%2A`, `%21`). This
 * port therefore encodes with the httpx rules directly — see `encodeQuery`.
 */

// ============================================================
// Configuration
// ============================================================

/** `os.getenv("AKS_BASE_URL", "http://localhost:8000")`, read once at load. */
const AKS_BASE_URL = process.env["AKS_BASE_URL"] ?? "http://localhost:8000";

/** `os.getenv("AKS_API_KEY", "").strip()`. */
const AKS_API_KEY = (process.env["AKS_API_KEY"] ?? "").trim();

/**
 * Build auth headers if an API key is configured.
 *
 * Mirrors `_auth_headers()`: the header is absent entirely when no key is set,
 * rather than present and empty. An empty `X-API-Key` is not the same request
 * as no `X-API-Key` for a server that treats "" as a configured-but-wrong key.
 */
export function authHeaders(apiKey: string = AKS_API_KEY): Record<string, string> {
  return apiKey ? { "X-API-Key": apiKey } : {};
}

// ============================================================
// Tool registry
// ============================================================

/**
 * The tool definitions advertised by `list_tools()`.
 *
 * Every string below is copied verbatim from `app/mcp_server.py`. Descriptions
 * and JSON-Schema fragments are part of the client-facing contract: an LLM
 * client picks tools by reading them, so a reworded description is a behavior
 * change even though no test would call it one.
 *
 * `required` is absent for `get_entities` and `list_stacks` because the Python
 * omits it there — parse both branches explicitly rather than emitting an empty
 * `required: []`, which is a different schema.
 */
export const MCP_TOOLS: readonly Tool[] = [
  {
    name: "query_stack",
    description:
      "Run a natural-language query against a compiled AKS Knowledge Stack. Returns the relevant entities, their relationships, the reasoning the model used to select them, and a confidence rating. Use this when you need to find domain knowledge by description, not by exact entity name.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The natural-language question",
        },
        domain: {
          type: "string",
          description:
            "Domain slug of the Stack (e.g. 'incident-response'). Either domain or stack_id is required.",
        },
        stack_id: {
          type: "string",
          description: "UUID of the Stack. Either domain or stack_id is required.",
        },
        max_entities: {
          type: "integer",
          description: "Maximum number of entities to return (default 8)",
          default: 8,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "traverse_stack",
    description:
      "Traverse a Knowledge Stack starting from a named entity, following typed relationships up to max_depth hops away. Returns the chain of relationships found. Use this when you know the starting entity and want to explore its neighborhood in the graph.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Name of the starting entity",
        },
        domain: {
          type: "string",
          description: "Domain slug of the Stack",
        },
        stack_id: {
          type: "string",
          description: "UUID of the Stack",
        },
        max_depth: {
          type: "integer",
          description: "Maximum hops from the starting entity (default 2)",
          default: 2,
        },
        relationship_types: {
          type: "string",
          description:
            "Optional comma-separated list of relationship types to follow (e.g. 'requires,triggers')",
        },
      },
      required: ["start"],
    },
  },
  {
    name: "get_entities",
    description:
      "List the compiled entities in a Knowledge Stack, with optional filtering by type and confidence threshold. Use this for inventory questions like 'what does this Stack know about?' or to find entities by type.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain slug of the Stack",
        },
        stack_id: {
          type: "string",
          description: "UUID of the Stack",
        },
        type: {
          type: "string",
          description: "Filter by entity type (e.g. 'Process', 'System')",
        },
        min_confidence: {
          type: "number",
          description: "Minimum confidence (0.0-1.0)",
          default: 0.0,
        },
        limit: {
          type: "integer",
          description: "Maximum entities to return (default 100, max 1000)",
          default: 100,
        },
      },
    },
  },
  {
    name: "list_stacks",
    description:
      "List all Knowledge Stacks available on this AKS server. Returns each Stack's name, domain, and description. Use this when the user hasn't specified which Stack to query and you need to figure out what's available.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ============================================================
// Python numeric formatting
// ============================================================

/**
 * Python's `format(value, ".2f")`, reproduced bit-exactly.
 *
 * This cannot be `toFixed(2)` or `Intl.NumberFormat`. Python rounds the exact
 * binary value with round-half-to-even, while `toFixed` rounds half away from
 * zero and `Intl` with `roundingMode: "halfEven"` still rounds the *shortest
 * decimal representation* rather than the stored double. The three disagree on
 * real inputs:
 *
 * | value | Python `.2f` | `toFixed(2)` | `Intl` halfEven |
 * |-------|--------------|--------------|-----------------|
 * | 0.125 | `0.12`       | `0.13`       | `0.12`          |
 * | 2.675 | `2.67`       | `2.67`       | `2.68`          |
 * | 0.995 | `0.99`       | `0.99`       | `1.00`          |
 *
 * A confidence of exactly `0.125` is reachable — extraction emits round
 * confidences, and `0.125` is a normal one — so this is a live contract risk,
 * not a pedantic one. The implementation decodes the IEEE-754 bits and does the
 * rounding in exact integer arithmetic. Verified against CPython over 3000
 * random doubles (see `mcp.test.ts`).
 */
export function formatFixed2(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);

  const negative = hi >>> 31 === 1;
  const sign = negative ? "-" : "";

  const exponentBits = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exponent: bigint;

  if (exponentBits === 0) {
    // Subnormal: no implicit leading bit.
    exponent = -1074n;
  } else {
    mantissa |= 1n << 52n;
    exponent = BigInt(exponentBits) - 1075n;
  }

  // `format(-0.0, ".2f")` is "-0.00" in Python, so the sign is kept.
  if (mantissa === 0n) return `${sign}0.00`;

  // Compute round-half-even(|value| * 100) in exact integer arithmetic.
  const numerator = mantissa * 100n;
  let units: bigint;
  if (exponent >= 0n) {
    units = numerator << exponent;
  } else {
    const divisor = 1n << -exponent;
    const quotient = numerator / divisor;
    const remainder = numerator % divisor;
    const twiceRemainder = remainder * 2n;
    if (twiceRemainder > divisor) {
      units = quotient + 1n;
    } else if (twiceRemainder < divisor) {
      units = quotient;
    } else {
      units = quotient % 2n === 0n ? quotient : quotient + 1n;
    }
  }

  const whole = units / 100n;
  const fraction = units % 100n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}

// ============================================================
// Query-string encoding (httpx `quote_plus` semantics)
// ============================================================

/**
 * Characters httpx's `quote_plus` leaves unescaped.
 *
 * `urllib.parse.quote_plus` keeps `A-Za-z0-9_.-~` and encodes everything else,
 * including `*`, `!`, `'`, `(`, `)`. It maps space to `+`. `URLSearchParams`
 * differs on `*` and `!` (leaves them bare) and maps space to `+`, so it cannot
 * be substituted without changing the request URL.
 */
const HTTPX_SAFE = /[A-Za-z0-9_.\-~]/u;

/** `urllib.parse.quote_plus(value, safe="")`, byte-for-byte. */
export function quotePlus(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && HTTPX_SAFE.test(char)) {
      out += char;
    } else if (char === " ") {
      out += "+";
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * Python's `str(a_float)`, reproduced.
 *
 * This is not `String(value)`. The Python params dict is built from `float` and
 * `int` values and handed to httpx, which stringifies each one with `str()`;
 * `str(0.0)` is `"0.0"` while `String(0)` in JS is `"0"`. The default
 * `min_confidence` is exactly `0.0`, so `GET /aks/v1/entities` would otherwise
 * send `min_confidence=0` instead of `min_confidence=0.0` — a different URL
 * from the oracle's, on the default path of a shipped tool.
 *
 * Python's float repr rules: shortest round-trip digits, exponent notation when
 * the decimal exponent is below -4 or at least 16, and an explicit `.0` for
 * integral values. Verified against CPython over 2500 random doubles.
 */
export function pyFloatToString(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";

  const negative = value < 0 || Object.is(value, -0);
  const sign = negative ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude === 0) return `${sign}0.0`;

  // `String()` already yields the shortest round-trip digits, which is the same
  // digit sequence CPython's repr produces; only the layout differs.
  const repr = String(magnitude);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(repr);
  if (match === null) throw new Error(`Unexpected number representation: ${repr}`);

  const integerPart = match[1] ?? "";
  const fractionPart = match[2] ?? "";
  let digits = integerPart + fractionPart;
  let decimalExponent = integerPart.length + (match[3] === undefined ? 0 : Number(match[3]));

  let leadingZeros = 0;
  while (leadingZeros < digits.length - 1 && digits[leadingZeros] === "0") {
    leadingZeros += 1;
    decimalExponent -= 1;
  }
  digits = digits.slice(leadingZeros).replace(/0+$/u, "");
  if (digits === "") {
    digits = "0";
    decimalExponent = 1;
  }

  // CPython switches to exponent form outside this window.
  const scientificExponent = decimalExponent - 1;
  if (scientificExponent < -4 || scientificExponent >= 16) {
    const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    const exponentSign = scientificExponent < 0 ? "-" : "+";
    const exponentDigits = String(Math.abs(scientificExponent)).padStart(2, "0");
    return `${sign}${mantissa}e${exponentSign}${exponentDigits}`;
  }

  if (decimalExponent <= 0) {
    return `${sign}0.${"0".repeat(-decimalExponent)}${digits}`;
  }
  if (decimalExponent >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalExponent - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, decimalExponent)}.${digits.slice(decimalExponent)}`;
}

/**
 * A query parameter value, carrying the Python type it must stringify as.
 *
 * The Python builds one `dict` per tool and httpx calls `str()` on each value,
 * but `str()` is type-dependent: `str(100)` is `"100"` while `str(0.0)` is
 * `"0.0"`. `encodeQuery` therefore needs the Python *type*, not just the JS
 * number.
 *
 * Why the type is declared here instead of inferred from the value: JavaScript
 * has one number type, and `JSON.parse` erases the int/float distinction before
 * `callTool` ever sees the arguments. `2` and `2.0` are indistinguishable. So
 * the split is taken from the declared MCP inputSchema — `limit`, `max_depth`
 * and `max_entities` are `"type": "integer"`, `min_confidence` is
 * `"type": "number"` — which is exact for every default and for any fractional
 * value.
 *
 * Remaining divergence: a client that sends an *integral float literal* for a
 * float-typed field (`min_confidence: 1`) produces `min_confidence=1.0` here
 * where the Python would produce `min_confidence=1`. FastAPI parses both to the
 * same float, so the server-visible result is identical; only the URL text
 * differs. A client that sends an integral JSON number for an integer-typed
 * field is exact.
 */
export type QueryValue =
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "raw"; readonly value: string }
  | undefined;

/** A Python `int` parameter. */
export function intParam(value: number): QueryValue {
  return { kind: "int", value };
}

/** A Python `float` parameter. */
export function floatParam(value: number): QueryValue {
  return { kind: "float", value };
}

/** An already-stringified parameter. */
export function rawParam(value: string): QueryValue {
  return { kind: "raw", value };
}

/** `str(value)` for a Python `int`, `float` or `str`. */
function stringifyQueryValue(value: NonNullable<QueryValue>): string {
  switch (value.kind) {
    case "int":
      // Python integers stringify without a decimal point; `String()` agrees.
      return Number.isInteger(value.value) ? String(value.value) : pyFloatToString(value.value);
    case "float":
      return pyFloatToString(value.value);
    case "raw":
      return value.value;
  }
}

/**
 * Serialize query params the way httpx does, preserving insertion order.
 *
 * The Python builds a `dict` and relies on its insertion order, so the query
 * string order is deterministic and part of the request. `undefined` stands in
 * for "key absent", which is what the Python's conditional `if "x" in args`
 * branches produce — there is no `None` reached at this layer.
 */
export function encodeQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${quotePlus(key)}=${quotePlus(stringifyQueryValue(value))}`);
  }
  return parts.join("&");
}

// ============================================================
// JSON narrowing
// ============================================================

/**
 * The formatters receive parsed JSON, whose real shape is only known at
 * runtime. These helpers narrow `unknown` to the fields each formatter reads,
 * so no formatter indexes an unchecked cast.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `data[key]` where the Python would raise `KeyError` on absence. */
function requireField(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) {
    throw new Error(`Response is missing required field '${key}'`);
  }
  return record[key];
}

/** `str(value)` for the scalar types the endpoints emit. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "None";
  return JSON.stringify(value);
}

/** `value` used directly as a formatted confidence. */
function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`Response field '${field}' is not a number`);
  }
  return value;
}

// ============================================================
// Response formatting
// ============================================================
// MCP tool results are text. The AKS endpoints return JSON. These mirror
// `_format_context_response`, `_format_traverse_response`,
// `_format_entities_response` and the inline Stack loop in `_list_stacks`,
// including the bullet character (U+2022) and the exact indentation.

/** Format `/aks/v1/context` output into a compact readable response. */
export function formatContextResponse(data: unknown): string {
  const record = asRecord(data);
  if (record === null) throw new Error("Context response is not an object");

  const lines = [
    `Query: ${asText(requireField(record, "query"))}`,
    `Confidence: ${asText(requireField(record, "confidence"))}`,
    `Reasoning: ${asText(requireField(record, "reasoning"))}`,
    "",
  ];

  const entities = asArray(record["entities"]);
  if (entities.length > 0) {
    lines.push(`Relevant entities (${entities.length}):`);
    for (const entity of entities) {
      const e = asRecord(entity);
      if (e === null) throw new Error("Context entity is not an object");
      const descriptionRaw = e["description"];
      const description =
        typeof descriptionRaw === "string" && descriptionRaw.length > 0
          ? descriptionRaw
          : "(no description)";
      const confidence = asNumber(e["confidence"], "confidence");
      lines.push(
        `  • ${asText(requireField(e, "name"))} [${asText(
          requireField(e, "type"),
        )}, conf ${formatFixed2(confidence)}]`,
      );
      if (description !== "(no description)") {
        lines.push(`    ${description}`);
      }
    }
  } else {
    lines.push("No relevant entities found.");
  }

  const relationships = asArray(record["relationships"]);
  if (relationships.length > 0) {
    lines.push("");
    lines.push(`Relationships (${relationships.length}):`);
    // Relationships carry IDs only; the entity list above is the name lookup.
    const nameMap = new Map<string, string>();
    for (const entity of entities) {
      const e = asRecord(entity);
      if (e === null) continue;
      const id = requireField(e, "id");
      if (typeof id !== "string") throw new Error("Context entity 'id' is not a string");
      nameMap.set(id, asText(requireField(e, "name")));
    }
    for (const relationship of relationships) {
      const r = asRecord(relationship);
      if (r === null) throw new Error("Context relationship is not an object");
      const fromId = asText(requireField(r, "from_entity_id"));
      const toId = asText(requireField(r, "to_entity_id"));
      const fromName = nameMap.get(fromId) ?? fromId;
      const toName = nameMap.get(toId) ?? toId;
      lines.push(`  • ${fromName} —[${asText(requireField(r, "type"))}]→ ${toName}`);
    }
  }

  return lines.join("\n");
}

/** Format `/aks/v1/traverse` output. */
export function formatTraverseResponse(data: unknown): string {
  const record = asRecord(data);
  if (record === null) throw new Error("Traverse response is not an object");

  const lines = [
    `Traversal from: ${asText(requireField(record, "start"))}`,
    `Max depth: ${asText(requireField(record, "max_depth"))}`,
    `Entities reached: ${asText(requireField(record, "entity_count"))}`,
    "",
  ];

  const steps = asArray(record["steps"]);
  if (steps.length === 0) {
    lines.push("(No relationships found from this entity)");
    return lines.join("\n");
  }

  lines.push(`Path (${steps.length} steps):`);
  for (const step of steps) {
    const s = asRecord(step);
    if (s === null) throw new Error("Traverse step is not an object");
    const depth = asNumber(requireField(s, "depth"), "depth");
    // `"  " * s["depth"]`. Python's `str * int` repeats (a negative count yields
    // "", and a float count is a TypeError), while JS `String.repeat` throws
    // RangeError on a negative count. Clamping to 0 reproduces the Python for
    // the integer case; the schema types `depth` as an integer, and BFS emits
    // depths starting at 0.
    if (!Number.isInteger(depth)) {
      throw new Error(`Traverse step 'depth' is not an integer: ${String(depth)}`);
    }
    const indent = "  ".repeat(Math.max(0, depth));
    lines.push(
      `${indent}• ${asText(requireField(s, "from_entity"))} —[${asText(
        requireField(s, "relationship"),
      )}]→ ${asText(requireField(s, "to_entity"))} (depth ${asText(depth)}, conf ${formatFixed2(
        asNumber(requireField(s, "confidence"), "confidence"),
      )})`,
    );
  }

  return lines.join("\n");
}

/** Format `/aks/v1/entities` output (list of entities). */
export function formatEntitiesResponse(data: unknown): string {
  const entities = asArray(data);
  if (entities.length === 0) return "(No entities matched the filter)";

  const lines = [`Found ${entities.length} entities:`, ""];
  for (const entity of entities) {
    const e = asRecord(entity);
    if (e === null) throw new Error("Entity is not an object");
    // `e.get("source", {}).get("verified")` — a missing or non-object `source`
    // is falsy in Python, so it yields no marker rather than an error.
    const source = asRecord(e["source"]);
    const verifiedMarker = source !== null && source["verified"] === true ? " ✓" : "";
    lines.push(
      `• ${asText(requireField(e, "name"))} [${asText(
        requireField(e, "type"),
      )}, conf ${formatFixed2(asNumber(requireField(e, "confidence"), "confidence"))}]${verifiedMarker}`,
    );
    const description = e["description"];
    if (typeof description === "string" && description.length > 0) {
      lines.push(`  ${description}`);
    }
  }

  return lines.join("\n");
}

/** Format `GET /stacks` output — the inline loop from `_list_stacks`. */
export function formatStacksResponse(data: unknown): string {
  const stacks = asArray(data);
  if (stacks.length === 0) return "No Stacks exist on this AKS server yet.";

  const lines = [`Found ${stacks.length} Stack(s):`, ""];
  for (const stack of stacks) {
    const s = asRecord(stack);
    if (s === null) throw new Error("Stack is not an object");
    lines.push(`• ${asText(requireField(s, "name"))} (domain: ${asText(requireField(s, "domain"))})`);
    const description = s["description"];
    if (typeof description === "string" && description.length > 0) {
      lines.push(`    ${description}`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// Tool implementations
// ============================================================

/** A single text content block, the only result type these tools return. */
function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const MISSING_STACK_ERROR = "Error: either 'domain' or 'stack_id' must be provided.";

/** Narrow the tool-call `arguments` payload to a plain record. */
function asArguments(value: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
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

function resolveDependencies(deps: McpDependencies): ResolvedDependencies {
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

async function queryStack(
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

async function traverseStack(
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

async function getEntities(
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
async function listStacks(
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

// ============================================================
// Dispatch
// ============================================================

/**
 * Route a tool call to the matching endpoint, mirroring `call_tool`.
 *
 * An unknown name yields the Python's `f"Unknown tool: {name}"` text as a
 * normal (non-error) result, not a protocol error. MCP clients render that as
 * tool output, which is what the reference server does.
 */
export async function callTool(
  name: string,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
  dependencies: McpDependencies = {},
): Promise<CallToolResult> {
  const deps = resolveDependencies(dependencies);
  const args = asArguments(rawArguments);

  switch (name) {
    case "query_stack":
      return queryStack(args, deps);
    case "traverse_stack":
      return traverseStack(args, deps);
    case "get_entities":
      return getEntities(args, deps);
    case "list_stacks":
      return listStacks(args, deps);
    default:
      return textResult(`Unknown tool: ${name}`);
  }
}

/** The advertised tool list, as `list_tools()` returns it. */
export function listTools(): Tool[] {
  return MCP_TOOLS.map((tool) => tool);
}

// ============================================================
// Server construction
// ============================================================

/**
 * Build the MCP `Server` with both request handlers registered.
 *
 * Exported so tests can drive a real protocol handshake over the SDK's
 * in-memory transport instead of spawning a process or opening a socket.
 */
export function createMcpServer(dependencies: McpDependencies = {}): Server {
  const server = new Server(
    { name: "aks-reference-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments, dependencies),
  );

  return server;
}

/**
 * Run the MCP server over stdio for local clients, like `run_stdio()`.
 *
 * stdio only: no port is bound, so this cannot collide with an AKS API
 * instance listening on 8000.
 */
export async function runStdio(dependencies: McpDependencies = {}): Promise<void> {
  const server = createMcpServer(dependencies);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Entry point, mirroring the Python's `if __name__ == "__main__": main()`.
 *
 * Deliberately not auto-invoked on import: this module is imported by tests
 * and by any launcher that wants `createMcpServer` without stdio. The Python
 * guards its `main()` the same way, so importing `app.mcp_server` never starts
 * a server there either. See `dist/mcp.js` executed directly via
 * `node -e 'import("./dist/mcp.js").then((m) => m.main())'` or a launcher script.
 *
 * A rejected startup is a hard exit, as in Python: a stdio MCP server that
 * fails to bind has no channel to report the failure on, only stderr and a
 * non-zero status for the client that spawned it.
 */
export async function main(): Promise<void> {
  try {
    await runStdio();
  } catch (error) {
    console.error("MCP server failed to start:", error);
    process.exitCode = 1;
  }
}
