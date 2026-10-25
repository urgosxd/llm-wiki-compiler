/**
 * @file packages/llmwiki-kg/ts/src/core/stack_ontology.ts
 * @description Reading and storing a Stack's ontology without changing the HTTP contract.
 *
 * ## Why this module exists instead of a DTO field
 *
 * The obvious place for a Stack's ontology is `POST /stacks`. It cannot go there.
 * `oracle/contracts/openapi.json` — the frozen record of the Python server this
 * package ports — has no `ontology` on `StackCreate`, `StackUpdate` or
 * `StackResponse`, and `routes/stacks.ts` repeats Python's `_STACK_COLUMNS`
 * verbatim because response key order is contractual. Adding the field would be an
 * extension of the reference contract, not a faithful port, and the oracle is gone:
 * there is no live Python server left to re-diff against, so a divergence recorded
 * now could not be measured later.
 *
 * So the column is populated out of band — by a reviewed declaration written
 * directly to `stacks.ontology` — and the API keeps its exact shape.
 *
 * ## Null is a behaviour, not an absence
 *
 * This is the rule the whole feature rests on. `readStackOntology(null)` returns
 * `undefined`, and `undefined` is what makes `extractGraphFromChunks` take its
 * original two-argument form: advertise the default type hints and accept whatever
 * the model emits — the oracle's `strict=False` behaviour.
 *
 * Coercing null to `{}` would be a silent behaviour change. `validateOntology`
 * rejects an empty declaration, so `{}` is not "no constraint", it is an error; and
 * a Stack that somehow carried an empty-but-valid declaration would drop every
 * triplet of every document. Every existing Stack is null, so this is the difference
 * between a feature and an outage.
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
