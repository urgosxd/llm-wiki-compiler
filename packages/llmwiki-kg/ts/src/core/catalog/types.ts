/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/types.ts
 * @description The versioned per-Stack type catalog, and the one name this application reserves.
 *
 * ## What a catalog is, and what it is not
 *
 * A catalog is **our configuration**, not a standard. The vendored AKS schema is
 * explicit that no global vocabulary exists — `SCHEMA.json:499` documents
 * `AKSEntity.type` as *"Domain-defined category. No global enum."* — so nothing
 * here claims AKS compliance or proposes a new AKS profile. It is the declared
 * vocabulary a Stack's ingestion uses as *orientation* while classifying, and it
 * is versioned so a later reclassification run can tell whether the vocabulary
 * moved underneath the stored decisions.
 *
 * ## Immutability is a requirement, not a style choice
 *
 * Ingestion must never add a type: a candidate that does not fit stays free
 * rather than extending the vocabulary it was measured against. That is
 * enforced in two layers — every field here is `readonly` so no mutator can be
 * typed, and {@link parseTypeCatalog} deep-freezes what it returns so a holder
 * cannot widen the catalog at runtime either. There is deliberately no
 * `addType`, no `autoExtend`, and no learning helper anywhere in this directory.
 */

/**
 * Which way a canonical relation verb reads along an asserted `subject -> object` arrow.
 *
 * - `forward`: the canonical verb reads from subject to object, so a candidate
 *   phrased actively (`Role executes Process`) resolves as emitted.
 * - `inverse`: the canonical verb reads from object to subject, so a candidate
 *   reaches it through a passive phrasing (`Process is executed by Role`) and a
 *   consumer must swap the endpoints before consulting the constraints.
 *
 * Constraints are always declared in canonical reading order, so `inverse` is
 * metadata for the consumer, never a licence to redefine a triple.
 */
export type RelationDirection = "forward" | "inverse";

/** Every direction a relation definition may declare, in declaration order. */
export const RELATION_DIRECTIONS: readonly RelationDirection[] = ["forward", "inverse"];

/**
 * One canonical entity type.
 *
 * `definition` is required because a type nobody can describe cannot orient a
 * classifier; `examples` may be empty, because an example list is an aid to
 * reading a prompt, not part of the type's meaning.
 */
export interface EntityTypeDef {
  /** The canonical spelling. Resolution compares it case- and space-insensitively. */
  readonly name: string;
  /** What the type means, in one or two sentences, as shown to a classifier. */
  readonly definition: string;
  /** Representative labels of this type; empty when none were declared. */
  readonly examples: readonly string[];
}

/** One canonical relation type. */
export interface RelationTypeDef {
  /** The canonical verb phrasing, e.g. `executes`. */
  readonly name: string;
  /** What the relation asserts between its endpoints. */
  readonly definition: string;
  /** Which way the verb reads along the asserted arrow. */
  readonly direction: RelationDirection;
  /** Representative assertions of this relation, e.g. `Role executes Process`. */
  readonly examples: readonly string[];
}

/**
 * One permitted `(from entity type, relation type, to entity type)` combination.
 *
 * Names are canonical spellings, resolved at parse time. A relation with no
 * declared constraint is unconstrained rather than forbidden, which is why
 * absence is reported as an empty list and not as an implicit rule.
 */
export interface RelationConstraint {
  /** Canonical subject-side entity type. */
  readonly from: string;
  /** Canonical relation type. */
  readonly relation: string;
  /** Canonical object-side entity type. */
  readonly to: string;
}

/**
 * One label that normalizes to a canonical type.
 *
 * Entity aliases and relation aliases are separate lists because the two
 * namespaces are separate: a document artifact called `standard` is not the
 * relation `governs`, and mixing them would let a model's guess in one namespace
 * resolve in the other.
 */
export interface TypeAlias {
  /** The label as a caller, an extractor or a document spelled it. */
  readonly alias: string;
  /** The canonical spelling this label normalizes to. */
  readonly canonical: string;
}

/**
 * A validated, immutable, versioned catalog.
 *
 * The whole object is frozen by {@link parseTypeCatalog}, and the only supported
 * way to obtain one is that parser, so an instance always satisfies every
 * invariant the parser enforces.
 */
export interface TypeCatalog {
  /**
   * The catalog version, e.g. `1.0.0`.
   *
   * SemVer is the recommended shape but not enforced: what matters is that a
   * stored classification decision can record which version produced it, so a
   * vocabulary change is a deliberate, traceable bump.
   */
  readonly version: string;
  /** Canonical entity types; never empty. */
  readonly entityTypes: readonly EntityTypeDef[];
  /** Canonical relation types; never empty. */
  readonly relationTypes: readonly RelationTypeDef[];
  /** Permitted type combinations; empty when the catalog declares none. */
  readonly constraints: readonly RelationConstraint[];
  /** Entity-type aliases; empty when the catalog declares none. */
  readonly entityAliases: readonly TypeAlias[];
  /** Relation-type aliases; empty when the catalog declares none. */
  readonly relationAliases: readonly TypeAlias[];
}

/**
 * Raised for every way a catalog declaration can be wrong.
 *
 * A catalog is untrusted input that becomes the vocabulary of every later stage,
 * so a parse that degraded quietly would make a wrong classification
 * indistinguishable from a document that genuinely matches no type. Each message
 * names the offending field, so a hand-edited catalog or a stored row can be
 * fixed without reading this source.
 */
export class TypeCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeCatalogError";
  }
}

/**
 * The entity type this application reserves for entities that carry no canonical type.
 *
 * ## This is OUR convention, not AKS
 *
 * AKS has no reserved type: `SCHEMA.json` permits any domain-defined string, so
 * `Unclassified` is our own projection label for a free entity — one that is
 * supported by its sources but matched no catalog type. It means "no canonical
 * type was assigned"; it does not mean false, invalid, or awaiting human review,
 * and it says nothing about the entity's evidence.
 *
 * Because it is a convention rather than a catalog entry, a user catalog must
 * never declare it: {@link parseTypeCatalog} rejects that declaration so a real
 * type can never collide with the free-entity marker. That rejection is the whole
 * reason this constant lives here instead of inside a catalog.
 */
export const UNCLASSIFIED_ENTITY_TYPE = "Unclassified";
