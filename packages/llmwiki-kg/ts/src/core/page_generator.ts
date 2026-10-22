import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "../db.js";
import { complete } from "./llm_clients.js";
import { config } from "../config.js";

/**
 * Entity page generation — the TypeScript port of
 * `app/core/page_generator.py`.
 *
 * A page is a markdown document synthesized from the **compiled graph**, never
 * from the raw source documents: the model is shown the entity's neighbours,
 * which is what makes the page domain-aware. Generation is cached in
 * `entity_pages` under a `graph_version` hash of the entity's own state, so any
 * change to the entity, its edges, or its contributing documents invalidates the
 * cache on the next read.
 *
 * ## Python byte-formatting is part of the hash, so it is reproduced exactly
 *
 * The oracle hashes `str(float(confidence))` and
 * `json.dumps(properties, sort_keys=True)`. Both are Python *representations*,
 * and neither matches JavaScript's default stringification:
 *
 * | value | Python | JavaScript |
 * |---|---|---|
 * | `1e16` | `1e+16` | `10000000000000000` |
 * | `1e-5` | `1e-05` | `0.00001` |
 * | `1.0` (from jsonb) | `1.0` | `1` |
 *
 * Two servers sharing one `entity_pages` table is the reason this matters: if
 * this port hashed differently, each server would invalidate the other's cache
 * and every read would cost another LLM call. {@link pythonFloatRepr} and
 * {@link pythonJsonDumps} therefore reproduce CPython's `repr`/`json` output
 * rather than approximating it, and both are pinned against values read from the
 * oracle's own interpreter.
 *
 * `properties` is read as `properties::text` (the jsonb text form) precisely
 * because JavaScript cannot tell `1.0` from `1` after `JSON.parse`. The text
 * carries the difference, and {@link pythonJsonDumps} re-emits it the way
 * `json.dumps` would.
 *
 * ## The prompts are contracts too
 *
 * {@link buildPagePrompt} is exported and pinned by tests against the prompt the
 * oracle actually sent (captured by replacing `complete` with a recorder). The
 * prompt is the only input to a non-deterministic step, so it is the one part of
 * "what the page says" this port can hold constant.
 */

// ---------------------------------------------------------------------------
// CPython number and JSON formatting
// ---------------------------------------------------------------------------

/** Raised when a jsonb text form cannot be re-emitted faithfully. */
export class PythonFormatError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PythonFormatError";
  }
}

/**
 * Python's `repr()` for a float, i.e. `str(float(value))`.
 *
 * CPython's short-repr algorithm emits the shortest digit string that
 * round-trips, then chooses fixed or exponential notation by the decimal point
 * position `decpt` (the value is `0.<digits> x 10**decpt`): exponential when
 * `decpt <= -4` or `decpt > 16`, fixed otherwise, and a trailing `.0` when the
 * fixed form has no fractional digits.
 *
 * Every threshold below is measured, not guessed:
 *
 * | value | Python |
 * |---|---|
 * | `0.0001` | `0.0001` (fixed, decpt = -3) |
 * | `1e-05` | `1e-05` (exponential, decpt = -4) |
 * | `1234567890123456.0` | `1234567890123456.0` (fixed, decpt = 16) |
 * | `1e+16` | `1e+16` (exponential, decpt = 17) |
 * | `2.0` | `2.0` |
 * | `-0.0` | `-0.0` |
 *
 * `Number.prototype.toExponential()` with no argument produces the same shortest
 * digit string, which is what makes this a formatting problem rather than an
 * arithmetic one.
 */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "inf";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-inf";
  }
  if (value === 0) {
    return Object.is(value, -0) ? "-0.0" : "0.0";
  }

  const sign = value < 0 ? "-" : "";
  const exponential = Math.abs(value).toExponential();
  const separator = exponential.indexOf("e");
  const mantissaText = exponential.slice(0, separator);
  const exponent = Number.parseInt(exponential.slice(separator + 1), 10);
  const digits = mantissaText.replace(".", "");

  // `value == 0.<digits> * 10**decimalPoint`.
  const decimalPoint = exponent + 1;

  if (decimalPoint <= -4 || decimalPoint > 16) {
    const head = digits.slice(0, 1);
    const tail = digits.slice(1);
    const mantissa = tail === "" ? head : `${head}.${tail}`;
    const power = decimalPoint - 1;
    const powerText = `${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
    return `${sign}${mantissa}e${powerText}`;
  }

  if (decimalPoint <= 0) {
    return `${sign}0.${"0".repeat(-decimalPoint)}${digits}`;
  }

  if (digits.length <= decimalPoint) {
    return `${sign}${digits}${"0".repeat(decimalPoint - digits.length)}.0`;
  }

  return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
}

/**
 * Python's `f"{value:.2f}"`, rounded on the **exact** binary value.
 *
 * Both JavaScript alternatives are wrong, in different places, measured against
 * CPython:
 *
 * | value | Python | `toFixed(2)` | `Intl` halfEven |
 * |---|---|---|---|
 * | `0.005` | `0.01` | `0.01` | `0.00` |
 * | `0.015` | `0.01` | `0.01` | `0.02` |
 * | `0.125` | `0.12` | `0.13` | `0.12` |
 * | `2.675` | `2.67` | `2.67` | `2.68` |
 * | `1.005` | `1.00` | `1.00` | `1.00` |
 *
 * Python rounds the double's exact binary expansion, half-to-even: `0.005` is
 * really `0.005000000000000000104…` so it rounds up, while `0.125` is an exact
 * tie and rounds to the even digit. `Intl` rounds the shortest *decimal* repr
 * instead, which turns both of those the wrong way, and `toFixed` breaks ties
 * away from zero. Neither is a fixable rounding mode; the only faithful
 * implementation is integer arithmetic on the IEEE-754 mantissa, which is what
 * this does.
 *
 * Used for the confidence values interpolated into the generation prompt.
 */
export function formatFixed2(value: number): string {
  if (!Number.isFinite(value)) {
    // Python prints `inf` / `-inf` / `nan` for these, not `Infinity`.
    return pythonFloatRepr(value);
  }

  const negative = value < 0 || Object.is(value, -0);

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & ((1n << 52n) - 1n);

  // Subnormals carry no implicit leading 1 and a fixed exponent of -1074.
  const mantissa = exponentBits === 0 ? fractionBits : fractionBits | (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;

  // `scaled` is the exact value of `|value| * 100`, as a rational
  // `mantissa * 100 * 2**exponent`.
  const numerator = mantissa * 100n;
  let rounded: bigint;
  if (exponent >= 0) {
    rounded = numerator << BigInt(exponent);
  } else {
    const shift = BigInt(-exponent);
    const quotient = numerator >> shift;
    const remainder = numerator & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    if (remainder > half) {
      rounded = quotient + 1n;
    } else if (remainder < half) {
      rounded = quotient;
    } else {
      rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
    }
  }

  const digits = rounded.toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * A JSON number that remembers how it was written.
 *
 * `1` and `1.0` are different Python values (`int` and `float`) whose
 * `json.dumps` output differs, but both become the number `1` in JavaScript.
 * The jsonb text form distinguishes them, so the reviver below keeps the source
 * text instead of the value.
 */
class JsonNumberSource {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
}

/**
 * Escapes a string the way `json.dumps` does with `ensure_ascii=True`.
 *
 * Measured: `é` -> `\u00e9`, `🙂` -> `\ud83d\ude42` (a surrogate pair, lowercase
 * hex), while `\n`, `\t`, `\r`, `\b` and `\f` keep their short escapes.
 */
function pythonJsonString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === undefined) {
      continue;
    }
    const code = value.charCodeAt(index);
    switch (char) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      default:
        break;
    }
    if (code < 0x20 || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return `${out}"`;
}

/** True when Python would treat the parsed JSON value as falsy. */
function isPythonFalsy(value: unknown): boolean {
  if (value === null || value === false) {
    return true;
  }
  if (typeof value === "number") {
    return value === 0;
  }
  if (typeof value === "string") {
    return value === "";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (value instanceof JsonNumberSource) {
    return Number(value.source) === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Python string ordering, which compares code points.
 *
 * `Array.prototype.sort` compares UTF-16 code units, so it orders an astral
 * character (a surrogate pair) *before* a BMP character above `U+FFFF`'s range
 * such as `U+FFFD`, while Python orders by code point. Entity names can contain
 * either, and the relationship list is sorted, so the difference would change
 * the hash.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  for (;;) {
    const leftStep = leftIterator.next();
    const rightStep = rightIterator.next();
    if (leftStep.done === true || rightStep.done === true) {
      if (leftStep.done === true && rightStep.done === true) {
        return 0;
      }
      return leftStep.done === true ? -1 : 1;
    }
    const leftCode = leftStep.value.codePointAt(0) ?? 0;
    const rightCode = rightStep.value.codePointAt(0) ?? 0;
    if (leftCode !== rightCode) {
      return leftCode < rightCode ? -1 : 1;
    }
  }
}

/** Emits a parsed jsonb value the way `json.dumps(sort_keys=True)` would. */
function emitPythonJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (typeof value === "string") {
    return pythonJsonString(value);
  }
  if (value instanceof JsonNumberSource) {
    // An integer keeps its digits verbatim (Python's `int` has no precision
    // limit, and a >2^53 jsonb integer would otherwise be rounded).
    if (!/[.eE]/.test(value.source)) {
      return value.source;
    }
    return pythonFloatRepr(Number(value.source));
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => emitPythonJson(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const record: Record<string, unknown> = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    const members = keys.map(
      (key) => `${pythonJsonString(key)}: ${emitPythonJson(record[key])}`,
    );
    return `{${members.join(", ")}}`;
  }
  throw new PythonFormatError(
    `Unsupported JSON value in properties: ${typeof value}`,
  );
}

/** Reviver that replaces every JSON number with its source text. */
function numberSourceReviver(
  _key: string,
  value: unknown,
  context?: { readonly source?: string },
): unknown {
  if (typeof value !== "number") {
    return value;
  }
  const source = context?.source;
  if (source === undefined) {
    // Node < 24 does not pass the source context. Failing loudly beats silently
    // hashing `1` where Python hashed `1.0`.
    throw new PythonFormatError(
      "JSON.parse did not supply number source text; Node >= 24 is required",
    );
  }
  return new JsonNumberSource(source);
}

/**
 * `json.dumps(properties or {}, sort_keys=True)`, from the jsonb text form.
 *
 * The `or {}` is Python's truthiness rule, so a jsonb `null`, `{}`, `[]`, `""`,
 * `0`, `0.0` or `false` all become `{}` — the same substitution
 * `entity_row.get("properties") or {}` makes.
 *
 * A **truthy** non-object is emitted as itself rather than rejected: measured on
 * the oracle, `properties` of jsonb `5` hashes `5` and `"x"` hashes `"x"`. The
 * column is `jsonb` with an object-shaped default, so a scalar means hand-written
 * data — and the outcome that matters is that both servers agree, not that the
 * input was sane.
 */
export function pythonJsonDumps(jsonbText: string | null): string {
  if (jsonbText === null) {
    return "{}";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonbText, numberSourceReviver);
  } catch (error) {
    if (error instanceof PythonFormatError) {
      throw error;
    }
    throw new PythonFormatError(
      `properties is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return isPythonFalsy(parsed) ? "{}" : emitPythonJson(parsed);
}

// ---------------------------------------------------------------------------
// Graph version
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the page generator reads it. */
export type PageEntityRow = {
  id: string;
  stack_id: string;
  name: string;
  type: string;
  description: string | null;
  /** `properties` in its jsonb text form; `null` for SQL NULL. */
  properties_text: string | null;
  confidence: number;
  verified: boolean;
  last_seen_at: string | null;
};

/** One relationship with the other endpoint's name resolved. */
export type PageRelationshipRow = {
  type: string;
  confidence: number;
  description: string | null;
  other_name: string;
  other_type: string;
  direction: "outgoing" | "incoming";
};

/** One contributing document. */
export type PageDocumentRow = {
  id: string;
  filename: string;
  ingested_at: string;
};

/** Everything needed to generate one entity's page. */
export interface EntityPageContext {
  readonly entity: PageEntityRow;
  readonly outgoing: readonly PageRelationshipRow[];
  readonly incoming: readonly PageRelationshipRow[];
  readonly documents: readonly PageDocumentRow[];
}

/**
 * `compute_graph_version` — the cache key.
 *
 * A stable hash of the entity's compiled state: its name, description,
 * confidence, properties, every relationship (`type|other_name|confidence`,
 * sorted), and every contributing document id (sorted). Any change to any of
 * them changes the hash, which is exactly what invalidates the cache.
 */
export function computeGraphVersion(
  entity: PageEntityRow,
  relationships: readonly PageRelationshipRow[],
  contributingDocumentIds: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(entity.name, "utf8");
  hash.update(entity.description ?? "", "utf8");
  hash.update(pythonFloatRepr(Number(entity.confidence)), "utf8");
  hash.update(pythonJsonDumps(entity.properties_text), "utf8");

  const relationReps = relationships
    .map(
      (relationship) =>
        `${relationship.type}|${relationship.other_name}|${pythonFloatRepr(Number(relationship.confidence))}`,
    )
    .sort(compareCodePoints);
  for (const rep of relationReps) {
    hash.update(rep, "utf8");
  }

  for (const documentId of [...contributingDocumentIds].sort(compareCodePoints)) {
    hash.update(documentId, "utf8");
  }

  return hash.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Response budget for one page. `complete(prompt, max_tokens=2048)`. */
export const PAGE_MAX_TOKENS = 2048;

/**
 * The generation prompt, verbatim.
 *
 * Captured from the oracle by replacing `page_generator.complete` with a
 * recorder, so this text — including the awkward `{type}s` pluralisation the
 * Python f-string produces (`USESs`, `HASs`) and the double space in
 * `(SYSTEM, confidence …)` — is measured rather than transcribed by eye.
 *
 * The two placeholder branches are part of the contract as well:
 * `(No relationships recorded)` and `(No contributing documents)` are what the
 * model sees when the graph has nothing to offer.
 */
export function buildPagePrompt(context: EntityPageContext): string {
  const { entity, outgoing, incoming, documents } = context;

  const relationshipParts: string[] = [];
  for (const relationship of outgoing) {
    relationshipParts.push(
      `  - This entity ${relationship.type}s ${relationship.other_name} ` +
        `(${relationship.other_type}, confidence ${formatFixed2(Number(relationship.confidence))})`,
    );
  }
  for (const relationship of incoming) {
    relationshipParts.push(
      `  - ${relationship.other_name} (${relationship.other_type}) ${relationship.type}s this entity ` +
        `(confidence ${formatFixed2(Number(relationship.confidence))})`,
    );
  }
  const relationshipText =
    relationshipParts.length === 0
      ? "  (No relationships recorded)"
      : relationshipParts.join("\n");

  const documentText =
    documents.length === 0
      ? "  (No contributing documents)"
      : documents
          .map((document) => `  - ${document.filename} (ingested ${document.ingested_at.slice(0, 10)})`)
          .join("\n");

  return `You are writing a wiki-style markdown page for one entity in a compiled
knowledge graph. Use ONLY the information given. Do not invent facts.
Do not speculate beyond what the graph supports.

ENTITY:
  Name: ${entity.name}
  Type: ${entity.type}
  Confidence: ${formatFixed2(Number(entity.confidence))}
  Existing description: ${entity.description ?? "(none)"}

RELATIONSHIPS:
${relationshipText}

CONTRIBUTING SOURCE DOCUMENTS:
${documentText}

Write a markdown page following this structure:

# ${entity.name}

A 2-4 sentence summary of what this entity is and its role in the domain.
Reference its key relationships naturally. Do not list relationships verbatim;
weave them into prose.

## Relationships

A bulleted list grouping outgoing and incoming relationships, written in
plain English (e.g., "Triggers an On-Call response when declared", not
"triggers --> On-Call"). Group by direction. Skip this section entirely
if no relationships exist.

## Sources

A bulleted list of contributing documents with their filenames and
ingestion dates. Skip this section entirely if no documents contributed.

Return ONLY the markdown. No preamble, no explanation, no code fences.`;
}

// ---------------------------------------------------------------------------
// Graph reads
// ---------------------------------------------------------------------------

/**
 * `gather_entity_context` — everything needed to generate one entity's page.
 *
 * Four reads, in the Python order: the entity, its outgoing edges, its incoming
 * edges, and its contributing documents. Both edge reads order by
 * `confidence desc` with no tie-break, exactly as the oracle does — the order is
 * visible in the prompt, so a tie-break added here would be a prompt change.
 *
 * Returns `null` where Python returns `{}`, so "no such entity" is a distinct
 * type rather than an empty object every caller has to test.
 */
export async function gatherEntityContext(
  tx: Database,
  entityId: string,
): Promise<EntityPageContext | null> {
  const entityRows = await tx.execute<PageEntityRow>(sql`
    select id, stack_id, name, type, description,
           properties::text as properties_text,
           confidence, verified, last_seen_at
    from ontology_entities
    where id = ${entityId}
  `);
  const entity = entityRows[0];
  if (entity === undefined) {
    return null;
  }

  const outgoing = await tx.execute<PageRelationshipRow>(sql`
    select r.type, r.confidence, r.description,
           e.name as other_name, e.type as other_type,
           'outgoing' as direction
    from ontology_relationships r
    join ontology_entities e on e.id = r.to_entity_id
    where r.from_entity_id = ${entityId}
    order by r.confidence desc
  `);

  const incoming = await tx.execute<PageRelationshipRow>(sql`
    select r.type, r.confidence, r.description,
           e.name as other_name, e.type as other_type,
           'incoming' as direction
    from ontology_relationships r
    join ontology_entities e on e.id = r.from_entity_id
    where r.to_entity_id = ${entityId}
    order by r.confidence desc
  `);

  const documents = await tx.execute<PageDocumentRow>(sql`
    select sd.id, sd.filename, sd.ingested_at
    from entity_source_documents esd
    join stack_documents sd on sd.id = esd.document_id
    where esd.entity_id = ${entityId}
    order by sd.ingested_at
  `);

  return { entity, outgoing, incoming, documents };
}

/**
 * `generate_markdown` — one LLM call, constrained to grounded synthesis.
 *
 * `max_tokens` is 2048, not the module default: a page is much longer than a
 * description and truncation would cut the trailing sections off.
 */
export async function generateMarkdown(context: EntityPageContext): Promise<string> {
  return complete(buildPagePrompt(context), PAGE_MAX_TOKENS);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** What `GET /aks/v1/pages/{entity_name}` answers with. */
export interface EntityPage {
  readonly entity_name: string;
  readonly markdown: string;
  readonly generated_at: string;
  readonly source_entity_id: string;
  readonly graph_version: string;
  readonly source_type: string;
  readonly cached: boolean;
}

/** A cached `entity_pages` row as the read path selects it. */
type CachedPageRow = {
  markdown: string;
  graph_version: string;
  generated_at: string;
  source_type: string;
};

/**
 * `get_or_generate_page` — the public entry point.
 *
 * Gather, hash, look in the cache, and only generate on a miss or a version
 * change. The write is an upsert on `entity_id`, so a regenerated page replaces
 * the old row rather than accumulating history. `stack_id` and `source_type` are
 * not in the `do update` list because the Python statement does not touch them
 * either — an entity never moves between Stacks, and `source_type` is always
 * `compiled`.
 *
 * Returns `null` where Python returns `{}` (the entity vanished between the
 * lookup and the read), which the route answers with a 500.
 */
export async function getOrGeneratePage(
  tx: Database,
  entityId: string,
): Promise<EntityPage | null> {
  const context = await gatherEntityContext(tx, entityId);
  if (context === null) {
    return null;
  }

  const { entity } = context;
  const relationships = [...context.outgoing, ...context.incoming];
  const currentVersion = computeGraphVersion(
    entity,
    relationships,
    context.documents.map((document) => document.id),
  );

  const cachedRows = await tx.execute<CachedPageRow>(sql`
    select markdown, graph_version, generated_at, source_type
    from entity_pages
    where entity_id = ${entityId}
  `);
  const cached = cachedRows[0];

  if (cached !== undefined && cached.graph_version === currentVersion) {
    return {
      entity_name: entity.name,
      markdown: cached.markdown,
      generated_at: cached.generated_at,
      source_entity_id: entityId,
      graph_version: currentVersion,
      source_type: cached.source_type,
      cached: true,
    };
  }

  const markdown = await generateMarkdown(context);
  const generatedAt = pydanticUtcNow();

  await tx.execute(sql`
    insert into entity_pages (
      entity_id, stack_id, entity_name, markdown,
      graph_version, source_type, generated_at,
      generated_by_model
    )
    values (
      ${entityId}, ${entity.stack_id}, ${entity.name}, ${markdown},
      ${currentVersion}, ${"compiled"}, ${generatedAt},
      ${config.EXTRACTION_MODEL}
    )
    on conflict (entity_id) do update set
      markdown = excluded.markdown,
      graph_version = excluded.graph_version,
      generated_at = excluded.generated_at,
      generated_by_model = excluded.generated_by_model,
      entity_name = excluded.entity_name
  `);

  return {
    entity_name: entity.name,
    markdown,
    generated_at: generatedAt,
    source_entity_id: entityId,
    graph_version: currentVersion,
    source_type: "compiled",
    cached: false,
  };
}

/**
 * The current instant as Pydantic serializes a `timestamptz`.
 *
 * Observed oracle output: `2026-10-22T05:12:39.060090Z` — six fractional digits
 * and a `Z`. A JavaScript `Date` holds milliseconds, so the last three digits are
 * genuinely zero; `db.ts` follows the same rule for stored timestamps.
 */
export function pydanticUtcNow(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, -1)}000Z`;
}
