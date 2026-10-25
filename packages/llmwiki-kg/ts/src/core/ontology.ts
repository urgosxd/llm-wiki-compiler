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

import { parseTriplets, type StandaloneEntity, type Triplet } from "./graph-parse.js";

/** One `child IS_A parent` edge between two declared entity types. */
export interface SubtypeEdge {
  readonly child: string;
  readonly parent: string;
}

/**
 * Which entity types one relationship may connect.
 *
 * ## Why this is separate from `relationshipTypes`
 *
 * `relationshipTypes` answers "may the model emit `EMPLOYS` at all". It cannot
 * answer "may a PERSON employ a PERSON", because the type allowlists are checked
 * endpoint by endpoint and never as a pair. Measured before this existed: all
 * four combinations of `COMPANY`/`PERSON` with `EMPLOYS` were admitted, including
 * `PERSON EMPLOYS PERSON`.
 *
 * Declaring a relationship here adds the pair constraint for that relationship
 * only. A relationship left out of this list stays pair-unconstrained, so an
 * existing declaration keeps exactly the behaviour it had — the constraints are
 * additive, not a replacement for `relationshipTypes`.
 */
export interface RelationshipConstraint {
  /** The relationship type this constraint applies to, normalised. */
  readonly type: string;
  /** Entity types that may appear as the subject. Empty means any declared type. */
  readonly domains: readonly string[];
  /** Entity types that may appear as the object. Empty means any declared type. */
  readonly ranges: readonly string[];
}

/** A validated ontology: the type allowlists plus the validated hierarchy. */
export interface Ontology {
  readonly entityTypes: readonly string[];
  readonly relationshipTypes: readonly string[];
  readonly subtypes: readonly SubtypeEdge[];
  /** Direct parents per entity type, for ancestor walks. */
  readonly parentsOf: ReadonlyMap<string, readonly string[]>;
  /**
   * Pair constraints by relationship type, for relationships that declare them.
   *
   * A relationship absent from this map is unconstrained as a pair, which is why
   * the field is a map and not an array: the question asked at enforcement time is
   * "what does `EMPLOYS` require", not "walk every constraint".
   */
  readonly constraintsOf: ReadonlyMap<string, RelationshipConstraint>;
}

/** Why a triplet was turned away. */
export type RejectionReason =
  | "UNKNOWN_ENTITY_TYPE"
  | "UNKNOWN_RELATIONSHIP_TYPE"
  | "SUBJECT_TYPE_NOT_IN_DOMAIN"
  | "OBJECT_TYPE_NOT_IN_RANGE";

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

/**
 * Reads the optional `relationships` list of pair constraints.
 *
 * Absent means no relationship is pair-constrained, which is what keeps an
 * ontology written before this field existed loading unchanged. An empty `domains`
 * or `ranges` list is treated the same as omitting it: it cannot mean "permit
 * nothing", because that would silently drop every triplet of that relationship
 * and read as a thin extraction.
 */
function readConstraints(source: Record<string, unknown>): readonly RelationshipConstraint[] {
  const raw = source["relationships"];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new OntologyError('ontology field "relationships" must be an array');
  }
  return raw.map((entry) => {
    const record = asRecord(entry);
    const type = record?.["type"];
    if (typeof type !== "string" || type.trim() === "") {
      throw new OntologyError('each entry of "relationships" must have a non-empty string "type"');
    }
    return {
      type: normalizeType(type.trim()),
      domains: readTypeNameArray(record?.["domains"], "domains"),
      ranges: readTypeNameArray(record?.["ranges"], "ranges"),
    };
  });
}

/** Reads an optional list of normalised type names, where absent means "any". */
function readTypeNameArray(raw: unknown, field: string): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new OntologyError(`ontology "relationships" field "${field}" must be an array`);
  }
  return raw.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new OntologyError(
        `ontology "relationships" field "${field}" contains a non-string or empty type name`,
      );
    }
    return normalizeType(entry.trim());
  });
}

/**
 * Rejects a constraint that could never be satisfied.
 *
 * A constraint naming a relationship outside `relationshipTypes`, or a domain or
 * range outside `entityTypes`, is a declaration mistake: `EMPLOYS` bounded by
 * `COMPANY` does nothing if `EMPLOYS` was never declared admissible, and it would
 * look like the constraint was being enforced when it never could be.
 */
function assertConstraintsDeclared(
  constraints: readonly RelationshipConstraint[],
  entityTypes: readonly string[],
  relationshipTypes: readonly string[],
): void {
  for (const constraint of constraints) {
    if (!relationshipTypes.includes(constraint.type)) {
      throw new OntologyError(
        `ontology "relationships" constrains "${constraint.type}", which is not declared in "relationshipTypes"`,
      );
    }
    for (const [field, names] of [
      ["domains", constraint.domains],
      ["ranges", constraint.ranges],
    ] as const) {
      for (const name of names) {
        if (!entityTypes.includes(name)) {
          throw new OntologyError(
            `ontology "relationships" ${field} references "${name}", which is not declared in "entityTypes"`,
          );
        }
      }
    }
  }
  const duplicate = constraints.find(
    (entry, index) => constraints.findIndex((other) => other.type === entry.type) !== index,
  );
  if (duplicate !== undefined) {
    throw new OntologyError(
      `ontology "relationships" constrains "${duplicate.type}" more than once`,
    );
  }
}

/** Indexes constraints by relationship type for enforcement-time lookups. */
function buildConstraintIndex(
  constraints: readonly RelationshipConstraint[],
): ReadonlyMap<string, RelationshipConstraint> {
  return new Map(constraints.map((constraint) => [constraint.type, constraint]));
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
  const constraints = readConstraints(source);
  assertSubtypesDeclared(subtypes, entityTypes);
  assertNoCycle(subtypes);
  assertConstraintsDeclared(constraints, entityTypes, relationshipTypes);
  return {
    entityTypes,
    relationshipTypes,
    subtypes,
    parentsOf: buildParentIndex(subtypes),
    constraintsOf: buildConstraintIndex(constraints),
  };
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
 * Checks one endpoint against a declared domain or range list.
 *
 * An empty list means "any declared type", so an unconstrained side passes
 * without a lookup. A constrained side is checked through
 * {@link isEntityTypeAllowed}, which is where the subtype hierarchy finally earns
 * its keep: a domain of `ORGANIZATION` admits a `COMPANY` when `COMPANY` is
 * declared a subtype of it. Before pair constraints existed the hierarchy was
 * decorative, because every declared type satisfied the full allowlist by
 * identity.
 */
function endpointViolates(
  ontology: Ontology,
  endpointType: string,
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) return false;
  return !isEntityTypeAllowed(ontology, endpointType, allowed);
}

/**
 * Decides whether one triplet is admissible, returning why it is not.
 *
 * Checks run in a fixed order — entity allowlist, relationship allowlist, then the
 * pair — so the reported reason is the most specific cause that applies. The pair
 * comes last because a triplet whose relationship is not declared at all is better
 * explained by that than by a domain it also violates.
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
  const constraint = ontology.constraintsOf.get(triplet.relationType);
  if (constraint === undefined) {
    return undefined;
  }
  if (endpointViolates(ontology, triplet.subjectType, constraint.domains)) {
    return {
      ...base,
      reason: "SUBJECT_TYPE_NOT_IN_DOMAIN",
      offendingType: triplet.subjectType,
    };
  }
  if (endpointViolates(ontology, triplet.objectType, constraint.ranges)) {
    return {
      ...base,
      reason: "OBJECT_TYPE_NOT_IN_RANGE",
      offendingType: triplet.objectType,
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

/**
 * Admits standalone entities whose type the ontology declares.
 *
 * A standalone entity has no relationship to check, so the only question is its
 * own type. It is filtered rather than refused: an entity carries no pair
 * information, so an out-of-ontology one is simply not admitted, and the caller
 * needs no rejection record to understand a missing node.
 *
 * The subtype hierarchy applies here too, through
 * {@link isEntityTypeAllowed}, so a `COMPANY` reported standalone is admitted by
 * an ontology that declares `ORGANIZATION` and `COMPANY IS_A ORGANIZATION`.
 *
 * @param entities - Entities the model reported outside any triplet.
 * @param ontology - The ontology to enforce.
 * @returns The entities whose type is declared.
 */
export function admitStandaloneEntities(
  entities: readonly StandaloneEntity[],
  ontology: Ontology,
): StandaloneEntity[] {
  return entities.filter((entity) =>
    isEntityTypeAllowed(ontology, entity.type, ontology.entityTypes),
  );
}
