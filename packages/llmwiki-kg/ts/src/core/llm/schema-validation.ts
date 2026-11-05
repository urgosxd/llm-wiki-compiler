/**
 * @file packages/llmwiki-kg/ts/src/core/llm/schema-validation.ts
 * @description Client-side validation of a tool payload against the generated schema.
 *
 * ## Why this module exists
 *
 * The tool schema narrows an entity's or a relation's `type` to a JSON Schema
 * `enum`, but whether the provider ENFORCES that `enum` is a property of the
 * provider, not of the schema. `strict: true` is what makes it binding, and
 * `strict-policy.ts` sends that flag only to providers known to implement it
 * (`openai`). On `anthropic`, and on the default `gateway` — whatever
 * OpenAI-compatible endpoint the operator pointed `GATEWAY_URL` at — the `enum`
 * is advisory: an out-of-ontology type arrives untouched, and `graph-parse.ts`
 * only checks that the field is a string. The model's non-compliance is therefore
 * invisible, and reads exactly like a legitimate type the model chose.
 *
 * This module makes it visible by validating the RETURNED payload against the
 * generated schema in this process. It only ever COUNTS: nothing here drops,
 * rewrites, or reorders a triplet. The triplet still travels the normal
 * `parseTripletsWithOntology` → `rejectTriplet` path, so what a Stack's graph may
 * contain stays decided in one place, and this counter is purely additive.
 *
 * The payload is read through `parseJsonLoosely` from `graph-parse.ts`, imported
 * rather than copied: this module explains what the parser did, so the two must
 * never disagree about what the model said. A second, private tolerant parse here
 * would drift silently and one-directionally — the counter would report `0` for a
 * payload the parser accepted.
 *
 * ## Why the generated schema is the source of truth
 *
 * The permitted values are read from `buildToolSchema(ontology)` — the very
 * object sent to the provider — rather than from the ontology itself. A validator
 * holding its own copy of the list could disagree with the schema the model was
 * shown, and in the direction nobody checks: it would report a violation for a
 * value the schema permits. Reading the schema keeps the two in step by
 * construction, so a change to the schema changes the validator with it.
 *
 * ## Why a default run has nothing to enforce
 *
 * `buildToolSchema()` with no ontology returns `KG_TOOL` itself, whose `type`
 * fields carry a description and no `enum` — the oracle's `strict=False` shape.
 * Counting against `DEFAULT_ENTITIES`/`DEFAULT_RELATIONS` would be an unrequested
 * behaviour change: a default run accepts whatever the model emits, and its
 * result must keep saying so.
 */

import { z } from "zod";

import type { ToolSchema } from "../graph-prompt.js";
import { parseJsonLoosely } from "../graph-parse.js";
import { asArray, asRecord } from "./json.js";

/** The permitted values of the two `type` fields the generated schema constrains. */
interface TypeAllowlist {
  readonly entities: readonly string[];
  readonly relations: readonly string[];
}

/**
 * Reads the two `type` enums out of the generated tool schema.
 *
 * @param schema - The schema that was sent with the request.
 * @returns Both allowlists, or `undefined` when either field carries no `enum`.
 */
function typeAllowlist(schema: ToolSchema): TypeAllowlist | undefined {
  const entities = schema.parameters.$defs.Entity.properties.type.enum;
  const relations = schema.parameters.$defs.Relation.properties.type.enum;
  if (entities === undefined || relations === undefined) {
    return undefined;
  }
  return { entities, relations };
}

/**
 * Counts the `type` positions of a returned payload that its schema forbids.
 *
 * A "violation" is one position — a subject's, a relation's, or an object's
 * `type` — whose value the generated schema's `enum` does not list. Every raw
 * `triplets` entry is inspected, including entries `graph-parse.ts` will later
 * drop, because this answers "did the model obey the schema it was shown", not
 * "what survived parsing".
 *
 * Values are read BEFORE normalisation, because that is what the provider was
 * asked to constrain: `" company"` never matched the `enum` the model was shown,
 * even though `normalizeType` later trims it into a legal value.
 *
 * @param argumentsJson - The model's tool-call argument string, unvalidated.
 * @param schema - The schema that was sent with the request.
 * @returns How many `type` positions fall outside their allowlist; `0` when the
 *   schema carries no `enum`, and `0` when the payload cannot be read at all.
 */
export function countSchemaViolations(argumentsJson: string, schema: ToolSchema): number {
  const allowlist = typeAllowlist(schema);
  if (allowlist === undefined) {
    return 0;
  }
  const entityType = z.enum(allowlist.entities);
  const relationType = z.enum(allowlist.relations);
  const triplets = asArray(asRecord(parseJsonLoosely(argumentsJson))?.["triplets"]) ?? [];
  return triplets.reduce(
    (total: number, triplet: unknown) => total + tripletViolations(triplet, entityType, relationType),
    0,
  );
}

/**
 * Counts the violating `type` positions of one raw triplet.
 *
 * @param triplet - One element of the payload's `triplets` array, unvalidated.
 * @param entityType - Validator for the entity allowlist.
 * @param relationType - Validator for the relation allowlist.
 * @returns How many of the three positions are outside their allowlist.
 */
function tripletViolations(
  triplet: unknown,
  entityType: z.ZodType,
  relationType: z.ZodType,
): number {
  const record = asRecord(triplet);
  const positions: readonly (readonly [unknown, z.ZodType])[] = [
    [typeOf(record?.["subject"]), entityType],
    [typeOf(record?.["relation"]), relationType],
    [typeOf(record?.["object"]), entityType],
  ];
  return positions.filter(([value, validator]) => isViolation(value, validator)).length;
}

/**
 * Reads the raw `type` value of one endpoint or relation object.
 *
 * @param holder - The unwrapped `subject`, `relation`, or `object` value.
 * @returns Whatever sits at `type`, unvalidated, or `undefined` when absent.
 */
function typeOf(holder: unknown): unknown {
  return asRecord(holder)?.["type"];
}

/**
 * Whether one raw `type` value is outside its allowlist.
 *
 * An ABSENT `type` is not counted: `parseTriplets` drops a triplet missing the
 * field before the ontology ever sees it, so reporting it here would name a
 * rejection that never happened.
 *
 * @param value - The raw value at the `type` position.
 * @param validator - Validator for the corresponding allowlist.
 * @returns True when a value is present and the schema forbids it.
 */
function isViolation(value: unknown, validator: z.ZodType): boolean {
  return value !== undefined && !validator.safeParse(value).success;
}
