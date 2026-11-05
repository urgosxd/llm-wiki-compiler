/**
 * @file packages/llmwiki-kg/ts/src/core/graph-parse.ts
 * @description Reading a model's triplet output, tolerantly but deterministically.
 *
 * Extraction is unparseable often enough that a strict parser would discard real
 * triples. The oracle therefore recovers what it can: a loose JSON parse, then a
 * shape check per entity and relation. This module reproduces that recovery
 * order, because "which triples survive" is observable in the database.
 *
 * One deliberate departure from the oracle is documented on
 * {@link normalizeEntityType}: type labels are trimmed of surrounding whitespace
 * before they are normalised. Everything else about the order is unchanged.
 */

/**
 * Normalises a relation label the way llama_index's `validate` does, plus a trim.
 *
 * `type.trim().replaceAll(" ", "_").toUpperCase()` — every internal space becomes
 * one underscore and nothing is collapsed, so `"used for"` becomes `USED_FOR`.
 * Consolidation lowercases it again when writing, which is why the stored value
 * is `used_for`.
 *
 * The trim is the one place this module knowingly departs from the oracle: `validate`
 * does not trim, so `" used_for"` becomes `_USED_FOR`, a label no declaration can
 * match, and the triplet is then rejected for a verb the ontology does declare.
 * Padding around a label carries no meaning in the source document, so dropping it
 * can only recover the triplet the model meant.
 */
function normalizeRelationType(raw: string): string {
  return raw.trim().replaceAll(" ", "_").toUpperCase();
}

/**
 * Normalises an entity type the same way, per the same `validate` block.
 *
 * Includes the same deliberate trim: `" company"`, `"company "`, and
 * `" company "` all resolve to `COMPANY`, and {@link normalizeType} in
 * `ontology.ts` applies the identical rule so a padded DECLARATION matches a
 * padded emission instead of reading as an undeclared type on either side.
 */
function normalizeEntityType(raw: string): string {
  return raw.trim().replaceAll(" ", "_").toUpperCase();
}

export interface Triplet {
  readonly subjectName: string;
  readonly subjectType: string;
  readonly relationType: string;
  readonly objectName: string;
  readonly objectType: string;
}

/**
 * One entity the model reported outside any triplet.
 *
 * Before `entities` existed in the tool schema, every node in the graph was a
 * triplet endpoint, so this shape had no reason to exist. It does now: a
 * `DECISION`, a `REQUIREMENT`, or a `TEAM` usually appears in a document without
 * participating in a stated relationship, and without this those documents
 * contribute nothing to the graph.
 */
export interface StandaloneEntity {
  readonly name: string;
  readonly type: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  // `{}` is `object` at the type level but a valid record at runtime; the
  // narrowing has to say so explicitly because `exactOptionalPropertyTypes` and
  // `noUncheckedIndexedAccess` make an implicit index signature unsound here.
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads `{type, name}` out of one endpoint object, or `undefined` when the shape
 * does not match what the schema requires.
 */
function readEntity(value: unknown): { name: string; type: string } | undefined {
  const record = asRecord(value);
  const name = asString(record?.["name"]);
  const type = asString(record?.["type"]);
  if (name === undefined || type === undefined) {
    return undefined;
  }
  return { name, type };
}

/**
 * Parses the model's tool-call arguments into validated triplets.
 *
 * Reproduces llama_index's `validate` (a `field_validator` on `triplets`,
 * `mode="before"`) followed by `_prune_invalid_triplets`:
 *
 * 1. Every endpoint's `type` is rewritten as `trim().replaceAll(" ", "_").toUpperCase()`
 *    (the trim is this module's documented departure from the oracle). A
 *    triplet whose endpoint is missing `type` or `name` fails Pydantic
 *    validation and is **dropped**, not fatal — this is why a model that emits
 *    one malformed triplet still contributes the rest.
 * 2. Self-references (`subject.name.lower() == object.name.lower()`) are
 *    dropped.
 * 3. Validity against `kg_validation_schema` is **not** checked, because
 *    `strict=False`. Confirmed by measurement: the oracle stores a
 *    `worked_on` edge between two `CONCEPT` nodes, which the default schema does
 *    not permit.
 *
 * Two robustness measures that the Python path gets from Pydantic and this one
 * needs explicitly: a JSON string is parsed (some providers send the arguments
 * pre-stringified), and text before/after the JSON object is tolerated, because
 * a chatty model sometimes wraps the payload in a sentence.
 *
 * @returns validated triplets; an empty array when the payload cannot be parsed
 *   at all. The caller logs nothing and treats it as "no triplets for this
 *   chunk", which is what `_aextract`'s `except (ValueError, TypeError,
 *   AttributeError)` does.
 */
export function parseTriplets(argumentsJson: string): Triplet[] {
  const payload = parseJsonLoosely(argumentsJson);
  const triplets = asRecord(payload)?.["triplets"];
  if (!Array.isArray(triplets)) {
    return [];
  }

  const out: Triplet[] = [];
  for (const raw of triplets) {
    const triplet = asRecord(raw);
    const subject = readEntity(triplet?.["subject"]);
    const object = readEntity(triplet?.["object"]);
    const relationType = asString(asRecord(triplet?.["relation"])?.["type"]);
    if (subject === undefined || object === undefined || relationType === undefined) {
      continue;
    }

    const subjectName = subject.name.trim();
    const objectName = object.name.trim();
    if (subjectName === "" || objectName === "") {
      continue;
    }

    // `_prune_invalid_triplets`: self-references are removed.
    if (subjectName.toLowerCase() === objectName.toLowerCase()) {
      continue;
    }

    out.push({
      subjectName,
      subjectType: normalizeEntityType(subject.type),
      relationType: normalizeRelationType(relationType),
      objectName,
      objectType: normalizeEntityType(object.type),
    });
  }
  return out;
}

/**
 * Parses the `entities` array from a tool payload.
 *
 * Kept separate from {@link parseTriplets} so the triplet contract — which is the
 * oracle's and is pinned by parity tests — stays untouched. An entity that is
 * missing `type` or `name`, or whose name is blank, is dropped rather than fatal,
 * for the same reason a malformed triplet is: one bad entry must not discard the
 * rest of a chunk's output.
 *
 * Names are trimmed but NOT lowercased here: consolidation owns case-insensitive
 * identity, and doing it in two places would let them disagree.
 *
 * @param argumentsJson - The model's tool-call argument string.
 * @returns The standalone entities; an empty array when the payload has none.
 */
export function parseStandaloneEntities(argumentsJson: string): StandaloneEntity[] {
  const payload = parseJsonLoosely(argumentsJson);
  const entities = asRecord(payload)?.["entities"];
  if (!Array.isArray(entities)) {
    return [];
  }

  const out: StandaloneEntity[] = [];
  for (const raw of entities) {
    const entity = readEntity(raw);
    if (entity === undefined) continue;
    const name = entity.name.trim();
    if (name === "") continue;
    out.push({ name, type: normalizeEntityType(entity.type) });
  }
  return out;
}

/**
 * Whether a response arrived intact but carries no usable envelope.
 *
 * The third outcome of a chunk, and the one that used to be invisible: a
 * response with no `triplets` array and no `entities` array parses to zero of
 * both, exactly like a chunk whose prose contained nothing to extract. Counting
 * it is what stops "0 triplets" from being ambiguous.
 *
 * A blank response is NOT mangled: the provider said nothing, which the caller
 * already reports as a failure. An array that is present but empty is NOT
 * mangled either — that is the model's legitimate "nothing here" answer, and so
 * is an array whose individual entries are malformed, because those are dropped
 * one by one per oracle parity while the envelope itself was readable.
 *
 * @param argumentsJson - The model's tool-call argument string.
 * @returns True when the text is non-blank and neither envelope array exists.
 */
export function isShapeMangled(argumentsJson: string): boolean {
  if (argumentsJson.trim() === "") {
    return false;
  }
  const payload = asRecord(parseJsonLoosely(argumentsJson));
  return !Array.isArray(payload?.["triplets"]) && !Array.isArray(payload?.["entities"]);
}

/**
 * Best-effort JSON parse of a tool-call argument string.
 *
 * THE single tolerant parse shared by triplet parsing and schema validation.
 * {@link parseTriplets}, {@link parseStandaloneEntities}, {@link isShapeMangled}
 * and `countSchemaViolations` in `llm/schema-validation.ts` all read a provider's
 * answer through this function, so they cannot disagree about what the model
 * actually said. That agreement is load-bearing rather than tidy: the violation
 * counter exists to explain a rejection, and a counter whose tolerance drifted
 * from the parser's would report `0` for a payload the parser accepted — a
 * diagnostic that lies low instead of one that lies loud.
 *
 * Handles the three shapes providers actually send: the bare object, an object
 * wrapped in prose, and an object wrapped in a JSON string literal. Returns
 * `undefined` rather than throwing, so one unparseable chunk does not fail the
 * document.
 *
 * @param raw - The model's tool-call argument string, untrusted.
 * @returns The parsed value, or `undefined` when nothing parses.
 */
export function parseJsonLoosely(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }

  const attempts: string[] = [trimmed];

  // Trim prose around the outermost braces.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first > 0 || (last !== -1 && last < trimmed.length - 1)) {
    if (first !== -1 && last > first) {
      attempts.push(trimmed.slice(first, last + 1));
    }
  }

  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      // A doubly-encoded payload: the JSON value is itself a JSON string.
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed) as unknown;
        } catch {
          continue;
        }
      }
      return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Runs graph extraction across `chunks` and merges the per-chunk results.
 *
 * Mirrors `extract_graph_from_chunks`:
 *
 * - One LLM call per chunk, sequentially. Python uses `num_workers=4` to run
 *   them concurrently; sequential is chosen here because the observable result
 *   is identical (the merge is order-insensitive for distinct keys, and the
 *   confidence tie-break keeps the first of equal values) while a request
 *   burst against a metered gateway is not. Cost per document is identical:
 *   one call per chunk.
 * - Entities are deduplicated by lowercased stripped name. On a repeat, a
 *   higher confidence replaces the type and description, and the chunk index is
 *   appended to `sourceChunkIndices`. Since every extraction carries the same
 *   {@link EXTRACTED_CONFIDENCE}, the replacement branch never fires in
 *   practice, and all contributing chunk indices accumulate.
 * - Relationships are deduplicated on `(from, type, to)`, all lowercased, with
 *   chunk indices concatenated.
 *
 * An empty chunk list short-circuits without any LLM call — the case the oracle
 * answers with every count at zero.
 */
