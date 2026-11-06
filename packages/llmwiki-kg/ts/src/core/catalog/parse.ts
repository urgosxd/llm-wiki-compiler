/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/parse.ts
 * @description Turning an untrusted JSON value into a validated, frozen type catalog.
 *
 * ## Why the input is `unknown`
 *
 * The catalog will be stored as `stacks.type_catalog` jsonb, so what reaches this
 * function is parsed JSON: untyped, hand-editable, and occasionally written by a
 * client that got the shape wrong. It becomes the vocabulary every later stage
 * classifies against, which is why a bad value must fail loudly here instead of
 * degrading into "no type matched anything" somewhere downstream — the difference
 * between a broken catalog and a genuinely unclassifiable document has to stay
 * visible.
 *
 * ## What is normalized, and what is refused
 *
 * Names are compared through {@link normalizeCatalogName}, so a constraint or an
 * alias written `role` is bound to the declared `Role` rather than being rejected
 * for spelling. Everything that cannot be normalized into one meaning is refused
 * with a {@link TypeCatalogError} naming the offending field: a duplicate type, an
 * alias that would shadow a type, a constraint naming a type that is not
 * declared, a relation direction outside the enum, and — the case this
 * application cares most about — a declaration of the reserved
 * {@link UNCLASSIFIED_ENTITY_TYPE}, which would let a user type collide with the
 * free-entity convention.
 *
 * ## The result cannot be widened afterwards
 *
 * Ingestion must never add a type, so the returned catalog is deep-frozen, not
 * merely typed readonly. A caller that tries to push a type at runtime gets a
 * `TypeError` instead of a vocabulary that silently grew mid-ingest.
 */

import { isReservedEntityTypeName, normalizeCatalogName } from "./names.js";
import {
  RELATION_DIRECTIONS,
  TypeCatalogError,
  UNCLASSIFIED_ENTITY_TYPE,
  type EntityTypeDef,
  type RelationConstraint,
  type RelationDirection,
  type RelationTypeDef,
  type TypeAlias,
  type TypeCatalog,
} from "./types.js";

/** Which namespace an alias or a constraint endpoint is being resolved in. */
type TypeKind = "entity" | "relation";

/** Declared canonical names, keyed by their normalized form. */
type DeclaredNames = ReadonlyMap<string, string>;

/** One endpoint of a constraint, plus what a failure should call it. */
interface EndpointLookup {
  readonly declared: DeclaredNames;
  readonly kind: TypeKind;
  readonly what: string;
}

/** Narrows an untrusted value to a plain JSON object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Reads one array-valued field, refusing a missing required one. */
function readEntryList(
  source: Record<string, unknown>,
  field: string,
  mustBeNonEmpty: boolean,
): readonly unknown[] {
  const raw = source[field];
  if (raw === undefined && !mustBeNonEmpty) {
    return [];
  }
  if (!Array.isArray(raw) || (mustBeNonEmpty && raw.length === 0)) {
    const shape = mustBeNonEmpty ? "a non-empty array" : "an array";
    throw new TypeCatalogError(`type catalog "${field}" must be ${shape}`);
  }
  return raw;
}

/** Reads a required non-empty string field of one definition. */
function readRequiredText(
  record: Record<string, unknown>,
  field: string,
  what: string,
): string {
  const raw = record[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new TypeCatalogError(`${what} must have a non-empty string "${field}"`);
  }
  return raw.trim();
}

/** Reads the catalog version, which every stored decision is traceable to. */
function readVersion(source: Record<string, unknown>): string {
  const raw = source["version"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new TypeCatalogError('type catalog "version" must be a non-empty string');
  }
  return raw.trim();
}

/** Reads an optional example list, where absent means none were declared. */
function readExamples(record: Record<string, unknown>, what: string): readonly string[] {
  const raw = record["examples"];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new TypeCatalogError(`${what} field "examples" must be an array`);
  }
  return raw.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new TypeCatalogError(`${what} field "examples" contains a non-string or empty example`);
    }
    return entry.trim();
  });
}

/** Reads an optional relation direction, defaulting to the active voice. */
function readDirection(record: Record<string, unknown>, what: string): RelationDirection {
  const raw = record["direction"];
  if (raw === undefined) {
    return "forward";
  }
  const known = RELATION_DIRECTIONS.find((direction) => direction === raw);
  if (known === undefined) {
    throw new TypeCatalogError(
      `${what} "direction" must be ${RELATION_DIRECTIONS.map((name) => `"${name}"`).join(" or ")}`,
    );
  }
  return known;
}

/** Refuses two entries of one field whose names differ only in spelling. */
function assertUniqueNames(names: readonly string[], field: string): void {
  const normalized = names.map(normalizeCatalogName);
  const duplicate = normalized.find((name, index) => normalized.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new TypeCatalogError(
      `type catalog field "${field}" declares "${duplicate}" more than once`,
    );
  }
}

/** Indexes declared canonical names by their normalized form. */
function declaredNames(defs: readonly { readonly name: string }[]): DeclaredNames {
  return new Map(defs.map((def) => [normalizeCatalogName(def.name), def.name]));
}

/** Reads the entity type definitions, refusing duplicates and the reserved name. */
function readEntityTypes(source: Record<string, unknown>): readonly EntityTypeDef[] {
  const entries = readEntryList(source, "entityTypes", true);
  const defs = entries.map((entry, index) => {
    const what = `type catalog entity type #${index + 1}`;
    const record = asRecord(entry);
    if (record === undefined) {
      throw new TypeCatalogError(`${what} must be a JSON object`);
    }
    return {
      name: readRequiredText(record, "name", what),
      definition: readRequiredText(record, "definition", what),
      examples: readExamples(record, what),
    };
  });
  assertUniqueNames(
    defs.map((def) => def.name),
    "entityTypes",
  );
  if (defs.some((def) => isReservedEntityTypeName(def.name))) {
    throw new TypeCatalogError(
      `type catalog declares the reserved entity type "${UNCLASSIFIED_ENTITY_TYPE}"`,
    );
  }
  return defs;
}

/** Reads the relation type definitions, refusing duplicates and bad directions. */
function readRelationTypes(source: Record<string, unknown>): readonly RelationTypeDef[] {
  const entries = readEntryList(source, "relationTypes", true);
  const defs = entries.map((entry, index) => {
    const what = `type catalog relation type #${index + 1}`;
    const record = asRecord(entry);
    if (record === undefined) {
      throw new TypeCatalogError(`${what} must be a JSON object`);
    }
    return {
      name: readRequiredText(record, "name", what),
      definition: readRequiredText(record, "definition", what),
      direction: readDirection(record, what),
      examples: readExamples(record, what),
    };
  });
  assertUniqueNames(
    defs.map((def) => def.name),
    "relationTypes",
  );
  return defs;
}

/** Reads one alias list as written, before canonical names are bound to it. */
function readAliases(source: Record<string, unknown>, field: string): readonly TypeAlias[] {
  const entries = readEntryList(source, field, false);
  const aliases = entries.map((entry, index) => {
    const record = asRecord(entry);
    const alias = record?.["alias"];
    const canonical = record?.["canonical"];
    const complete = (value: unknown): value is string =>
      typeof value === "string" && value.trim() !== "";
    if (!complete(alias) || !complete(canonical)) {
      throw new TypeCatalogError(
        `type catalog alias #${index + 1} must have non-empty string "alias" and "canonical"`,
      );
    }
    return { alias: alias.trim(), canonical: canonical.trim() };
  });
  assertUniqueNames(
    aliases.map((entry) => entry.alias),
    field,
  );
  return aliases;
}

/** Binds one alias list to the canonical spellings it names. */
function bindAliases(
  aliases: readonly TypeAlias[],
  declared: DeclaredNames,
  kind: TypeKind,
): readonly TypeAlias[] {
  return aliases.map((entry) => {
    if (kind === "entity" && isReservedEntityTypeName(entry.alias)) {
      throw new TypeCatalogError(
        `type catalog alias "${entry.alias}" collides with the reserved entity type "${UNCLASSIFIED_ENTITY_TYPE}"`,
      );
    }
    if (kind === "entity" && isReservedEntityTypeName(entry.canonical)) {
      throw new TypeCatalogError(
        `type catalog alias "${entry.alias}" resolves to the reserved entity type "${UNCLASSIFIED_ENTITY_TYPE}"`,
      );
    }
    const shadowed = declared.get(normalizeCatalogName(entry.alias));
    if (shadowed !== undefined) {
      throw new TypeCatalogError(
        `type catalog alias "${entry.alias}" collides with the ${kind} type "${shadowed}" it would shadow`,
      );
    }
    const canonical = declared.get(normalizeCatalogName(entry.canonical));
    if (canonical === undefined) {
      throw new TypeCatalogError(
        `type catalog alias "${entry.alias}" names "${entry.canonical}", which is not declared in "${kind}Types"`,
      );
    }
    return { alias: entry.alias, canonical };
  });
}

/** Resolves one constraint endpoint to the canonical spelling the catalog declares. */
function declaredEndpoint(value: string, lookup: EndpointLookup): string {
  const canonical = lookup.declared.get(normalizeCatalogName(value));
  if (canonical === undefined) {
    throw new TypeCatalogError(
      `${lookup.what} names ${lookup.kind} type "${value}", which is not declared in "${lookup.kind}Types"`,
    );
  }
  return canonical;
}

/** The comparison key of one permitted triple. */
function constraintKey(constraint: RelationConstraint): string {
  return [constraint.from, constraint.relation, constraint.to]
    .map(normalizeCatalogName)
    .join("->");
}

/** Refuses the same permitted triple declared twice. */
function assertUniqueConstraints(constraints: readonly RelationConstraint[]): void {
  const keys = constraints.map(constraintKey);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) {
    throw new TypeCatalogError(
      `type catalog field "constraints" declares the triple "${duplicate}" more than once`,
    );
  }
}

/** Reads the permitted type combinations, refusing undeclared participants. */
function readConstraints(
  source: Record<string, unknown>,
  entityDeclared: DeclaredNames,
  relationDeclared: DeclaredNames,
): readonly RelationConstraint[] {
  const entries = readEntryList(source, "constraints", false);
  const constraints = entries.map((entry, index) => {
    const what = `type catalog constraint #${index + 1}`;
    const record = asRecord(entry);
    if (record === undefined) {
      throw new TypeCatalogError(`${what} must be a JSON object`);
    }
    const entities: EndpointLookup = { declared: entityDeclared, kind: "entity", what };
    const relations: EndpointLookup = { declared: relationDeclared, kind: "relation", what };
    return {
      from: declaredEndpoint(readRequiredText(record, "from", what), entities),
      relation: declaredEndpoint(readRequiredText(record, "relation", what), relations),
      to: declaredEndpoint(readRequiredText(record, "to", what), entities),
    };
  });
  assertUniqueConstraints(constraints);
  return constraints;
}

/** Freezes every list and object inside one definition list. */
function freezeDefinitions<T extends object>(items: readonly T[]): readonly T[] {
  for (const item of items) {
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) {
        Object.freeze(value);
      }
    }
    Object.freeze(item);
  }
  return Object.freeze(items) as readonly T[];
}

/**
 * Freezes a catalog and everything reachable from it.
 *
 * @param catalog - A freshly built, already valid catalog.
 * @returns The same catalog, immutable at runtime.
 */
function freezeCatalog(catalog: TypeCatalog): TypeCatalog {
  freezeDefinitions(catalog.entityTypes);
  freezeDefinitions(catalog.relationTypes);
  freezeDefinitions(catalog.constraints);
  freezeDefinitions(catalog.entityAliases);
  freezeDefinitions(catalog.relationAliases);
  return Object.freeze(catalog);
}

/**
 * Validates an untrusted catalog declaration.
 *
 * Every failure is a {@link TypeCatalogError} naming the offending field, so a
 * stored row or a hand-edited catalog can be corrected without reading this
 * source. Nothing is dropped and nothing is defaulted into meaning: a field that
 * cannot be understood is an error, and the only defaults are the documented
 * ones — absent `examples` means none, absent `direction` means `forward`.
 *
 * @param input - Parsed JSON, of unknown shape.
 * @returns The validated catalog, frozen and with canonical spellings bound.
 * @throws {TypeCatalogError} When a field is missing, empty, duplicated,
 *   references an undeclared type, declares an unknown direction, or declares
 *   the reserved unclassified entity type.
 */
export function parseTypeCatalog(input: unknown): TypeCatalog {
  const source = asRecord(input);
  if (source === undefined) {
    throw new TypeCatalogError("type catalog must be a JSON object");
  }
  const entityTypes = readEntityTypes(source);
  const relationTypes = readRelationTypes(source);
  const entityDeclared = declaredNames(entityTypes);
  const relationDeclared = declaredNames(relationTypes);
  return freezeCatalog({
    version: readVersion(source),
    entityTypes,
    relationTypes,
    constraints: readConstraints(source, entityDeclared, relationDeclared),
    entityAliases: bindAliases(readAliases(source, "entityAliases"), entityDeclared, "entity"),
    relationAliases: bindAliases(
      readAliases(source, "relationAliases"),
      relationDeclared,
      "relation",
    ),
  });
}
