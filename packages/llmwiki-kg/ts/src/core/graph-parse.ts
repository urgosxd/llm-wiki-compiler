/**
 * @file packages/llmwiki-kg/ts/src/core/graph-parse.ts
 * @description Reading a model's triplet output, tolerantly but deterministically.
 *
 * Extraction is unparseable often enough that a strict parser would discard real
 * triples. The oracle therefore recovers what it can: a loose JSON parse, then a
 * shape check per entity and relation. This module reproduces that recovery
 * order, because "which triples survive" is observable in the database.
 */

/**
 * Normalises a relation label the way llama_index's `validate` does.
 *
 * `type.replace(" ", "_").upper()` — only the first space style is replaced, and
 * every occurrence, so `"used for"` becomes `USED_FOR`. Consolidation lowercases
 * it again when writing, which is why the stored value is `used_for`.
 */
function normalizeRelationType(raw: string): string {
  return raw.replaceAll(" ", "_").toUpperCase();
}

/** Normalises an entity type the same way, per the same `validate` block. */
function normalizeEntityType(raw: string): string {
  return raw.replaceAll(" ", "_").toUpperCase();
}

export interface Triplet {
  readonly subjectName: string;
  readonly subjectType: string;
  readonly relationType: string;
  readonly objectName: string;
  readonly objectType: string;
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
 * 1. Every endpoint's `type` is rewritten as `replace(" ", "_").upper()`. A
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
 * Best-effort JSON parse of a tool-call argument string.
 *
 * Handles the three shapes providers actually send: the bare object, an object
 * wrapped in prose, and an object wrapped in a JSON string literal. Returns
 * `undefined` rather than throwing, so one unparseable chunk does not fail the
 * document.
 */
function parseJsonLoosely(raw: string): unknown {
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
