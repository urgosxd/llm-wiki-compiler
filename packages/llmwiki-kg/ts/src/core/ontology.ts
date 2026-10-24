/**
 * @file packages/llmwiki-kg/ts/src/core/ontology.ts
 * @description A caller-declared knowledge-graph ontology, and its enforcement.
 *
 * ## Why this module exists
 *
 * The oracle's extractor runs with `strict=False`: `graph-prompt.ts` puts
 * `DEFAULT_ENTITIES` and `DEFAULT_RELATIONS` into the tool-schema *description*
 * the model reads, and then nothing validates against them. Measurement recorded
 * in `graph-parse.ts` confirms it — the oracle stores a `worked_on` edge between
 * two `CONCEPT` nodes, which the default schema does not permit.
 *
 * That is the right default for a document compiler: the model sees a hint and
 * an unusual sentence still yields something. It is the wrong behaviour for a
 * caller who needs the graph to contain only the types they declared. This
 * module turns a declaration into a contract, and reports what it turned away so
 * a thin extraction cannot be mistaken for a tight ontology.
 *
 * ## Additivity is a hard requirement, not a preference
 *
 * `graph-prompt.ts` states that the prompt text and tool schema were copied from
 * the oracle precisely because the model's output shape is a function of them.
 * Therefore nothing here changes default behaviour: `parseTriplets` keeps its
 * signature and stays total, the ontology is an optional argument everywhere it
 * appears, and with no ontology supplied the parser admits every type exactly as
 * the oracle does. The parity tests are the regression gate for this module.
 *
 * ## What the subtype hierarchy does, and does not, do
 *
 * `subtypes` is validated as a real structure — every endpoint must be declared,
 * and a cycle is rejected, because a cycle makes "is this type allowed" depend on
 * where you start asking. Beyond validation the hierarchy is recorded and
 * exposed through {@link isEntityTypeAllowed}, which admits a descendant where
 * its ancestor is required. It deliberately does NOT rewrite stored types: a
 * `STARTUP` is still stored as `startup`. Hierarchy-aware reads are a separate
 * surface and are out of scope here.
 */

import { readFile } from "node:fs/promises";

import { parseTriplets, type Triplet } from "./graph-parse.js";

/** One `child IS_A parent` edge between two declared entity types. */
export interface SubtypeEdge {
  readonly child: string;
  readonly parent: string;
}

/** A validated ontology: the type allowlists plus the validated hierarchy. */
export interface Ontology {
  readonly entityTypes: readonly string[];
  readonly relationshipTypes: readonly string[];
  readonly subtypes: readonly SubtypeEdge[];
  /** Direct parents per entity type, for ancestor walks. */
  readonly parentsOf: ReadonlyMap<string, readonly string[]>;
}

/** Why a triplet was turned away. */
export type RejectionReason = "UNKNOWN_ENTITY_TYPE" | "UNKNOWN_RELATIONSHIP_TYPE";

/** One rejected triplet, flattened to names so it can be reported verbatim. */
export interface RejectedTriplet {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
  readonly reason: RejectionReason;
  readonly offendingType: string;
}

/** Triplets that survived enforcement, plus a report of those that did not. */
export interface OntologyParseResult {
  readonly triplets: readonly Triplet[];
  readonly rejected: readonly RejectedTriplet[];
}

/** Raised for every way an ontology declaration can be wrong. */
export class OntologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OntologyError";
  }
}

/** Normalises a type label exactly as `graph-parse.ts` normalises model output. */
function normalizeType(raw: string): string {
  return raw.replaceAll(" ", "_").toUpperCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Reads a non-empty list of type names from one field.
 *
 * An empty list is an error rather than "allow nothing": an ontology that admits
 * no types is a mistake in the declaration, and reporting it at load time beats
 * silently rejecting every triplet of every document.
 */
function readTypeList(source: Record<string, unknown>, field: string): readonly string[] {
  const raw = source[field];
  if (raw === undefined) {
    throw new OntologyError(`ontology is missing required field "${field}"`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OntologyError(`ontology field "${field}" must be a non-empty array of type names`);
  }
  const names = raw.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new OntologyError(`ontology field "${field}" contains a non-string or empty type name`);
    }
    return normalizeType(entry.trim());
  });
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new OntologyError(`ontology field "${field}" declares "${duplicate}" more than once`);
  }
  return names;
}

/** Reads the optional `subtypes` list, tolerating its absence. */
function readSubtypes(source: Record<string, unknown>): readonly SubtypeEdge[] {
  const raw = source["subtypes"];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new OntologyError('ontology field "subtypes" must be an array');
  }
  return raw.map((entry) => {
    const record = asRecord(entry);
    const child = record?.["child"];
    const parent = record?.["parent"];
    if (typeof child !== "string" || typeof parent !== "string") {
      throw new OntologyError('each entry of "subtypes" must have string "child" and "parent"');
    }
    return { child: normalizeType(child), parent: normalizeType(parent) };
  });
}

/** Rejects a hierarchy that references a type the ontology never declared. */
function assertSubtypesDeclared(
  subtypes: readonly SubtypeEdge[],
  entityTypes: readonly string[],
): void {
  for (const edge of subtypes) {
    for (const name of [edge.child, edge.parent]) {
      if (!entityTypes.includes(name)) {
        throw new OntologyError(
          `ontology "subtypes" references "${name}", which is not declared in "entityTypes"`,
        );
      }
    }
  }
}

/** Walks parents from one type, detecting a cycle by revisiting a node. */
function assertNoCycle(subtypes: readonly SubtypeEdge[]): void {
  const parentsOf = new Map<string, string[]>();
  for (const edge of subtypes) {
    const existing = parentsOf.get(edge.child);
    if (existing === undefined) {
      parentsOf.set(edge.child, [edge.parent]);
    } else {
      existing.push(edge.parent);
    }
  }
  const settled = new Set<string>();
  const inProgress = new Set<string>();
  /** Depth-first walk; throws when it returns to a node still on the stack. */
  const visit = (type: string): void => {
    if (settled.has(type)) return;
    if (inProgress.has(type)) {
      throw new OntologyError(`ontology "subtypes" contains a cycle through "${type}"`);
    }
    inProgress.add(type);
    for (const parent of parentsOf.get(type) ?? []) {
      visit(parent);
    }
    inProgress.delete(type);
    settled.add(type);
  };
  for (const edge of subtypes) {
    visit(edge.child);
  }
}

/** Builds the direct-parents index an ancestor walk needs. */
function buildParentIndex(subtypes: readonly SubtypeEdge[]): Map<string, readonly string[]> {
  const index = new Map<string, readonly string[]>();
  for (const edge of subtypes) {
    const existing = index.get(edge.child);
    index.set(edge.child, existing === undefined ? [edge.parent] : [...existing, edge.parent]);
  }
  return index;
}

/**
 * Validates an untrusted ontology declaration.
 *
 * Accepts `unknown` because the declaration arrives as parsed JSON, which is
 * untrusted by construction. Every failure is an {@link OntologyError} naming the
 * offending field or type, so a hand-edited file can be fixed without reading
 * this source.
 *
 * @param input - Parsed JSON, of unknown shape.
 * @returns The validated ontology, with types normalised.
 * @throws {OntologyError} When a required field is missing, empty, duplicated,
 *   references an undeclared type, or forms a cycle.
 */
export function validateOntology(input: unknown): Ontology {
  const source = asRecord(input);
  if (source === undefined) {
    throw new OntologyError("ontology must be a JSON object");
  }
  const entityTypes = readTypeList(source, "entityTypes");
  const relationshipTypes = readTypeList(source, "relationshipTypes");
  const subtypes = readSubtypes(source);
  assertSubtypesDeclared(subtypes, entityTypes);
  assertNoCycle(subtypes);
  return { entityTypes, relationshipTypes, subtypes, parentsOf: buildParentIndex(subtypes) };
}

/**
 * Reads and validates an ontology JSON file.
 *
 * A missing or unreadable file is reported as an {@link OntologyError} rather
 * than the raw `fs` error: the caller passed a path to an ontology, and the
 * useful fact is that the ontology could not be read, not which syscall failed.
 *
 * @param path - Filesystem path to the ontology JSON.
 * @returns The validated ontology.
 * @throws {OntologyError} When the file cannot be read, is not valid JSON, or
 *   fails {@link validateOntology}.
 */
export async function loadOntology(path: string): Promise<Ontology> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OntologyError(`cannot read ontology file "${path}": ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OntologyError(`ontology file "${path}" is not valid JSON: ${reason}`);
  }
  try {
    return validateOntology(parsed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OntologyError(`ontology file "${path}" is invalid: ${reason}`);
  }
}

/**
 * Every ancestor of one entity type, nearest first.
 *
 * @param ontology - The validated ontology.
 * @param type - A normalised entity type.
 * @returns Ancestor types; empty when the type has no declared parent.
 */
export function ancestorsOf(ontology: Ontology, type: string): readonly string[] {
  const found: string[] = [];
  const queue = [...(ontology.parentsOf.get(type) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || found.includes(next)) continue;
    found.push(next);
    queue.push(...(ontology.parentsOf.get(next) ?? []));
  }
  return found;
}

/**
 * Whether an entity type satisfies any of the required types.
 *
 * A type satisfies a requirement when it IS one of them, or is a descendant of
 * one. The relation relaxes upward only: a requirement on `COMPANY` is not
 * satisfied by a bare `ORGANIZATION`, because admitting the parent would let the
 * model widen the ontology the caller declared.
 *
 * @param ontology - The validated ontology supplying the hierarchy.
 * @param type - The entity type the model emitted.
 * @param required - The types that would satisfy the constraint.
 * @returns True when the type is required or descends from a required type.
 */
export function isEntityTypeAllowed(
  ontology: Ontology,
  type: string,
  required: readonly string[],
): boolean {
  if (required.includes(type)) return true;
  return ancestorsOf(ontology, type).some((ancestor) => required.includes(ancestor));
}

/**
 * Decides whether one triplet is admissible, returning why it is not.
 *
 * Entity types are checked before the relationship type so the report names the
 * more specific cause: when a triplet has both problems, the endpoint is the one
 * that also costs the entity.
 *
 * @param triplet - A parsed triplet.
 * @param ontology - The ontology to enforce.
 * @returns The rejection, or `undefined` when the triplet is admissible.
 */
function rejectTriplet(triplet: Triplet, ontology: Ontology): RejectedTriplet | undefined {
  const base = {
    subject: triplet.subjectName,
    relation: triplet.relationType,
    object: triplet.objectName,
  };
  for (const endpointType of [triplet.subjectType, triplet.objectType]) {
    if (!isEntityTypeAllowed(ontology, endpointType, ontology.entityTypes)) {
      return { ...base, reason: "UNKNOWN_ENTITY_TYPE", offendingType: endpointType };
    }
  }
  if (!ontology.relationshipTypes.includes(triplet.relationType)) {
    return {
      ...base,
      reason: "UNKNOWN_RELATIONSHIP_TYPE",
      offendingType: triplet.relationType,
    };
  }
  return undefined;
}

/**
 * Parses a tool payload and enforces an ontology, reporting what it rejected.
 *
 * Kept separate from {@link parseTriplets} on purpose: that function is called by
 * the ingest route and its return type is a bare array. Widening it would change
 * a shared contract and would let a forgotten ontology argument silently alter
 * behaviour, so the enforcing path gets its own name and its own return shape.
 *
 * @param argumentsJson - The model's tool-call argument string.
 * @param ontology - The ontology to enforce.
 * @returns Admitted triplets plus one rejection record per dropped triplet.
 */
export function parseTripletsWithOntology(
  argumentsJson: string,
  ontology: Ontology,
): OntologyParseResult {
  const triplets: Triplet[] = [];
  const rejected: RejectedTriplet[] = [];
  for (const triplet of parseTriplets(argumentsJson)) {
    const rejection = rejectTriplet(triplet, ontology);
    if (rejection === undefined) {
      triplets.push(triplet);
    } else {
      rejected.push(rejection);
    }
  }
  return { triplets, rejected };
}
