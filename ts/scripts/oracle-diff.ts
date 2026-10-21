/**
 * Reproducible oracle-diff harness (T0.8).
 *
 * Replays one ordered scenario list against two servers — the Python oracle and
 * the TypeScript port — and compares the responses structurally. Every later
 * Wave 1 slice depends on this tool, so the comparison is deliberately strict:
 * status codes must match exactly, and JSON bodies are compared with an
 * order-preserving deep compare after masking only UUIDs and timestamps.
 *
 * Run:
 *
 *   npx tsx scripts/oracle-diff.ts         # 8000 vs 8001, both assumed up
 *   npx tsx scripts/oracle-diff.ts --boot  # boot the TS server itself
 *   npm run test:oracle
 *
 * ---------------------------------------------------------------------------
 * The shared-database hazard, and the mechanism chosen against it
 * ---------------------------------------------------------------------------
 *
 * The oracle and the TypeScript server point at the SAME Postgres database. A
 * naive differential self-collides: the oracle's `POST /stacks` creates
 * `domain = X`, then the TS `POST /stacks` with the same body correctly answers
 * `409`, and the harness reports a false failure. `GET /stacks` is worse — it
 * returns the whole table, so a fixture left behind by the first target shows up
 * in the second target's list body and fails the structural comparison.
 *
 * Two mechanisms were considered:
 *
 *   1. distinct fixture domains per target (suffix the domain with the target
 *      name), and/or
 *   2. a deterministic reset between target runs.
 *
 * This harness implements **(2)**. Option (1) alone cannot work for this
 * vertical: `GET /stacks` has no filter, so target-specific domains would make
 * the two list bodies differ by fixture content (`...-oracle` vs `...-ts`).
 * Making them equal would require masking the `domain` field — and the
 * normalization rules here explicitly forbid masking anything beyond UUIDs and
 * timestamps. A masked domain would also hide real divergences in the very
 * field the duplicate-domain scenario is about.
 *
 * So the reset is load-bearing, and it runs:
 *
 *   - before the first target run (reclaiming rows from a crashed earlier run),
 *   - between the two target runs (so both targets start from the same state),
 *   - in a `finally` after the last target run (so the database is left empty,
 *     including when a scenario throws or a comparison fails).
 *
 * Rows are identified by the `oraclediff-` domain prefix — the natural cleanup
 * key (`domain` is UNIQUE, and the prefix is stable across runs so leftovers are
 * always reclaimable). Every table referencing `stacks(id)` declares
 * `on delete cascade`, so deleting these rows cannot be blocked by a foreign
 * key. Only rows carrying the prefix are ever deleted; nothing else in the
 * database is touched.
 *
 * Do not run two instances of this harness concurrently against the same
 * database: they share the prefix and would delete each other's fixtures.
 *
 * ---------------------------------------------------------------------------
 * Known gaps (see oracle/README.md)
 * ---------------------------------------------------------------------------
 *
 * This harness does not prove:
 *   - trailing-slash equivalence (FastAPI 307 vs Express passthrough);
 *   - malformed-JSON response equivalence (`{bad`: oracle 422 `json_invalid`,
 *     Express 400);
 *   - anything outside the stacks vertical.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// JSON value model — no `any`, no unchecked casts
// ---------------------------------------------------------------------------

/** The JSON domain, used for request bodies and normalized response bodies. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

/**
 * Narrows an already-parsed JSON value into {@link JsonValue}.
 *
 * `JSON.parse` is typed `any`; receiving it as `unknown` and re-deriving the
 * shape structurally keeps the rest of this file cast-free. A value that cannot
 * be represented in JSON is a harness bug, not caller input.
 */
function toJsonValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) =>
      toJsonValue(item, `${path}[${String(index)}]`),
    );
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = toJsonValue(item, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`unexpected non-JSON value at ${path}: ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Normalization — masks UUIDs and timestamps, nothing else
// ---------------------------------------------------------------------------

/**
 * Any 8-4-4-4-12 hex UUID, in any case. Covers the canonical lowercase form the
 * oracle emits and the variants a client can send (which are also normalized by
 * `pydanticUuid` before appearing in a 404 `detail`).
 */
const UUID_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * The same shape, anchored: used to validate a captured `id` before it is bound
 * into a path. Distinct from {@link UUID_PATTERN} because that one is global and
 * therefore stateful across `.test()` calls.
 */
const UUID_EXACT =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `YYYY-MM-DDTHH:MM:SS(.ffffff)?Z` — the only timestamp form either server
 * emits (`db.ts` normalizes Postgres text into exactly this shape).
 */
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?Z/g;

/**
 * Masks UUIDs and timestamps inside a string.
 *
 * Nothing else is masked. Domain slugs, names, `scope`, every validation field
 * and the non-UUID part of every `detail` message stay untouched, so a
 * divergence in any of them is still reported.
 */
function normalizeString(value: string): string {
  return value.replace(UUID_PATTERN, "<UUID>").replace(TIMESTAMP_PATTERN, "<TS>");
}

/** Recursively applies {@link normalizeString} to every string in the value. */
function normalizeValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (isJsonArray(value)) {
    return value.map(normalizeValue);
  }
  if (isJsonObject(value)) {
    const out: { [key: string]: JsonValue } = {};
    // Iterating `Object.keys` preserves the parsed object's insertion order,
    // which for these contracts is part of the contract.
    for (const key of Object.keys(value)) {
      const item = value[key];
      out[key] = item === undefined ? null : normalizeValue(item);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Order-preserving deep compare
// ---------------------------------------------------------------------------

interface JsonDiff {
  readonly path: string;
  readonly left: JsonValue;
  readonly right: JsonValue;
  readonly note: string;
}

function truncate(value: JsonValue): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length <= 140 ? text : `${text.slice(0, 137)}...`;
}

/**
 * True when a 422 body reports a `uuid_parsing` failure on the path parameter.
 *
 * Used as a harness invariant, not a comparison rule: a scenario that binds a
 * captured id must never produce this, because it means the id it sent was not a
 * UUID. Both targets would answer identically and the comparison would report a
 * PASS for a resource operation that never happened.
 */
function isPathUuidRejection(body: ParsedBody): boolean {
  if (body.kind !== "json" || !isJsonObject(body.raw)) {
    return false;
  }
  const detail = body.raw["detail"];
  // `noUncheckedIndexedAccess` types indexed reads as possibly `undefined`, so
  // the absence check comes first and narrows the union before `isJsonArray`.
  if (detail === undefined || !isJsonArray(detail)) {
    return false;
  }
  return detail.some((entry) => {
    if (!isJsonObject(entry)) {
      return false;
    }
    const type = entry["type"];
    const loc = entry["loc"];
    if (loc === undefined || !isJsonArray(loc)) {
      return false;
    }
    return type === "uuid_parsing" && loc[0] === "path" && loc[1] === "stack_id";
  });
}

/**
 * Returns the first difference between `left` and `right`, or `undefined`.
 *
 * Object keys are compared **as an ordered sequence**, not as a set: for these
 * contracts field order is part of the contract (the oracle serializes
 * `StackResponse` in declaration order and the TS port reproduces it), so a
 * reordered body is a divergence worth reporting rather than normalizing away.
 */
function diffJson(
  left: JsonValue,
  right: JsonValue,
  path: string,
): JsonDiff | undefined {
  if (isJsonArray(left) || isJsonArray(right)) {
    if (!isJsonArray(left) || !isJsonArray(right)) {
      return { path, left, right, note: "array vs non-array" };
    }
    if (left.length !== right.length) {
      return { path, left: left.length, right: right.length, note: "array length" };
    }
    for (let index = 0; index < left.length; index += 1) {
      const leftItem = left[index];
      const rightItem = right[index];
      // `noUncheckedIndexedAccess` cannot see the length check above.
      if (leftItem === undefined || rightItem === undefined) {
        continue;
      }
      const nested = diffJson(leftItem, rightItem, `${path}[${String(index)}]`);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      return { path, left, right, note: "object vs non-object" };
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.join("\u0000") !== rightKeys.join("\u0000")) {
      // Reported as a key list rather than a value: this is exactly the case
      // where field order drifted, and the two orders are the whole evidence.
      return { path, left: leftKeys, right: rightKeys, note: "key order or key set" };
    }
    for (const key of leftKeys) {
      const leftItem = left[key];
      const rightItem = right[key];
      if (leftItem === undefined || rightItem === undefined) {
        continue;
      }
      const nested = diffJson(leftItem, rightItem, `${path}.${key}`);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (Object.is(left, right)) {
    return undefined;
  }
  return { path, left, right, note: "value" };
}

// ---------------------------------------------------------------------------
// Observation model
// ---------------------------------------------------------------------------

/**
 * A parsed response body.
 *
 * `normalized` is what the comparison sees. `raw` is the un-normalized value and
 * exists for exactly one purpose: capturing the `id` a dependent scenario binds
 * into its path. Capturing from `normalized` would yield the literal string
 * `<UUID>`, which every UUID path parameter rejects — both targets would then
 * answer `422`, the comparison would find them equal, and the harness would
 * report a PASS for a resource scenario that never touched a resource.
 */
type ParsedBody =
  | { readonly kind: "empty"; readonly rawText: string }
  | {
      readonly kind: "json";
      readonly normalized: JsonValue;
      readonly raw: JsonValue;
    };

interface Observation {
  readonly status: number;
  readonly body: ParsedBody;
}

function parseBody(rawText: string): ParsedBody {
  if (rawText.trim() === "") {
    return { kind: "empty", rawText };
  }
  const parsed: unknown = JSON.parse(rawText);
  const raw = toJsonValue(parsed, "$");
  return { kind: "json", normalized: normalizeValue(raw), raw };
}

/** Renders a body for a failure message; keeps `204 empty` visible. */
function describeBody(body: ParsedBody): string {
  return body.kind === "empty" ? "<empty body>" : truncate(body.normalized);
}

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** The per-target run state a scenario body or path may reference. */
interface RunContext {
  /** The fixture domain for this run, e.g. `oraclediff-m1k2j3`. */
  readonly domain: string;
}

interface Scenario {
  readonly id: string;
  readonly method: HttpMethod;
  /** Path template; `{id}` is replaced with the id captured by `dependsOn`. */
  readonly path: string;
  readonly body: ((ctx: RunContext) => JsonValue) | undefined;
  /** Scenario whose response `id` this scenario needs. */
  readonly dependsOn: string | undefined;
  /** Send no `X-API-Key` header even when a key is configured. */
  readonly omitAuth: boolean;
  /**
   * True when the scenario's whole point is the guarded (`401`) branch.
   *
   * Such a scenario is only meaningful when both targets have `AKS_API_KEY`
   * configured; in open mode it would compare two `200`s and report a `PASS`
   * for a contract it never exercised, which is exactly the kind of green that
   * hides a gap. It is reported as `SKIP` instead.
   */
  readonly requiresGuardedMode: boolean;
}

/** An unknown-but-valid UUID used where a 404 is expected. */
const UNKNOWN_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/**
 * The ordered scenario list: the whole stacks vertical, plus health and auth.
 *
 * Order is load-bearing. Creation precedes everything that needs a row; the list
 * runs while exactly one fixture row exists; the patch family precedes the
 * delete pair. The validation scenarios run after the row is gone, which is safe
 * because every one of them fails validation before the uniqueness check ever
 * runs — so none of them can create a row and pollute a later step.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    id: "health",
    method: "GET",
    path: "/health",
    body: undefined,
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "post-valid",
    method: "POST",
    path: "/stacks",
    body: (ctx) => ({
      name: "T0.8 Stack",
      domain: ctx.domain,
      description: "created by the oracle-diff harness",
    }),
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "post-duplicate-domain",
    method: "POST",
    path: "/stacks",
    // The same domain as `post-valid`, deliberately: the duplicate check is
    // per-request, so this must be a 409 on both targets. This is the exact case
    // that self-collides without the deterministic reset; see the file header.
    body: (ctx) => ({ name: "T0.8 Sibling", domain: ctx.domain }),
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "get-list",
    method: "GET",
    path: "/stacks",
    body: undefined,
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "get-by-id",
    method: "GET",
    path: "/stacks/{id}",
    body: undefined,
    dependsOn: "post-valid",
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "get-unknown-uuid",
    method: "GET",
    path: `/stacks/${UNKNOWN_UUID}`,
    body: undefined,
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "patch-single-field",
    method: "PATCH",
    path: "/stacks/{id}",
    body: () => ({ description: "patched once" }),
    dependsOn: "post-valid",
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "patch-multiple-fields",
    method: "PATCH",
    path: "/stacks/{id}",
    body: () => ({
      name: "T0.8 Renamed",
      scope: "domain",
      synthesize_descriptions: true,
    }),
    dependsOn: "post-valid",
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "patch-empty-body",
    method: "PATCH",
    path: "/stacks/{id}",
    body: () => ({}),
    dependsOn: "post-valid",
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "patch-unknown-uuid",
    method: "PATCH",
    path: `/stacks/${UNKNOWN_UUID}`,
    body: () => ({ name: "Nope" }),
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "delete-existing",
    method: "DELETE",
    path: "/stacks/{id}",
    body: undefined,
    dependsOn: "post-valid",
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "delete-twice",
    method: "DELETE",
    path: "/stacks/{id}",
    body: undefined,
    dependsOn: "post-valid",
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "post-invalid-empty-name",
    method: "POST",
    path: "/stacks",
    // The fixture domain is well-formed, so `name` is the only failure and the
    // comparison stays about that one field.
    body: (ctx) => ({ name: "", domain: ctx.domain }),
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "post-invalid-domain-pattern",
    method: "POST",
    path: "/stacks",
    body: () => ({ name: "X", domain: "NOT-A-SLUG" }),
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "post-invalid-scope-literal",
    method: "POST",
    path: "/stacks",
    body: (ctx) => ({ name: "X", domain: ctx.domain, scope: "INVALID" }),
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "post-invalid-missing-field",
    method: "POST",
    path: "/stacks",
    body: () => ({ name: "X" }),
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "post-non-object-body",
    method: "POST",
    path: "/stacks",
    // A bare JSON number. Both servers answer 422 `model_attributes_type`; this
    // is why `express.json` runs with `strict: false` in `server.ts`.
    body: () => 5,
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "non-uuid-path-param",
    method: "GET",
    path: "/stacks/not-a-uuid",
    body: undefined,
    dependsOn: undefined,
    omitAuth: false,
    requiresGuardedMode: false,
  },
  {
    id: "auth-missing-header",
    method: "GET",
    path: "/stacks",
    body: undefined,
    dependsOn: undefined,
    omitAuth: true,
    requiresGuardedMode: true,
  },
];

// ---------------------------------------------------------------------------
// Options and CLI parsing
// ---------------------------------------------------------------------------

interface Options {
  readonly oracleUrl: string;
  readonly tsUrl: string;
  readonly boot: boolean;
  readonly bootPort: number;
  readonly apiKey: string | undefined;
  readonly databaseUrl: string;
}

const DEFAULT_ORACLE_URL = "http://localhost:8000";
const DEFAULT_TS_URL = "http://localhost:8001";
const DEFAULT_BOOT_PORT = 8001;
/** Host port 5434 comes from `docker-compose.override.yml`; 5432 is taken. */
const DEFAULT_DATABASE_URL = "postgresql://aks:aks@localhost:5434/aks";

/** The oracle's port. A booted server may never use it. */
const ORACLE_PORT = 8000;

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function parsePort(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${flag} expects an integer in 1-65535, received "${raw}"`);
  }
  return parsed;
}

/**
 * Parses CLI flags. Both `--flag=value` and `--flag value` are accepted, and
 * bare `--boot` is a boolean.
 *
 * Precedence: CLI flag > environment variable > default.
 */
function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  const flags = new Map<string, string>();
  const booleanFlags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsAt = withoutPrefix.indexOf("=");
    if (equalsAt >= 0) {
      flags.set(withoutPrefix.slice(0, equalsAt), withoutPrefix.slice(equalsAt + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(withoutPrefix, next);
      index += 1;
      continue;
    }
    booleanFlags.add(withoutPrefix);
  }

  // Reject unrecognized flags instead of ignoring them. Silently accepting a
  // typo is how a confident green run gets produced from a comparison nobody
  // asked for: passing `--ts` where the harness expects `--ts-url` leaves the
  // default in place, and the run then compares against whatever the default
  // points at. That exact mistake produced a false pass during development.
  const KNOWN_FLAGS = new Set(
    [
      "oracle-url",
      "ts-url",
      "boot",
      "boot-port",
      "api-key",
      "database-url",
    ].concat([...booleanFlags].filter((flag) => flag === "boot")),
  );
  const unknownFlags = [
    ...new Set([...flags.keys(), ...booleanFlags]),
  ].filter((flag) => !KNOWN_FLAGS.has(flag));
  if (unknownFlags.length > 0) {
    throw new Error(
      `oracle-diff: unrecognized flag${unknownFlags.length === 1 ? "" : "s"} ` +
        `${unknownFlags.map((flag) => `--${flag}`).join(", ")}. ` +
        `Known flags: ${[...KNOWN_FLAGS].map((flag) => `--${flag}`).join(", ")}.`,
    );
  }

  const envString = (key: string): string | undefined => {
    const value = env[key];
    return value === undefined || value.trim() === "" ? undefined : value;
  };

  const rawBootPort =
    flags.get("boot-port") ??
    envString("ORACLE_DIFF_BOOT_PORT") ??
    String(DEFAULT_BOOT_PORT);

  return {
    oracleUrl: stripTrailingSlashes(
      flags.get("oracle-url") ??
        envString("ORACLE_DIFF_ORACLE_URL") ??
        DEFAULT_ORACLE_URL,
    ),
    tsUrl: stripTrailingSlashes(
      flags.get("ts-url") ?? envString("ORACLE_DIFF_TS_URL") ?? DEFAULT_TS_URL,
    ),
    boot: booleanFlags.has("boot"),
    bootPort: parsePort(rawBootPort, "--boot-port"),
    apiKey: flags.get("api-key") ?? envString("ORACLE_DIFF_API_KEY"),
    databaseUrl:
      flags.get("database-url") ??
      envString("ORACLE_DIFF_DATABASE_URL") ??
      envString("AKS_TEST_DATABASE_URL") ??
      DEFAULT_DATABASE_URL,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;

type RequestOutcome =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly error: string };

interface RequestInput {
  readonly baseUrl: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly body: JsonValue | undefined;
  readonly apiKey: string | undefined;
  readonly sendAuth: boolean;
}

async function performRequest(input: RequestInput): Promise<RequestOutcome> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (input.sendAuth && input.apiKey !== undefined) {
    headers["X-API-Key"] = input.apiKey;
  }

  try {
    const response = await fetch(`${input.baseUrl}${input.path}`, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Read the text once: emptiness is part of the contract (204 has no body),
    // and the same text is then parsed.
    const rawText = await response.text();

    let body: ParsedBody;
    try {
      body = parseBody(rawText);
    } catch (error) {
      return {
        ok: false,
        error:
          `response body was not valid JSON ` +
          `(${error instanceof Error ? error.message : String(error)}): ${rawText.slice(0, 140)}`,
      };
    }

    return { ok: true, observation: { status: response.status, body } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** True when `${url}/health` answers 2xx within a short bound. */
async function isUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Waits for `${url}/health`, giving up early when the child process dies.
 *
 * Without the child-exit race, a booted server that fails its own startup
 * validation (a missing provider credential, a bad DATABASE_URL) would look like
 * a 30-second hang instead of the immediate, self-describing error it printed on
 * stderr.
 */
async function waitForHealth(
  url: string,
  timeoutMs: number,
  child?: ChildProcess,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      return false;
    }
    if (await isUp(url)) {
      return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth-mode preflight
// ---------------------------------------------------------------------------

/**
 * What an unauthenticated `GET /stacks` returned, which reveals whether the
 * target has an API key configured.
 *
 * Auth in this service is purely configuration (`AKS_API_KEY`), not code, so a
 * differential can only compare auth behaviour when both targets agree on the
 * mode. Measuring it here turns an environment mismatch into a clear preflight
 * error instead of 19 confusing scenario failures.
 */
type AuthMode = "open" | "guarded";

interface AuthProbe {
  readonly mode: AuthMode;
  readonly detail: string;
}

async function probeAuthMode(baseUrl: string): Promise<AuthProbe> {
  const outcome = await performRequest({
    baseUrl,
    method: "GET",
    path: "/stacks",
    body: undefined,
    apiKey: undefined,
    sendAuth: false,
  });

  if (!outcome.ok) {
    return { mode: "open", detail: `probe failed: ${outcome.error}` };
  }
  const { status } = outcome.observation;
  if (status === 401) {
    return { mode: "guarded", detail: "unauthenticated GET /stacks -> 401" };
  }
  if (status === 200) {
    return { mode: "open", detail: "unauthenticated GET /stacks -> 200" };
  }
  // Anything else (5xx, 404) is not an auth signal; report it as open so the
  // per-scenario comparison surfaces the real problem with full detail.
  return { mode: "open", detail: `unauthenticated GET /stacks -> ${String(status)}` };
}

// ---------------------------------------------------------------------------
// Target run
// ---------------------------------------------------------------------------

/** Observations keyed by scenario id, plus the ids captured from responses. */
interface TargetRun {
  readonly observations: ReadonlyMap<string, Observation>;
  readonly capturedIds: ReadonlyMap<string, string>;
}

interface RunSettings {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  /** Diagnostics label for error messages (`oracle` / `ts`). */
  readonly guard: string;
  /** When false, scenarios whose point is the `401` branch are not sent. */
  readonly guardedAuth: boolean;
}

async function runScenarios(
  settings: RunSettings,
  ctx: RunContext,
): Promise<TargetRun> {
  const observations = new Map<string, Observation>();
  const capturedIds = new Map<string, string>();

  for (const scenario of SCENARIOS) {
    if (scenario.requiresGuardedMode && !settings.guardedAuth) {
      // Sending it would compare two `200`s and produce a PASS for a contract
      // that was never exercised. The verdict is SKIP; see the scenario comment.
      continue;
    }

    let path = scenario.path;
    if (path.includes("{id}")) {
      const dependency = scenario.dependsOn;
      const id = dependency === undefined ? undefined : capturedIds.get(dependency);
      if (id === undefined) {
        throw new Error(
          `${settings.guard}: scenario "${scenario.id}" needs an id from ` +
            `"${String(dependency)}" but none was captured`,
        );
      }
      path = path.replace("{id}", id);
    }

    const outcome = await performRequest({
      baseUrl: settings.baseUrl,
      method: scenario.method,
      path,
      body: scenario.body?.(ctx),
      apiKey: settings.apiKey,
      sendAuth: !scenario.omitAuth,
    });

    if (!outcome.ok) {
      throw new Error(
        `${settings.guard}: scenario "${scenario.id}" (${scenario.method} ${path}) failed: ${outcome.error}`,
      );
    }

    if (
      scenario.dependsOn !== undefined &&
      outcome.observation.status === 422 &&
      isPathUuidRejection(outcome.observation.body)
    ) {
      // See `isPathUuidRejection`: this can only happen when the binding is
      // broken, and comparing it away is precisely the silent-green failure this
      // guard exists to prevent.
      throw new Error(
        `${settings.guard}: scenario "${scenario.id}" bound an id into its path and got a ` +
          `uuid_parsing 422 back, so the captured id was not a UUID. ` +
          `Body: ${describeBody(outcome.observation.body)}`,
      );
    }

    observations.set(scenario.id, outcome.observation);

    const body = outcome.observation.body;
    if (body.kind === "json" && isJsonObject(body.raw)) {
      // Any response carrying a string `id` becomes a binding target, so adding
      // a dependent scenario needs no change here. Read from the RAW body: see
      // the `ParsedBody` comment for why the normalized one is unusable.
      const id = body.raw["id"];
      if (typeof id === "string") {
        // Structural guard. A non-UUID binding would make every dependent
        // scenario answer 422 on both sides and compare as PASS, so it is a
        // harness failure rather than a result worth reporting.
        if (!UUID_EXACT.test(id)) {
          throw new Error(
            `${settings.guard}: scenario "${scenario.id}" returned id ${JSON.stringify(id)}, ` +
              "which is not a canonical UUID; dependent scenarios would compare two 422s and pass falsely",
          );
        }
        capturedIds.set(scenario.id, id);
      }
    }
  }

  return { observations, capturedIds };
}

// ---------------------------------------------------------------------------
// Database reset — the shared-database mechanism
// ---------------------------------------------------------------------------

/** Stable prefix for every fixture this harness creates, across runs. */
const DOMAIN_PREFIX = "oraclediff-";

function connectDatabase(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 });
}

async function deleteFixtureRows(sql: Sql): Promise<void> {
  await sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`;
}

/**
 * Counts rows after cleanup.
 *
 * `::int` on the `count(*)` keeps the driver from returning bigint-as-string,
 * which would otherwise require a parse for a value this harness asserts on.
 */
async function countRows(
  sql: Sql,
  scope: "fixture" | "all",
): Promise<number> {
  const rows =
    scope === "fixture"
      ? await sql<{ total: number }[]>`
          select count(*)::int as total from stacks
          where domain like ${`${DOMAIN_PREFIX}%`}
        `
      : await sql<{ total: number }[]>`select count(*)::int as total from stacks`;
  return rows[0]?.total ?? -1;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

type ScenarioVerdict =
  | { readonly kind: "pass"; readonly scenarioId: string; readonly status: number }
  | {
      readonly kind: "fail";
      readonly scenarioId: string;
      readonly detail: string;
    }
  | { readonly kind: "skip"; readonly scenarioId: string; readonly reason: string };

function compareScenario(
  scenarioId: string,
  oracle: Observation,
  ts: Observation,
): ScenarioVerdict {
  if (oracle.status !== ts.status) {
    return {
      kind: "fail",
      scenarioId,
      detail: `status ${String(oracle.status)} (oracle) vs ${String(ts.status)} (ts)`,
    };
  }

  if (oracle.body.kind !== ts.body.kind) {
    return {
      kind: "fail",
      scenarioId,
      detail:
        `body kind ${oracle.body.kind} (oracle) vs ${ts.body.kind} (ts): ` +
        `oracle ${describeBody(oracle.body)} / ts ${describeBody(ts.body)}`,
    };
  }

  if (oracle.body.kind === "empty" || ts.body.kind === "empty") {
    // Both are empty at this point; the statuses already matched.
    return { kind: "pass", scenarioId, status: ts.status };
  }

  const diff = diffJson(oracle.body.normalized, ts.body.normalized, "$");
  if (diff === undefined) {
    return { kind: "pass", scenarioId, status: ts.status };
  }

  return {
    kind: "fail",
    scenarioId,
    detail:
      `first diff at ${diff.path} (${diff.note}): ` +
      `oracle ${truncate(diff.left)} / ts ${truncate(diff.right)}`,
  };
}

// ---------------------------------------------------------------------------
// Boot support
// ---------------------------------------------------------------------------

const BOOT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Boots the TypeScript server on `bootPort` as a child process.
 *
 * Only reached with `--boot` and only when the TS target is not already up. Port
 * 8000 belongs to the oracle and is refused unconditionally: this harness never
 * starts or stops anything there.
 */
function bootTsServer(options: Options): ChildProcess {
  if (options.bootPort === ORACLE_PORT) {
    throw new Error(
      `refusing to boot the TS server on port ${String(ORACLE_PORT)}: that port belongs to the Python oracle`,
    );
  }

  const tsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: tsRoot,
    env: { ...process.env, PORT: String(options.bootPort) },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      resolveExit();
    });
  });
  child.kill("SIGTERM");
  const timeout = new Promise<void>((resolveTimeout) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveTimeout();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
  await Promise.race([exited, timeout]);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(
  verdicts: readonly ScenarioVerdict[],
  database: { readonly fixtureRows: number; readonly totalRows: number },
  aborted: boolean,
): void {
  console.log("");
  console.log("scenario results");

  for (const verdict of verdicts) {
    if (verdict.kind === "pass") {
      console.log(`  PASS  ${verdict.scenarioId.padEnd(28)} ${String(verdict.status)}`);
    } else if (verdict.kind === "skip") {
      console.log(`  SKIP  ${verdict.scenarioId.padEnd(28)} ${verdict.reason}`);
    } else {
      console.log(`  FAIL  ${verdict.scenarioId.padEnd(28)} ${verdict.detail}`);
    }
  }

  const passed = verdicts.filter((verdict) => verdict.kind === "pass").length;
  const failed = verdicts.filter((verdict) => verdict.kind === "fail").length;
  const skipped = verdicts.filter((verdict) => verdict.kind === "skip").length;

  console.log("");
  // The harness's own side effect on the shared database has to be observable,
  // so this prints even when a scenario failed.
  console.log(
    `database after run: ${String(database.fixtureRows)} row(s) with prefix ` +
      `"${DOMAIN_PREFIX}", ${String(database.totalRows)} row(s) in stacks total`,
  );
  if (database.fixtureRows !== 0 || database.totalRows !== 0) {
    console.log(
      "  note: the table is not empty. This harness deletes only its own prefix; " +
        "anything else was left by another writer, so a re-run may not be comparable.",
    );
  }

  console.log(
    `oracle-diff: ${String(passed)} passed, ${String(failed)} failed, ` +
      `${String(skipped)} skipped (of ${String(verdicts.length)} scenarios)`,
  );

  // An aborted run produced no verdicts at all. Printing PASS for it would be
  // the worst possible outcome of a verification tool, so it is called out
  // separately and never collapses into a green result.
  if (aborted) {
    console.log("RESULT: ABORTED — no comparison was made, so this run proves nothing");
  } else {
    console.log(failed === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2), process.env);

  // A comparison of a server against itself cannot fail, so it must never be
  // reported as a pass. Without this guard, `--ts-url` left pointing at the
  // oracle produces a full green run of eighteen checks that proves nothing,
  // which is the same silent-green class as the id-binding and aborted-run
  // bugs fixed earlier. Misconfigured CI is the realistic way to hit it.
  if (options.oracleUrl === options.tsUrl) {
    console.error(
      `oracle-diff: --oracle-url and --ts-url are the same (${options.oracleUrl}).\n` +
        "Comparing a server against itself cannot produce a meaningful result, " +
        "so this run is refused rather than reported as a pass.",
    );
    return 2;
  }

  console.log("oracle-diff harness");
  console.log(`  oracle:  ${options.oracleUrl}`);
  console.log(`  ts:      ${options.tsUrl}`);
  console.log(`  database: ${options.databaseUrl}`);
  console.log("");

  // The oracle is read-only infrastructure: never start it, never stop it.
  if (!(await isUp(options.oracleUrl))) {
    console.error(
      `oracle-diff: the oracle at ${options.oracleUrl} is not answering /health. ` +
        "Start it yourself (docker compose up -d api); this harness never starts or stops it.",
    );
    return 2;
  }

  let booted: ChildProcess | undefined;
  if (await isUp(options.tsUrl)) {
    console.log(`using the already-running TS server at ${options.tsUrl}`);
  } else if (options.boot) {
    const expected = `http://localhost:${String(options.bootPort)}`;
    if (options.tsUrl !== expected) {
      console.error(
        `oracle-diff: --boot would start the server on ${expected}, but --ts-url is ${options.tsUrl}. ` +
          "Set both to the same port.",
      );
      return 2;
    }
    console.log(`booting the TS server on port ${String(options.bootPort)}...`);
    booted = bootTsServer(options);
    if (!(await waitForHealth(options.tsUrl, BOOT_TIMEOUT_MS, booted))) {
      const exitedEarly =
        booted.exitCode !== null || booted.signalCode !== null;
      await stopServer(booted);
      console.error(
        exitedEarly
          ? "oracle-diff: the booted TS server exited during startup. Its own output above says why " +
              "(a common cause is a provider credential it validates before binding the port)."
          : `oracle-diff: the booted TS server did not answer ${options.tsUrl}/health within ${String(BOOT_TIMEOUT_MS)}ms.`,
      );
      return 2;
    }
  } else {
    console.error(
      `oracle-diff: the TS server at ${options.tsUrl} is not answering /health. ` +
        "Pass --boot, or start it yourself (PORT=8001 DATABASE_URL=... npm run dev).",
    );
    return 2;
  }

  // Auth is configuration, not code: the comparison is only meaningful when both
  // targets agree on it. Measure before running anything.
  const oracleAuth = await probeAuthMode(options.oracleUrl);
  const tsAuth = await probeAuthMode(options.tsUrl);
  console.log(
    `  oracle auth: ${oracleAuth.mode} (${oracleAuth.detail})`,
  );
  console.log(`  ts auth:     ${tsAuth.mode} (${tsAuth.detail})`);

  if (oracleAuth.mode !== tsAuth.mode) {
    console.error(
      "",
      "oracle-diff: the two targets disagree about auth, so no scenario is comparable.\n" +
        `  oracle: ${oracleAuth.mode}, ts: ${tsAuth.mode}.\n` +
        "  Auth is driven by AKS_API_KEY, not by the ported code. Give both the same value " +
        "(or neither) and re-run.",
    );
    if (booted !== undefined) {
      await stopServer(booted);
    }
    return 2;
  }

  if (oracleAuth.mode === "guarded" && options.apiKey === undefined) {
    console.error(
      "",
      "oracle-diff: both targets require an API key, but none was supplied.\n" +
        "  Pass --api-key <value> (or ORACLE_DIFF_API_KEY) so the authenticated scenarios can run.",
    );
    if (booted !== undefined) {
      await stopServer(booted);
    }
    return 2;
  }

  if (oracleAuth.mode === "open") {
    console.log(
      "  note: both targets are open (no AKS_API_KEY), so auth-missing-header is reported SKIP. " +
        "To exercise the 401 branch, set AKS_API_KEY on BOTH servers and pass the same value here.",
    );
  }
  console.log("");

  const sql = connectDatabase(options.databaseUrl);
  // Distinct from anything a previous run created, and inside the reclaimable
  // prefix so cleanup always finds it.
  const ctx: RunContext = { domain: `${DOMAIN_PREFIX}${Date.now().toString(36)}` };
  const verdicts: ScenarioVerdict[] = [];
  let aborted = false;

  try {
    // Reclaim leftovers from a crashed earlier run before measuring anything.
    await deleteFixtureRows(sql);

    let oracleRun: TargetRun;
    try {
      oracleRun = await runScenarios(
        {
          baseUrl: options.oracleUrl,
          apiKey: options.apiKey,
          guard: "oracle",
          guardedAuth: oracleAuth.mode === "guarded",
        },
        ctx,
      );
    } catch (error) {
      console.error(
        `oracle-diff: aborted during the oracle run: ${error instanceof Error ? error.message : String(error)}`,
      );
      aborted = true;
      oracleRun = { observations: new Map(), capturedIds: new Map() };
    }

    if (!aborted) {
      // The deterministic reset that makes the second target's `POST /stacks` a
      // 201 instead of a 409 and makes `GET /stacks` symmetric. Load-bearing;
      // see the file header.
      await deleteFixtureRows(sql);

      let tsRun: TargetRun;
      try {
        tsRun = await runScenarios(
          {
            baseUrl: options.tsUrl,
            apiKey: options.apiKey,
            guard: "ts",
            guardedAuth: tsAuth.mode === "guarded",
          },
          ctx,
        );
      } catch (error) {
        console.error(
          `oracle-diff: aborted during the ts run: ${error instanceof Error ? error.message : String(error)}`,
        );
        aborted = true;
        tsRun = { observations: new Map(), capturedIds: new Map() };
      }

      if (!aborted) {
        for (const scenario of SCENARIOS) {
          if (scenario.requiresGuardedMode && oracleAuth.mode === "open") {
            verdicts.push({
              kind: "skip",
              scenarioId: scenario.id,
              reason:
                "both targets are open (no AKS_API_KEY), so the 401 branch was not exercised",
            });
            continue;
          }

          const oracleObservation = oracleRun.observations.get(scenario.id);
          const tsObservation = tsRun.observations.get(scenario.id);
          if (oracleObservation === undefined || tsObservation === undefined) {
            verdicts.push({
              kind: "fail",
              scenarioId: scenario.id,
              detail: "scenario produced no observation on at least one target",
            });
            continue;
          }
          verdicts.push(compareScenario(scenario.id, oracleObservation, tsObservation));
        }
      }
    }
  } finally {
    // Leave the shared database empty on every path, including aborts.
    let fixtureRows = -1;
    let totalRows = -1;
    try {
      await deleteFixtureRows(sql);
      fixtureRows = await countRows(sql, "fixture");
      totalRows = await countRows(sql, "all");
    } catch (error) {
      console.error(
        `oracle-diff: fixture cleanup or count failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    printReport(verdicts, { fixtureRows, totalRows }, aborted);

    await sql.end({ timeout: 5 }).catch(() => undefined);
    if (booted !== undefined) {
      await stopServer(booted);
    }
  }

  if (aborted) {
    return 2;
  }
  return verdicts.some((verdict) => verdict.kind === "fail") ? 1 : 0;
}

// Rejected before the run's own `try` (a malformed flag, a refused boot port)
// would otherwise surface as an unhandled rejection with a stack trace instead of
// a readable harness error.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      `oracle-diff: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  },
);
