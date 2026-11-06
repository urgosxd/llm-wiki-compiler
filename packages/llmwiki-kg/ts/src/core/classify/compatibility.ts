/**
 * @file packages/llmwiki-kg/ts/src/core/classify/compatibility.ts
 * @description Whether a classified relation's endpoints are permitted by the catalog.
 *
 * ## Three answers, and why `indeterminate` is not a failure (S34)
 *
 * - `compatible` — the relation is declared, both endpoint types are known, and the
 *   triple is permitted (or the relation declares no constraints at all, which the
 *   catalog documents as "unconstrained", never as "forbidden").
 * - `conflict` — the relation is declared, both endpoint types are known, and the
 *   triple is NOT in the permitted set.
 * - `indeterminate` — we cannot tell: at least one endpoint has no canonical type,
 *   or the relation itself is free. Unknown is reported as unknown, never guessed
 *   into one of the decided answers.
 *
 * ## Compatibility is not source support (S35)
 *
 * This function never sees evidence and never changes a classification. A fact the
 * source states plainly (`supported`) can conflict with the catalog, and it is kept
 * with the conflict recorded: the catalog is our vocabulary, not a filter on what
 * the documents may assert. Nor does a conflict force a canonical type or withdraw
 * one — it is a separate axis with its own column, so both facts survive.
 *
 * ## Reading direction
 *
 * Constraints are always declared in the relation's canonical reading order, so an
 * `inverse` relation is checked with its endpoints swapped: the assertion
 * `Process —is executed by→ Role` reaches the constraint `Role —…→ Process`. The
 * swap is a reading aid for the check only; it never rewrites the stored triple.
 */

import { normalizeCatalogName } from "../catalog/names.js";
import { relationConstraintsFor, resolveRelationType } from "../catalog/lookup.js";
import type { RelationConstraint, RelationTypeDef, TypeCatalog } from "../catalog/types.js";
import type { CompatibilityState } from "./types.js";

/** What a compatibility check needs. */
export interface CompatibilityInput {
  /** The Stack's catalog, the source of every permitted triple. */
  readonly catalog: TypeCatalog;
  /** The relation's canonical type, or `null` when it stayed free. */
  readonly canonicalRelationType: string | null;
  /** The subject entity's canonical type, or `null` when it has none. */
  readonly fromCanonicalType: string | null;
  /** The object entity's canonical type, or `null` when it has none. */
  readonly toCanonicalType: string | null;
}

/**
 * Whether a declared constraint admits the triple being checked.
 *
 * @param constraint - One permitted combination, in canonical reading order.
 * @param from - Canonical subject type, already swapped for an inverse relation.
 * @param to - Canonical object type, already swapped for an inverse relation.
 * @returns True when the constraint is this triple.
 */
function admits(constraint: RelationConstraint, from: string, to: string): boolean {
  return (
    normalizeCatalogName(constraint.from) === normalizeCatalogName(from) &&
    normalizeCatalogName(constraint.to) === normalizeCatalogName(to)
  );
}

/**
 * Checks one triple against the constraints a relation declares.
 *
 * The relation's own canonical name is used, not the caller's spelling, so an alias
 * reaching this function checks the same constraints as the canonical verb.
 *
 * @param catalog - The Stack's catalog.
 * @param relation - The resolved relation definition.
 * @param from - Canonical subject type in canonical reading order.
 * @param to - Canonical object type in canonical reading order.
 * @returns `compatible` or `conflict`; never `indeterminate`, which is the caller's
 *   job because only the caller knows whether a type was missing.
 */
function checkDeclaredConstraints(
  catalog: TypeCatalog,
  relation: RelationTypeDef,
  from: string,
  to: string,
): CompatibilityState {
  const constraints = relationConstraintsFor(catalog, relation.name);
  if (constraints.length === 0) {
    return "compatible";
  }
  return constraints.some((constraint) => admits(constraint, from, to)) ? "compatible" : "conflict";
}

/**
 * Reports how a classified relation sits against the catalog's permitted triples.
 *
 * @param input - The catalog, the relation's canonical type and both endpoint types.
 * @returns `compatible`, `conflict`, or `indeterminate` when something is unknown.
 */
export function assessRelationCompatibility(input: CompatibilityInput): CompatibilityState {
  const relation =
    input.canonicalRelationType === null
      ? undefined
      : resolveRelationType(input.catalog, input.canonicalRelationType);
  if (relation === undefined) {
    return "indeterminate";
  }
  if (input.fromCanonicalType === null || input.toCanonicalType === null) {
    return "indeterminate";
  }
  const inverse = relation.direction === "inverse";
  const from = inverse ? input.toCanonicalType : input.fromCanonicalType;
  const to = inverse ? input.fromCanonicalType : input.toCanonicalType;
  return checkDeclaredConstraints(input.catalog, relation, from, to);
}
