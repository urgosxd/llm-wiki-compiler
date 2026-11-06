/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/lookup.ts
 * @description Resolving a proposed type label, and the constraints of a relation.
 *
 * ## The negative answer is the important one
 *
 * Resolution answers "does this label name a declared type", and the whole point
 * of a catalog in an open-extraction pipeline is that it may say no. A label the
 * catalog does not declare must come back empty so the candidate stays free; it
 * must never fall back to a default type, a first entry, or a catch-all, because
 * a wrong canonical type is worse than an honest free entity — it is
 * indistinguishable from a correct classification and it moves a guess into every
 * filter, page and export that trusts canonical types.
 *
 * ## Exact names win over aliases
 *
 * A canonical name is checked before any alias. The parser already refuses an
 * alias that normalizes to a declared name, so this order cannot change the
 * answer today; it exists so the precedence is explicit rather than incidental,
 * and so a future parser change cannot make an alias silently redirect a
 * canonical name.
 *
 * ## Constraints are reported as declared, not as an opinion
 *
 * {@link relationConstraintsFor} returns the declared triples for a relation and
 * an empty list otherwise. An empty list therefore cannot distinguish "declared,
 * unconstrained" from "not declared at all", which is why `hasRelationType`
 * exists: a caller classifying must ask whether the relation is known before it
 * may read an empty constraint list as "any endpoints are acceptable". Types are
 * always expressed in the catalog's canonical reading order, so a consumer
 * handling an `inverse` relation swaps its endpoints before asking.
 */

import { normalizeCatalogName } from "./names.js";
import type { EntityTypeDef, RelationConstraint, RelationTypeDef, TypeAlias, TypeCatalog } from "./types.js";

/** Anything declared in a catalog under a name. */
interface NamedDefinition {
  readonly name: string;
}

/**
 * Finds the definition whose canonical name matches a comparison key.
 *
 * @param defs - The declared definitions of one namespace.
 * @param key - A normalized label.
 * @returns The matching definition, or `undefined`.
 */
function findByName<T extends NamedDefinition>(defs: readonly T[], key: string): T | undefined {
  return defs.find((def) => normalizeCatalogName(def.name) === key);
}

/**
 * Resolves a label by exact canonical name first, then by alias.
 *
 * @param defs - The declared definitions of one namespace.
 * @param aliases - The aliases bound to those definitions by the parser.
 * @param value - The label as proposed by an extractor or a caller.
 * @returns The canonical definition, or `undefined` when nothing resolves.
 */
function resolveLabel<T extends NamedDefinition>(
  defs: readonly T[],
  aliases: readonly TypeAlias[],
  value: string,
): T | undefined {
  const key = normalizeCatalogName(value);
  const exact = findByName(defs, key);
  if (exact !== undefined) {
    return exact;
  }
  const alias = aliases.find((entry) => normalizeCatalogName(entry.alias) === key);
  return alias === undefined ? undefined : findByName(defs, normalizeCatalogName(alias.canonical));
}

/**
 * Resolves a proposed entity type label to its canonical definition.
 *
 * @param catalog - The Stack's catalog.
 * @param value - The label to resolve, by canonical name or alias.
 * @returns The canonical entity type, or `undefined` when the label resolves to nothing.
 */
export function resolveEntityType(catalog: TypeCatalog, value: string): EntityTypeDef | undefined {
  return resolveLabel(catalog.entityTypes, catalog.entityAliases, value);
}

/**
 * Resolves a proposed relation type label to its canonical definition.
 *
 * @param catalog - The Stack's catalog.
 * @param value - The predicate to resolve, by canonical name or alias.
 * @returns The canonical relation type, or `undefined` when the label resolves to nothing.
 */
export function resolveRelationType(
  catalog: TypeCatalog,
  value: string,
): RelationTypeDef | undefined {
  return resolveLabel(catalog.relationTypes, catalog.relationAliases, value);
}

/**
 * Whether a label names a declared entity type, canonically or by alias.
 *
 * @param catalog - The Stack's catalog.
 * @param value - The label to test.
 * @returns True when the label resolves to a canonical entity type.
 */
export function hasEntityType(catalog: TypeCatalog, value: string): boolean {
  return resolveEntityType(catalog, value) !== undefined;
}

/**
 * Whether a label names a declared relation type, canonically or by alias.
 *
 * @param catalog - The Stack's catalog.
 * @param value - The predicate to test.
 * @returns True when the label resolves to a canonical relation type.
 */
export function hasRelationType(catalog: TypeCatalog, value: string): boolean {
  return resolveRelationType(catalog, value) !== undefined;
}

/**
 * The type combinations the catalog permits for one relation.
 *
 * @param catalog - The Stack's catalog.
 * @param relationType - A canonical relation name or an alias of one.
 * @returns The declared triples, empty when the relation declares none or is unknown.
 */
export function relationConstraintsFor(
  catalog: TypeCatalog,
  relationType: string,
): readonly RelationConstraint[] {
  const relation = resolveRelationType(catalog, relationType);
  if (relation === undefined) {
    return [];
  }
  const key = normalizeCatalogName(relation.name);
  return catalog.constraints.filter(
    (constraint) => normalizeCatalogName(constraint.relation) === key,
  );
}
