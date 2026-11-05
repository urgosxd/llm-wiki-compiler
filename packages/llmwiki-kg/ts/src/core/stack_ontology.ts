/**
 * @file packages/llmwiki-kg/ts/src/core/stack_ontology.ts
 * @description Reading, validating and normalising a Stack's stored ontology declaration.
 *
 * ## Where the declaration is written
 *
 * A Stack's ontology lives in the `stacks.ontology` jsonb column, and the KG REST
 * API is its only writer: `POST /stacks` inserts the column and
 * `PATCH /stacks/:stackId` updates or clears it, both from the `ontology` field of
 * the request body (`dto.ts` — `StackCreate`, `StackUpdate`, `StackResponse`).
 * Absence of the field on create and `null` on update both mean "no declaration",
 * which is stored as SQL NULL. No CLI command writes that column, and nothing seeds
 * it: a Stack created without a declaration simply keeps the column empty.
 *
 * ## Where the declaration is read
 *
 * Ingest re-reads the column on every run rather than caching it. The `kg`
 * dimension's `resolveOntology` calls `loadStoredOntology` (a raw
 * `select ontology from stacks where id = ...`), hands the raw value to
 * `readStackOntology` below, and applies `defaultOntology()` when this module
 * answers `undefined`. That split is deliberate: the reader reports what is stored,
 * and the boundary that knows a Stack exists decides what a missing declaration
 * means.
 *
 * ## What this module does, and what it does not
 *
 * The job here is the conversion between the column and an `Ontology`:
 * `readStackOntology` validates a stored document on read, and `toStoredOntology`
 * validates and normalises a declaration on the way in. Persistence is emphatically
 * not part of it — the insert, the update, and the jsonb cast a driver requires all
 * live in the routes — so this file carries no SQL and no knowledge of the HTTP
 * surface. Those two exports are the whole of it.
 *
 * ## Null is a behaviour, not an absence
 *
 * `readStackOntology(null)` returns `undefined`, which is the reader's honest
 * answer to "what is stored" rather than a decision about extraction. Coercing null
 * to `{}` would be a silent behaviour change: `validateOntology` rejects an empty
 * declaration, so `{}` is an error and not "no constraint", and a declaration that
 * validated while listing nothing would drop every triplet of every document. The
 * `undefined` -> default decision belongs to the caller, and both shipped ingest
 * paths make it (`resolveOntology` in the `kg` dimension, `ontologyArgument` in the
 * ingest pipeline).
 *
 * `undefined` remains a real branch of `extractGraphFromChunks`, which keeps its
 * original two-argument form for a caller that asks for no ontology at all: it
 * advertises the unconstrained type field and accepts whatever the model emits —
 * the oracle's `strict=False` behaviour.
 */

import { validateOntology, type Ontology } from "./ontology.js";

/**
 * The JSON document stored in `stacks.ontology`.
 *
 * Deliberately a plain object with normalised names rather than the `Ontology`
 * type, because `Ontology` carries a derived `parentsOf` index that must not be
 * persisted: it is a cache over `subtypes`, and storing it would let a stale copy
 * outlive an edit to the list it summarises.
 */
export interface StoredOntology {
  readonly entityTypes: readonly string[];
  readonly relationshipTypes: readonly string[];
  readonly subtypes: readonly { readonly child: string; readonly parent: string }[];
  /**
   * Pair constraints, or an empty list when none were declared.
   *
   * Always present so a caller reading the column does not have to distinguish
   * "no constraints" from "this field was written before constraints existed".
   * `validateOntology` treats a missing `relationships` key the same as an empty
   * one, so old rows still load — the explicit list only makes the stored shape
   * uniform for new writes.
   */
  readonly relationships: readonly {
    readonly type: string;
    readonly domains: readonly string[];
    readonly ranges: readonly string[];
  }[];
}

/**
 * Reads the `stacks.ontology` column into a usable ontology.
 *
 * @param stored - The raw column value: null, undefined, or a stored declaration.
 * @returns `undefined` when unset — meaning the oracle behaves as it always has —
 *   or the validated ontology when a declaration is present.
 * @throws {OntologyError} When a declaration is present but malformed. Failing
 *   loudly beats silently admitting everything the model emits, which is what a
 *   swallowed validation error would amount to.
 */
export function readStackOntology(stored: unknown): Ontology | undefined {
  if (stored === null || stored === undefined) return undefined;
  return validateOntology(stored);
}

/**
 * Builds the storable form of a declaration.
 *
 * Validates first, so a declaration that `readStackOntology` would later reject
 * cannot be written in the first place. That keeps the column's invariant
 * "whatever is stored is loadable", which is what lets the ingest path treat a
 * validation failure as an operational fault rather than an expected state.
 *
 * @param declaration - Entity types, relationship types, and optional subtype edges.
 * @returns A JSON-serialisable document with normalised type names.
 * @throws {OntologyError} When the declaration is not valid.
 */
export function toStoredOntology(declaration: unknown): StoredOntology {
  const ontology = validateOntology(declaration);
  return {
    entityTypes: ontology.entityTypes,
    relationshipTypes: ontology.relationshipTypes,
    subtypes: ontology.subtypes,
    relationships: [...ontology.constraintsOf.values()].map((constraint) => ({
      type: constraint.type,
      domains: constraint.domains,
      ranges: constraint.ranges,
    })),
  };
}
