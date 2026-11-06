/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/stack-catalog.ts
 * @description Which catalog one Stack's ingestion classifies against, and the
 * version string that records that choice.
 *
 * ## Three sources, one resolution order (S14)
 *
 * A Stack can carry its vocabulary in two places, because the schema grew:
 *
 * 1. `stacks.type_catalog` — the versioned catalog of `types.ts`: entity and
 *    relation types with definitions, examples, aliases and permitted type
 *    combinations. When present it is the answer, in full.
 * 2. `stacks.ontology` — the LEGACY declaration, from before catalogs existed: two
 *    type lists plus `subtypes` and per-relationship `domains` / `ranges`. A Stack
 *    that only has this one is not "unconfigured": the knowledge already in its graph
 *    was admitted against that vocabulary, so classifying it against the shipped
 *    default would mislabel its own types. It is therefore DERIVED into a catalog.
 * 3. The documented default catalog, when neither column says anything usable.
 *
 * The order is fixed and each step is a decision, not a fallback heuristic: a
 * declared catalog is never merged with a derived one, and a derivation is never
 * merged with the default. Mixing vocabularies would make a stored `catalog_version`
 * name a document that never existed.
 *
 * ## What a derivation invents, and what it refuses to invent
 *
 * The legacy declaration names types but never describes them, while a catalog
 * requires a definition for every type. Rather than refuse to classify — which would
 * be the same mis-attribution in a different shape — the derivation writes a MINIMAL
 * documented definition that says exactly what is known (the type is declared by the
 * Stack's ontology) and nothing else. {@link UNDEFINED_TYPE_MARKER} is that sentence's
 * fixed prefix, so anything downstream can tell a declared definition from a generated
 * one without guessing.
 *
 * Nothing else is invented: no examples, no aliases, and no constraint for a
 * relationship whose `domains` or `ranges` list is empty — empty means "any declared
 * type", which a catalog cannot express, and enumerating it would turn a permission
 * into a rule.
 *
 * ## Ingestion never writes a catalog (S16)
 *
 * Every function here is read-only. The derived catalog exists in memory for the
 * duration of the run; the Stack's columns are untouched, and there is no code path
 * that could add a type to a stored catalog during ingestion.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { Database } from "../../db.js";
import { bindCallerStack } from "../stack_resolver.js";
import { validateOntology, type Ontology } from "../ontology.js";
import { defaultTypeCatalog } from "./default_catalog.js";
import { parseTypeCatalog } from "./parse.js";
import type { RelationConstraint, TypeCatalog } from "./types.js";

/**
 * Fixed opening of every definition this module generates.
 *
 * Presence of this prefix in a stored catalog's definition means "the Stack declared
 * the type but never described it", which is a different fact from "the Stack
 * described it and the description is short".
 */
export const UNDEFINED_TYPE_MARKER = "Declared by the Stack ontology with no definition";

/** Prefix of every version string a derivation produces. */
const DERIVED_VERSION_PREFIX = "ontology-derived:";

/** Which column the vocabulary came from. */
export type StackCatalogSource = "type_catalog" | "ontology" | "default";

/** One Stack's resolved vocabulary, plus what identifies it. */
export interface StackCatalogResolution {
  /** The validated, frozen catalog stages 4-6 are asked against. */
  readonly catalog: TypeCatalog;
  /** The version recorded in every classified row's `catalog_version`. */
  readonly version: string;
  /** Where the vocabulary came from, so an operator can tell why a type matched. */
  readonly source: StackCatalogSource;
}

/** One entry of the derived catalog declaration, before validation. */
interface EntityDeclaration {
  readonly name: string;
  readonly definition: string;
  readonly examples: readonly string[];
}

/** One relation entry of the derived catalog declaration. */
interface RelationDeclaration extends EntityDeclaration {
  readonly direction: "forward";
}

/** The declaration a derivation produces; fed straight into the one parser. */
interface DerivedDeclaration {
  readonly version: string;
  readonly entityTypes: readonly EntityDeclaration[];
  readonly relationTypes: readonly RelationDeclaration[];
  readonly constraints: readonly RelationConstraint[];
}

/** The definition sentence generated for a type nothing described. */
function generatedDefinition(kind: "entity" | "relation", name: string): string {
  return `${UNDEFINED_TYPE_MARKER}: "${name}" is a ${kind} type this Stack accepts. The ontology names the type only, so no meaning beyond that name is asserted here.`;
}

/**
 * Every permitted combination the declaration states, expanded to catalog constraints.
 *
 * The legacy shape constrains one relationship with a domain list and a range list,
 * i.e. it permits the cross product. A relationship missing either list is
 * unconstrained on that side, which a catalog cannot say, so it contributes nothing.
 *
 * @param ontology - The validated declaration.
 * @returns The constraints, in declaration order.
 */
function derivedConstraints(ontology: Ontology): readonly RelationConstraint[] {
  const constraints: RelationConstraint[] = [];
  for (const relationship of ontology.constraintsOf.values()) {
    if (relationship.domains.length === 0 || relationship.ranges.length === 0) continue;
    for (const from of relationship.domains) {
      for (const to of relationship.ranges) {
        constraints.push({ from, relation: relationship.type, to });
      }
    }
  }
  return constraints;
}

/**
 * The version string of one derivation: a digest of the vocabulary itself.
 *
 * Content-derived rather than declared, because the legacy column has nowhere to
 * carry a version. Two runs over the same declaration therefore record the same
 * string, and a changed declaration records a different one — which is precisely
 * what a reclassification pass needs to find the decisions a vocabulary change
 * invalidated (S43).
 *
 * @param declaration - The derived declaration, minus its version.
 * @returns `ontology-derived:<12 hex chars>`.
 */
function derivedVersion(declaration: Omit<DerivedDeclaration, "version">): string {
  const canonical = JSON.stringify({
    entities: declaration.entityTypes.map((type) => type.name),
    relations: declaration.relationTypes.map((type) => type.name),
    constraints: declaration.constraints.map((entry) => [entry.from, entry.relation, entry.to]),
  });
  return `${DERIVED_VERSION_PREFIX}${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

/**
 * Derives a catalog from a legacy `stacks.ontology` declaration.
 *
 * The declaration is validated by `validateOntology` first, so a stored value that
 * names no entity type or no relation type raises instead of yielding an empty
 * vocabulary — `readTypeList` refuses an absent or empty list because "admits
 * nothing" is a declaration mistake, not a configuration.
 *
 * @param stored - The raw column value, untrusted.
 * @returns The validated, frozen catalog.
 * @throws {OntologyError} When the stored declaration is present but invalid.
 * @throws {TypeCatalogError} When the declaration names the reserved unclassified type.
 */
export function catalogFromOntology(stored: unknown): TypeCatalog {
  const ontology = validateOntology(stored);
  const declaration: Omit<DerivedDeclaration, "version"> = {
    entityTypes: ontology.entityTypes.map((name) => ({
      name,
      definition: generatedDefinition("entity", name),
      examples: [],
    })),
    relationTypes: ontology.relationshipTypes.map((name) => ({
      name,
      definition: generatedDefinition("relation", name),
      direction: "forward",
      examples: [],
    })),
    constraints: derivedConstraints(ontology),
  };
  // Parsed through the ONE catalog parser, so a derived catalog satisfies every
  // invariant a stored one does (uniqueness, reserved name, declared endpoints) and
  // arrives frozen. A second builder here would be a second set of rules.
  return parseTypeCatalog({ ...declaration, version: derivedVersion(declaration) });
}

/**
 * Resolves which catalog one Stack classifies against (S14).
 *
 * A stored `type_catalog` that does not parse RAISES rather than falling back: it is
 * the vocabulary every later classification is measured against, so substituting
 * another one would attribute decisions to a catalog nobody configured. The same
 * applies to a malformed legacy declaration — falling through to the default would
 * silently mislabel the Stack's own types.
 *
 * @param tx - Transaction carrying the read.
 * @param stackId - The Stack whose vocabulary is read.
 * @returns The catalog, its version, and which column it came from.
 * @throws {Error} When the Stack does not exist or no longer matches this tenant.
 * @throws {TypeCatalogError} When a stored catalog is present but invalid.
 * @throws {OntologyError} When a stored ontology is present but invalid.
 */
export async function loadStackCatalog(
  tx: Database,
  stackId: string,
): Promise<StackCatalogResolution> {
  await bindCallerStack(tx, stackId, null);
  const rows = await tx.execute<{ type_catalog: unknown; ontology: unknown }>(sql`
    select type_catalog, ontology from stacks where id = ${stackId}
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`stack ${stackId} not found while resolving its type catalog`);
  }
  if (row.type_catalog !== null && row.type_catalog !== undefined) {
    const catalog = parseTypeCatalog(row.type_catalog);
    return { catalog, version: catalog.version, source: "type_catalog" };
  }
  if (row.ontology !== null && row.ontology !== undefined) {
    const derived = catalogFromOntology(row.ontology);
    return { catalog: derived, version: derived.version, source: "ontology" };
  }
  const fallback = defaultTypeCatalog();
  return { catalog: fallback, version: fallback.version, source: "default" };
}

/**
 * The default catalog as a resolution, for a caller with no Stack context.
 *
 * @returns The shipped catalog, its version, and the source it names.
 */
export function defaultCatalogResolution(): StackCatalogResolution {
  const catalog = defaultTypeCatalog();
  return { catalog, version: catalog.version, source: "default" };
}
