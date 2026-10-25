/**
 * @file packages/llmwiki-kg/ts/src/core/graph-prompt.ts
 * @description The extraction prompt and its tool schema.
 *
 * Both are copied from the oracle rather than rewritten, because the model's
 * output shape is a function of the prompt text and the tool definition. Changing
 * either changes what gets extracted, which `promptVersion`-style markers cannot
 * repair after the fact.
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
 * `DEFAULT_SCHEMA_PATH_EXTRACT_PROMPT`, verbatim — including the typo
 * `"extracted paths.s"`.
 *
 * The typo is contractual. It is in the prompt the oracle sends, and changing it
 * changes the model's input; a faithful port keeps it and says so.
 *
 * `{max_triplets_per_chunk}` and `{text}` are filled by
 * {@link buildExtractionPrompt}.
 */
const EXTRACTION_PROMPT =
  "Give the following text, extract the knowledge graph according to the provided schema. " +
  "Try to limit to the output {max_triplets_per_chunk} extracted paths.s\n" +
  "-------\n" +
  "{text}\n" +
  "-------\n";

/** `max_triplets_per_chunk=20` from `extract_graph_from_chunks`. */
const MAX_TRIPLETS_PER_CHUNK = 20;

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
): string {
  const nodeContent = `chunk_index: ${String(chunkIndex)}\nstack_name: ${stackName}\n\n${chunkContent}`;
  return EXTRACTION_PROMPT.replace("{max_triplets_per_chunk}", String(MAX_TRIPLETS_PER_CHUNK)).replace(
    "{text}",
    nodeContent,
  );
}


/** One validated triplet, flattened to names and types. */
