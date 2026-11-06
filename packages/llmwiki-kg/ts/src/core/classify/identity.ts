/**
 * @file packages/llmwiki-kg/ts/src/core/classify/identity.ts
 * @description The identity key of a relation decision, and why it is the predicate.
 *
 * ## The key: `lower(btrim(predicate))`
 *
 * A relation's identity inside a Stack is its original verb, stored the way the
 * landed migration's `kg_relationship_identity_key` trigger stores it: the
 * predicate, trimmed and lower-cased. This module derives exactly that form, for
 * the same reason `core/identity/key.ts` derives entity keys exactly as the entity
 * trigger does — a stage that derived a different shape would write one key while
 * the trigger wrote another, and `unique_edge_identity_per_stack` would happily
 * store both as two rows for one fact.
 *
 * Note what is NOT applied here: `normalizeCatalogName`. That helper folds internal
 * whitespace and hyphens, which the trigger does not, so `deja  sin efecto` and
 * `deja sin efecto` keep two keys — matching the database rather than quietly
 * exceeding it. Predicates are short verb phrases, and a divergence between stored
 * and derived keys is a much worse failure than two rows that a human can merge.
 *
 * ## Why `(from, Unclassified, to)` is the wrong key (S33)
 *
 * That shape keys a relation by its endpoints plus one reserved placeholder for
 * "no canonical type". It has three defects, in increasing order of severity:
 *
 * 1. **It merges different facts.** `deja sin efecto` and `reemplaza a` between the
 *    same two nodes would collide on one key, so the second one would be written as
 *    an update to the first: one of the two meanings is destroyed (S31).
 * 2. **It destroys reclassification.** The key changes the moment a canonical type
 *    is assigned, so "update the existing decision" becomes "insert a second
 *    decision next to the old one" — the free row and the classified row would then
 *    both exist for one assertion.
 * 3. **It invents a canonical type.** `Unclassified` is the reserved label for an
 *    entity with no type (`core/catalog/types.ts`); using it inside a key makes an
 *    absence look like an assigned value, which is exactly the confusion S27
 *    forbids for `Concept`.
 *
 * The predicate has none of those problems: it is written once at extraction, the
 * landed migration declares it immutable, and it does not move when a catalog
 * version changes. Two different free predicates therefore stay two decisions, and
 * a later classification of the same predicate lands on the same key.
 *
 * ## What the key does not promise
 *
 * Endpoints are absent from the key because the database already scopes it:
 * `unique_edge_identity_per_stack` is `(stack_id, from_entity_id, to_entity_id,
 * identity_key)`. And because `unique_edge_per_stack` — `(stack_id,
 * from_entity_id, to_entity_id, type)` — was KEPT by the migration (the existing
 * upserts infer their conflict target from it), two rows with identical `type` text
 * on identical endpoints cannot coexist. This module promises what the predicate
 * key can deliver: distinct PREDICATES stay distinct. It makes no promise that two
 * relations converging on the same canonical type, written under the same `type`
 * text, will occupy two rows; T13 owns that convergence, not this key.
 */

import { ClassificationInputError } from "./types.js";

/**
 * Derives the stored identity key of a relation decision.
 *
 * @param predicate - The original predicate, verbatim as the extractor read it.
 * @returns `lower(btrim(predicate))`, the form the landed trigger would write.
 * @throws {ClassificationInputError} When the predicate is blank, because an empty
 *   key would give one relation an identity that says nothing about it.
 */
export function relationIdentityKey(predicate: string): string {
  const key = predicate.trim().toLowerCase();
  if (key === "") {
    throw new ClassificationInputError(
      "a relation decision cannot be keyed by a blank predicate: the original verb is its identity",
    );
  }
  return key;
}
