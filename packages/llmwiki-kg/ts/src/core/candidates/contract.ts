/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/contract.ts
 * @description The open-extraction contract handed to the model: instruction text and response shape.
 *
 * ## The openness is a property of the SCHEMA, not of a provider flag (S7)
 *
 * The catalog is rendered into the instruction as orientation, and nowhere into
 * the schema. `EntityCandidate.type` and `RelationCandidate.predicate` are declared
 * as plain strings — no `enum`, no `pattern`, no `const` — even when a full catalog
 * is supplied. That matters because `strict: false` is a REQUEST flag: a gateway
 * that honours `strict: true` would reject an out-of-catalog answer at the
 * provider boundary, and this package would never see the candidate it needs to
 * keep. Declaring the fields open means the same schema is correct on both kinds of
 * provider, and no flag has to be set to the permissive value for the pipeline to
 * preserve supported knowledge.
 *
 * ## The catalog is orientation, and the instruction says so
 *
 * A candidate that fits no declared type must still be returned, with its own
 * wording. The instruction states that in those words, because a model shown a
 * tidy list of types will otherwise prefer the nearest one — which is precisely how
 * "deja sin efecto" becomes `related_to` and how a free entity becomes a wrong
 * canonical one.
 *
 * ## Nothing here promises completeness
 *
 * The instruction asks for what the text supports and says a partial result is
 * expected; there is no "extract all knowledge" phrasing and no type anywhere in
 * this module that could be read as a completeness guarantee (S9). The per-chunk
 * cap is stated in the text so the model is not cut off without knowing the bound.
 */

import type { TypeCatalog } from "../catalog/types.js";
import type { ToolDefinition } from "../llm/tool-call.js";
import { DEFAULT_CANDIDATE_BUDGET } from "./budget.js";

/** The placeholder the caller replaces with the chunk text. */
export const CONTRACT_TEXT_PLACEHOLDER = "{text}";

/** The placeholder the caller replaces with the per-chunk candidate cap. */
const CAP_PLACEHOLDER = "{max_candidates}";

/**
 * The response shape, ready to send as a tool definition.
 *
 * Every object lists all of its properties as required and sets
 * `additionalProperties: false`, which is what makes it sendable in strict mode.
 * "No proposed type" is therefore expressed as JSON `null` rather than an omitted
 * key, and the parser accepts both, so a non-strict provider that simply drops the
 * key still parses.
 */
export const OPEN_EXTRACTION_TOOL = {
  name: "OpenKnowledgeCandidates",
  description: "Candidate entities and relations read from one document chunk.",
  parameters: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: { $ref: "#/$defs/EntityCandidate" },
        description:
          "Entities that matter in this text, INCLUDING entities that take part in no relation. " +
          "An entity that appears only inside a relation still has to be listed here.",
      },
      relations: {
        type: "array",
        items: { $ref: "#/$defs/RelationCandidate" },
        description:
          "Relations the text states explicitly. Both endpoints must also appear in entities. " +
          "Use an empty array when the text states none.",
      },
    },
    required: ["entities", "relations"],
    additionalProperties: false,
    $defs: {
      CandidateProperty: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
      EntityCandidate: {
        type: "object",
        properties: {
          name: { type: "string", description: "The name exactly as the text spells it." },
          type: {
            type: ["string", "null"],
            description:
              "Free-text label for what this entity is, in your own words. null when no label fits. " +
              "Any label is allowed: this field is not restricted to the known types.",
          },
          description: {
            type: ["string", "null"],
            description: "One sentence on what the entity is in this text, or null.",
          },
          properties: {
            type: "array",
            items: { $ref: "#/$defs/CandidateProperty" },
            description: "Attributes the text states about the entity; empty when it states none.",
          },
        },
        required: ["name", "type", "description", "properties"],
        additionalProperties: false,
      },
      RelationCandidate: {
        type: "object",
        properties: {
          from: { type: "string", description: "Name of the subject, as listed in entities." },
          to: { type: "string", description: "Name of the object, as listed in entities." },
          predicate: {
            type: "string",
            description:
              "The predicate EXACTLY as the text states it, for example \"deja sin efecto\". " +
              "Free text: any wording is allowed and must not be replaced by a generic verb.",
          },
          description: {
            type: ["string", "null"],
            description: "One sentence on what the relation asserts, or null.",
          },
        },
        required: ["from", "to", "predicate", "description"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies ToolDefinition;

/** What a caller may configure about the contract. */
export interface OpenExtractionContractInput {
  /** The Stack's catalog, passed as orientation only. */
  readonly catalog?: TypeCatalog;
  /** The per-chunk cap named in the instruction; defaults to the ledger's default. */
  readonly maxCandidatesPerChunk?: number;
}

/** The instruction text and the response shape handed to the model. */
export interface OpenExtractionContract {
  /** The full instruction, with {@link CONTRACT_TEXT_PLACEHOLDER} left for the caller. */
  readonly instruction: string;
  /** The tool definition carrying {@link OPEN_EXTRACTION_TOOL}'s open schema. */
  readonly tool: ToolDefinition;
  /** The catalog lines rendered into the instruction; empty when no catalog is configured. */
  readonly orientation: readonly string[];
}

/** How the lines common to every run read. */
const CORE_INSTRUCTION = [
  "Read the text below and report candidate knowledge graph entities and relations.",
  "Report entities that take part in no relation: put them in the entities list and give them no edge.",
  "Propose each entity's type as free text, in your own words, and use null when no label fits.",
  `Keep each relation's predicate exactly as the text states it, never a generic verb, and never invent a relation or an entity that the text does not state. Return at most ${CAP_PLACEHOLDER} candidates in total.`,
  "A partial result is expected: report what the text supports and do not pad the answer.",
];

/** The sentences that make the catalog orientation rather than a filter. */
const ORIENTATION_HEADER = [
  "Catalog orientation: the entity and relation types this Stack recognizes.",
  "This list is orientation, not a restriction. A candidate that matches none of these types must",
  "still be reported with its own free-text type, and a relation outside the catalog must still be",
  "reported with its original predicate.",
];

/** Renders one entity type as an orientation line. */
function entityOrientationLine(name: string, definition: string, examples: readonly string[]): string {
  const spelled = examples.length === 0 ? "" : ` Examples: ${examples.join(", ")}.`;
  return `- entity type "${name}": ${definition}${spelled}`;
}

/** Renders one relation type as an orientation line. */
function relationOrientationLine(
  name: string,
  direction: string,
  definition: string,
  examples: readonly string[],
): string {
  const spelled = examples.length === 0 ? "" : ` Examples: ${examples.join(", ")}.`;
  return `- relation type "${name}" (${direction}): ${definition}${spelled}`;
}

/** Renders the catalog as orientation lines, in declaration order. */
function catalogOrientation(catalog: TypeCatalog | undefined): readonly string[] {
  if (catalog === undefined) {
    return [];
  }
  return [
    ...catalog.entityTypes.map((type) =>
      entityOrientationLine(type.name, type.definition, type.examples),
    ),
    ...catalog.relationTypes.map((type) =>
      relationOrientationLine(type.name, type.direction, type.definition, type.examples),
    ),
  ];
}

/** Assembles the catalog block, or the line that says there is none. */
function orientationBlock(orientation: readonly string[]): readonly string[] {
  if (orientation.length === 0) {
    return ["No type catalog is configured for this run: propose types freely as free text."];
  }
  return [...ORIENTATION_HEADER, ...orientation];
}

/**
 * Builds the contract: the instruction text, and the open response shape.
 *
 * @param input - The optional catalog to render as orientation, and the cap to name.
 * @returns The instruction (with the text placeholder) plus the tool definition.
 */
export function buildOpenExtractionContract(
  input: OpenExtractionContractInput = {},
): OpenExtractionContract {
  const orientation = catalogOrientation(input.catalog);
  const cap = input.maxCandidatesPerChunk ?? DEFAULT_CANDIDATE_BUDGET.perChunkLimit;
  const instruction = [
    ...CORE_INSTRUCTION,
    ...orientationBlock(orientation),
    "",
    "Text:",
    "-------",
    CONTRACT_TEXT_PLACEHOLDER,
    "-------",
  ]
    .join("\n")
    .replace(CAP_PLACEHOLDER, String(cap));
  return { instruction, tool: OPEN_EXTRACTION_TOOL, orientation };
}

/**
 * Fills the contract's text placeholder with one chunk's content.
 *
 * Kept beside the contract so a caller cannot send an instruction still carrying a
 * literal `{text}` to a provider, which is a prompt with no document in it.
 *
 * @param contract - The built contract.
 * @param chunkContent - The chunk text, handled as data.
 * @returns The instruction for one chunk.
 */
export function renderContractInstruction(
  contract: OpenExtractionContract,
  chunkContent: string,
): string {
  return contract.instruction.replace(CONTRACT_TEXT_PLACEHOLDER, chunkContent);
}
