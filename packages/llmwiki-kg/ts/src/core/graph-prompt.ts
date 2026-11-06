/**
 * @file packages/llmwiki-kg/ts/src/core/graph-prompt.ts
 * @description The extraction prompt and its tool schema.
 *
 * Both started as copies of the oracle rather than rewrites, because the model's
 * output shape is a function of the prompt text and the tool definition. Changing
 * either changes what gets extracted, which `promptVersion`-style markers cannot
 * repair after the fact, so each departure from the oracle is registered in
 * `odd/findings/aks-spec-conformance.md` rather than made silently.
 */

import type { ToolDefinition } from "./llm_clients.js";
import type { Ontology } from "./ontology.js";

// ===========================================================================
// STEP 5: GRAPH EXTRACTION
// ===========================================================================

/**
 * llama_index's `DEFAULT_ENTITIES`, spelled exactly as the generated tool
 * schema spells them.
 *
 * The list is not used for validation (`strict=False` accepts any type), but it
 * **is** in the schema description the model reads, and it is what the model
 * tends to emit. Changing it changes extracted types.
 */
const DEFAULT_ENTITIES = [
  "PRODUCT", "MARKET", "TECHNOLOGY", "EVENT", "CONCEPT",
  "ORGANIZATION", "PERSON", "LOCATION", "TIME", "MISCELLANEOUS",
] as const;

/** llama_index's `DEFAULT_RELATIONS`, same reasoning as {@link DEFAULT_ENTITIES}. */
const DEFAULT_RELATIONS = [
  "USED_BY", "USED_FOR", "LOCATED_IN", "PART_OF", "WORKED_ON",
  "HAS", "IS_A", "BORN_IN", "DIED_IN", "HAS_ALIAS",
] as const;

/**
 * Renders a `Literal[...]` list the way Python's `str()` renders one.
 *
 * The generated schema descriptions embed `str(possible_entities)`, which
 * produces `typing.Literal['PRODUCT', 'MARKET', ...]`. Reproducing that
 * verbatim keeps the model's input byte-identical to the oracle's, which is the
 * only way the same model returns the same types for the same text.
 */
function pythonLiteral(values: readonly string[]): string {
  return `typing.Literal[${values.map((value) => `'${value}'`).join(", ")}]`;
}

/**
 * Renders the tool schema, optionally restricting the advertised type lists.
 *
 * The type lists live only in the `description` strings the model reads, so a
 * caller-declared ontology changes them by substitution and nothing else. That is
 * deliberate: the structure, the `$ref` graph, and the required fields stay
 * byte-identical to the oracle's, because `graph-parse.ts` depends on that shape
 * and the model's output shape is a function of the description it was shown.
 *
 * Called with no ontology it returns the exported {@link KG_TOOL} object itself,
 * so the default is not merely equal to the oracle's schema but is the same
 * value.
 */
/**
 * A tool definition after an ontology may have narrowed its type lists.
 *
 * `typeof KG_TOOL` was the return type here, and it is a lie once an ontology is
 * supplied: the narrowed `type` fields carry an `enum` the constant does not have.
 * Callers and tests that read `.enum` were rejected by the compiler even though
 * the value was there at runtime, which is how a type annotation hides a feature.
 *
 * Modelled as `KG_TOOL` with the narrowed fields widened, rather than as a fully
 * generic schema type, so the object literal below stays checked against the real
 * shape.
 */
export type ToolSchema = Omit<typeof KG_TOOL, "parameters"> & {
  readonly parameters: Omit<(typeof KG_TOOL)["parameters"], "$defs"> & {
    readonly $defs:
      & Omit<(typeof KG_TOOL)["parameters"]["$defs"], "Entity" | "Relation">
      & {
        readonly Entity: {
          readonly type: "object";
          readonly properties: { readonly type: TypeField; readonly name: { readonly type: "string" } };
          readonly required: readonly string[];
          readonly additionalProperties: false;
        };
        readonly Relation: {
          readonly type: "object";
          readonly properties: { readonly type: TypeField };
          readonly required: readonly string[];
          readonly additionalProperties: false;
        };
      };
  };
};

/** The `type` field of an entity or relation: a string, described and enumerated. */
interface TypeField {
  readonly type: "string";
  readonly description: string;
  readonly enum?: readonly string[];
}

export function buildToolSchema(ontology?: Ontology): ToolSchema {
  if (ontology === undefined) {
    return KG_TOOL;
  }
  return {
    ...KG_TOOL,
    parameters: {
      ...KG_TOOL.parameters,
      $defs: {
        ...KG_TOOL.parameters.$defs,
        Entity: {
          ...KG_TOOL.parameters.$defs.Entity,
          properties: {
            ...KG_TOOL.parameters.$defs.Entity.properties,
            type: constrainedTypeField(ontology.entityTypes, "entity"),
          },
        },
        Relation: {
          ...KG_TOOL.parameters.$defs.Relation,
          properties: {
            type: constrainedTypeField(ontology.relationshipTypes, "relation"),
          },
        },
      },
    },
  };
}

/**
 * The `type` field of an entity or relation, restricted by a real JSON Schema
 * `enum`.
 *
 * ## Why `enum` and not only the description
 *
 * This is the difference between guiding the model and cleaning up after it. The
 * oracle's schema put the allowed types in the field's *description* and left the
 * type as `string`, which llama_index does when `strict=False`:
 *
 * ```python
 * type=(possible_entities if strict else str, ...)
 * ```
 *
 * With `strict=True` — the library's own default — `possible_entities` (a
 * `Literal[...]`) becomes the field's type and Pydantic renders it as an `enum`. A
 * provider that honours the schema then cannot emit a type outside the list, and
 * an out-of-schema value is a validation failure the model has to correct rather
 * than something this package silently drops afterwards.
 *
 * The description is kept as well as the `enum`: an `enum` tells a model which
 * values are legal, but the sentence is what tells it *why*, and the wording is
 * llama_index's, so the model sees the same instruction it always did.
 *
 * @param allowed - The declared type names, already normalised.
 * @param kind - Which list this is, for the description sentence.
 * @returns The field definition, carrying both `description` and `enum`.
 */
function constrainedTypeField(allowed: readonly string[], kind: "entity" | "relation"): TypeField & {
  readonly enum: readonly string[];
} {
  const noun = kind === "entity" ? "entities" : "relations";
  return {
    type: "string",
    description:
      `${kind === "entity" ? "Entity" : "Relation"} in a knowledge graph. Only extract ${noun} ` +
      "with types that are listed as valid: " +
      pythonLiteral(allowed),
    enum: allowed,
  };
}

/**
 * The `type` field of an entity or relation when the catalog ORIENTS instead of
 * filtering (S7).
 *
 * ## Why the `enum` has to go, and why the description stays
 *
 * `constrainedTypeField` makes an out-of-catalog value unemittable for a provider
 * that honours the schema: `enum` is a validation rule, not a hint. That is the
 * right contract for a caller whose graph must stay inside the declaration, and the
 * wrong one for open extraction, where a name whose type nobody declared is still
 * knowledge the source supports (S1, S3).
 *
 * No flag repairs that from outside: `strict=False` is a llama_index argument this
 * port does not send, so relying on it would mean relying on a library that is
 * gone. Openness therefore lives here, in the schema the provider is given, and in
 * the instruction text beside it — never behind a boolean.
 *
 * The familiar names stay in the description, deliberately. Orientation is not
 * silence: a model told which types the Stack prefers proposes `Policy` where it
 * would otherwise invent `Rulebook`, and a model told they are orientation still
 * reports the fact when none of them fits.
 *
 * @param familiar - The declared (or default) type names, offered as orientation.
 * @param kind - Which list this is, for the description sentence.
 * @returns The field definition: a free string, carrying no `enum`.
 */
function orientationTypeField(familiar: readonly string[], kind: "entity" | "relation"): TypeField {
  const noun = kind === "entity" ? "entities" : "relations";
  const proposal = kind === "entity" ? "type" : "predicate";
  return {
    type: "string",
    description:
      `${kind === "entity" ? "Entity" : "Relation"} in a knowledge graph. The ${noun} below are ` +
      `ORIENTATION, not an admission filter: report every ${kind} the text supports, and when none ` +
      `of them fits, propose your own ${proposal} in your own words. Familiar ${noun}: ` +
      pythonLiteral(familiar),
  };
}

/**
 * The tool schema for OPEN extraction: the same shape, without the `enum`.
 *
 * Every structural property of {@link KG_TOOL} is preserved — both arrays, the
 * `$ref` graph, the closed objects, the required lists — because the model's output
 * shape is a function of them and both parsers depend on it. The single difference
 * is that the two `type` fields become free strings described as orientation, which
 * is exactly the difference between "the catalog decides what may exist" and "the
 * catalog helps name what exists".
 *
 * Called with no ontology it still returns an OPEN schema: the oracle's default type
 * lists are offered as familiar values rather than as the only legal ones.
 *
 * @param ontology - The Stack's declared catalog, used as orientation only.
 * @returns The open tool schema, structurally identical to the strict one.
 */
export function buildOpenToolSchema(ontology?: Ontology): ToolSchema {
  const entityTypes = ontology?.entityTypes ?? DEFAULT_ENTITIES;
  const relationTypes = ontology?.relationshipTypes ?? DEFAULT_RELATIONS;
  return {
    ...KG_TOOL,
    parameters: {
      ...KG_TOOL.parameters,
      $defs: {
        ...KG_TOOL.parameters.$defs,
        Entity: {
          ...KG_TOOL.parameters.$defs.Entity,
          properties: {
            ...KG_TOOL.parameters.$defs.Entity.properties,
            type: orientationTypeField(entityTypes, "entity"),
          },
        },
        Relation: {
          ...KG_TOOL.parameters.$defs.Relation,
          properties: { type: orientationTypeField(relationTypes, "relation") },
        },
      },
    },
  };
}

/**
 * The tool schema the extractor asks the model to fill.
 *
 * ## Provenance, and where this deliberately departs from it
 *
 * Captured from the live request `SchemaLLMPathExtractor` produces: with
 * `strict=False` and no `possible_entity_props`, `get_entity_class` yields a bare
 * `{type, name}` entity and a bare `{type}` relation, and the triplet model wraps
 * them as `subject` / `relation` / `object` under a `triplets` array.
 *
 * **This is no longer byte-identical to the oracle's schema, on purpose.**
 * `entities` is an addition the oracle does not have. The reason is structural
 * rather than cosmetic: the oracle can only ever produce an entity that is an
 * endpoint of a triplet, so a type like `DECISION` or `REQUIREMENT` — the things
 * this compiler is fed documents about, which usually exist without a
 * relationship — cannot survive extraction at all. A document that says "we
 * decided to use Postgres" yields nothing, because there is no edge to hang the
 * decision on.
 *
 * The divergence is registered in `odd/findings/aks-spec-conformance.md`.
 *
 * ## Shaped for OpenAI's strict mode
 *
 * Every object below carries `additionalProperties: false` and lists all of its
 * properties as required. That is not stylistic: OpenAI rejects a tool schema in
 * strict mode unless every object satisfies both rules, so a schema that omits
 * them cannot be sent with `strict: true` at all.
 *
 * `entities` is therefore **required** rather than optional, which is the one
 * behavioural cost of strict mode: a model can no longer omit the key, so it
 * emits `entities: []` when a chunk has none. Parsing is unchanged — an empty
 * array contributes nothing — and the payload is still the same shape for a chunk
 * with no standalone nodes.
 */
export const KG_TOOL = {
  name: "KGSchema",
  description: "Knowledge Graph Schema.",
  parameters: {
    type: "object",
    properties: {
      triplets: {
        type: "array",
        items: { $ref: "#/$defs/Triplet" },
      },
      entities: {
        type: "array",
        items: { $ref: "#/$defs/Entity" },
        description:
          "Entities that matter in this text but take part in no relationship. " +
          "Report a subject or object here only when it belongs to no triplet. " +
          "Use an empty array when every entity takes part in one.",
      },
    },
    required: ["triplets", "entities"],
    additionalProperties: false,
    $defs: {
      Entity: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Entity in a knowledge graph. Only extract entities with types that are listed as valid: " +
              pythonLiteral(DEFAULT_ENTITIES),
          },
          name: { type: "string" },
        },
        required: ["type", "name"],
        additionalProperties: false,
      },
      Relation: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Relation in a knowledge graph. Only extract relations with types that are listed as valid: " +
              pythonLiteral(DEFAULT_RELATIONS),
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
      Triplet: {
        type: "object",
        properties: {
          subject: { $ref: "#/$defs/Entity" },
          relation: { $ref: "#/$defs/Relation" },
          object: { $ref: "#/$defs/Entity" },
        },
        required: ["subject", "relation", "object"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies ToolDefinition;

/**
 * `DEFAULT_SCHEMA_PATH_EXTRACT_PROMPT`, copied from llama_index and corrected
 * here.
 *
 * The oracle sends `"Give the following text"` and
 * `"...output {max_triplets_per_chunk} extracted paths.s"`. The first is a
 * grammar slip; the second names the wrong thing — what is extracted are
 * triplets, not "paths" — and carries a stray `.s`. Copying them faithfully only
 * propagated them: this text is the model's input on every chunk, so a defect in
 * it limits every extraction, and no downstream validator can tell a short answer
 * apart from one the prompt asked for.
 *
 * **This is a deliberate departure from the oracle.** The model's input bytes now
 * differ from what the Python implementation sends, so extraction output can
 * differ with them. The departure is registered in
 * `odd/findings/aks-spec-conformance.md`.
 *
 * `{max_triplets_per_chunk}` and `{text}` are filled by
 * {@link buildExtractionPrompt}.
 */
const EXTRACTION_PROMPT =
  "Given the following text, extract the knowledge graph according to the provided schema. " +
  "Try to limit to the output {max_triplets_per_chunk} extracted triplets\n" +
  "-------\n" +
  "{text}\n" +
  "-------\n";

/**
 * The per-chunk triplet budget, `max_triplets_per_chunk=20` from
 * `extract_graph_from_chunks`.
 *
 * Named and exported rather than inlined because the number is a POLICY about how
 * much one chunk may cost, not a property of the format: an operator with a small
 * model and a dense corpus may want 10, and one paying for a long-context model
 * may want 50. Every renderer and cap below accepts an override and falls back to
 * this value, so the default render stays byte-identical to what the oracle sent.
 *
 * ## It is a request, never a truncation
 *
 * The budget reaches the model as an instruction, so an eager model can exceed
 * it. Nothing in the legacy path slices a longer answer, which is why a caller
 * that wants the budget enforced must go through {@link capTripletsPerChunk}:
 * that returns a {@link TripletTruncation} record with the drop instead of
 * discarding triplets silently (S9).
 */
export const DEFAULT_MAX_TRIPLETS_PER_CHUNK = 20;

/** How a caller overrides the per-chunk triplet budget for one render or cap. */
export interface TripletBudgetOptions {
  /** The budget to use instead of {@link DEFAULT_MAX_TRIPLETS_PER_CHUNK}. */
  readonly maxTripletsPerChunk?: number;
}

/**
 * A machine-readable record that the per-chunk triplet budget dropped something.
 *
 * The whole point of the record is the difference between a thin answer and a
 * capped one: a caller that sees eight triplets and no record cannot tell whether
 * the document was sparse or the rest were thrown away.
 */
export interface TripletTruncation {
  /** Which budget fired. Only the chunk budget exists today. */
  readonly scope: "chunk";
  /** The chunk whose answer was capped, or `null` when the caller did not say. */
  readonly chunkIndex: number | null;
  /** The limit that was reached. */
  readonly limit: number;
  /** How many triplets the answer held before the cap. */
  readonly considered: number;
  /** How many of them the cap dropped. */
  readonly dropped: number;
}

/** One chunk's triplets after the budget, plus what the budget cost. */
export interface CappedTriplets<T> {
  readonly triplets: readonly T[];
  /** `undefined` when nothing was dropped, so a caller logs only a real drop. */
  readonly truncation: TripletTruncation | undefined;
}

/**
 * Applies the per-chunk triplet budget, reporting any drop.
 *
 * Pure and generic so it can cap whatever the caller parsed: the legacy triplet,
 * an open candidate, or a record the caller built. It deliberately does not
 * decide WHICH triplets matter — it keeps the model's own order, so what survives
 * is the prefix the model itself considered most important.
 *
 * @param triplets - Everything the answer contained, in the model's order.
 * @param options - The budget, and the chunk index to record on a drop.
 * @returns The kept prefix, and a truncation record when anything was dropped.
 * @throws {RangeError} When the budget is not a non-negative integer, because a
 *   negative or fractional budget would silently mean something nobody wrote.
 */
export function capTripletsPerChunk<T>(
  triplets: readonly T[],
  options: TripletBudgetOptions & { readonly chunkIndex?: number } = {},
): CappedTriplets<T> {
  const limit = options.maxTripletsPerChunk ?? DEFAULT_MAX_TRIPLETS_PER_CHUNK;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(
      `maxTripletsPerChunk must be a non-negative integer, received ${String(limit)}`,
    );
  }
  if (triplets.length <= limit) {
    return { triplets, truncation: undefined };
  }
  return {
    triplets: triplets.slice(0, limit),
    truncation: {
      scope: "chunk",
      chunkIndex: options.chunkIndex ?? null,
      limit,
      considered: triplets.length,
      dropped: triplets.length - limit,
    },
  };
}

/**
 * Renders the extraction prompt for one chunk.
 *
 * `text` is the node's `MetadataMode.LLM` content, which is the metadata lines
 * followed by a blank line and the chunk body. Captured example:
 *
 * ```
 * chunk_index: 0
 * stack_name: demo
 *
 * AKS servers run on Kubernetes.
 * ```
 *
 * The metadata is visible to the model, so it is part of the prompt's meaning —
 * it is why the model can refer to the Stack by name.
 */
export function buildExtractionPrompt(
  chunkContent: string,
  chunkIndex: number,
  stackName: string,
  // Accepted so a caller can pass one extraction context object without
  // branching on whether an ontology is configured. The prompt text itself has
  // no ontology placeholder: the type constraint reaches the model through the
  // tool schema, so threading it here would change the oracle's bytes for no
  // gain.
  _ontology?: Ontology,
  options: TripletBudgetOptions = {},
): string {
  return renderPrompt(EXTRACTION_PROMPT, nodeContent(chunkContent, chunkIndex, stackName), "", options);
}

/**
 * `text` as the model reads it: the metadata lines, a blank line, the chunk body.
 *
 * Shared by both renderers so a chunk is presented identically whether the
 * catalog is enforced or only offered as orientation — the two contracts must
 * differ in what they permit, never in what they show.
 */
function nodeContent(chunkContent: string, chunkIndex: number, stackName: string): string {
  return `chunk_index: ${String(chunkIndex)}\nstack_name: ${stackName}\n\n${chunkContent}`;
}

/** Substitutes the three placeholders both templates may carry. */
function renderPrompt(
  template: string,
  text: string,
  catalog: string,
  options: TripletBudgetOptions,
): string {
  const limit = options.maxTripletsPerChunk ?? DEFAULT_MAX_TRIPLETS_PER_CHUNK;
  return template
    .replace("{max_triplets_per_chunk}", String(limit))
    .replace("{catalog}", catalog)
    .replace("{text}", text);
}

/**
 * The instruction text for open extraction, where the catalog orients and never admits.
 *
 * Kept beside {@link EXTRACTION_PROMPT} rather than folded into it, for the same
 * reason the open schema is a separate builder: the strict render is pinned byte for
 * byte by tests and by the oracle-parity harness, and an instruction that tells the
 * model to invent types cannot share bytes with one that forbids them.
 *
 * Three sentences carry the contract, and each is load-bearing:
 *
 * - orientation is not an admission filter, so a fact whose type or predicate nobody
 *   declared must still be reported with the model's own wording (S7, S31);
 * - an entity with no relation belongs in the `entities` array, which is how
 *   knowledge that never forms a triplet survives at all (S8);
 * - the triplet budget is named as a budget, so a capped answer reads as a known
 *   cost rather than as a thin document (S9).
 *
 * `{catalog}`, `{max_triplets_per_chunk}` and `{text}` are filled by
 * {@link buildOpenExtractionPrompt}.
 */
const OPEN_EXTRACTION_PROMPT =
  "Given the following text, extract the knowledge graph according to the provided schema. " +
  "The type lists in the schema and in the catalog below are ORIENTATION and never an admission " +
  "filter: report every entity and every relation the text supports, and when no listed type or " +
  "predicate fits, propose your own wording instead of leaving the fact out.\n" +
  "Report entities that take part in no relation in the entities array.\n" +
  "{catalog}" +
  "Try to limit to the output {max_triplets_per_chunk} extracted triplets\n" +
  "-------\n" +
  "{text}\n" +
  "-------\n";

/**
 * The declared catalog as one orientation line, or nothing when none is declared.
 *
 * Absent rather than empty: a line saying "catalog: none" would tell the model the
 * Stack prefers nothing, which is a different claim from "this Stack declared
 * nothing".
 */
function catalogOrientation(ontology: Ontology | undefined): string {
  if (ontology === undefined) {
    return "";
  }
  return (
    "Catalog (orientation only): entity types " +
    `${pythonLiteral(ontology.entityTypes)}; relation types ` +
    `${pythonLiteral(ontology.relationshipTypes)}.\n`
  );
}

/**
 * Renders the open extraction prompt for one chunk.
 *
 * Same chunk presentation as {@link buildExtractionPrompt} — the model sees the
 * `chunk_index` and `stack_name` metadata lines in both, because the Stack's name is
 * part of what the text means — with the admission rule inverted.
 *
 * @param chunkContent - The stored chunk body, exactly as `document_chunks` holds it.
 * @param chunkIndex - The chunk's position inside its document.
 * @param stackName - The Stack the document belongs to.
 * @param ontology - The declared catalog, offered as orientation when supplied.
 * @param options - The per-chunk triplet budget.
 * @returns The rendered prompt.
 */
export function buildOpenExtractionPrompt(
  chunkContent: string,
  chunkIndex: number,
  stackName: string,
  ontology?: Ontology,
  options: TripletBudgetOptions = {},
): string {
  return renderPrompt(
    OPEN_EXTRACTION_PROMPT,
    nodeContent(chunkContent, chunkIndex, stackName),
    catalogOrientation(ontology),
    options,
  );
}


/** One validated triplet, flattened to names and types. */
